//! Rendered slides as GPU textures: a bounded recent-page canvas cache and thumbnails. Immutable
//! document identities and render parameters keep reused pictures in step with their content.
//!
//! The canvas texture covers the slide plus whatever of the slide's drawing reaches off it and is
//! in view (PowerPoint's Normal view shows off-slide objects; thumbnails clip to the slide).

use std::collections::HashMap;
use std::sync::Arc;

use egui::{ColorImage, TextureFilter, TextureHandle, TextureOptions, TextureWrapMode};
use office_presentation_geom::Rect;
use office_presentation_model::{Master, Presentation, ShapeId, Slide};
use office_presentation_render::{Image, Region, RenderOpts};

#[derive(Clone, PartialEq)]
struct Key {
    index: usize,
    slide: usize,
    master: usize,
    size: (u32, u32),
    edit: bool,
    extra: u64,
    grayscale: bool,
    animation: u64,
    /// The pasteboard region the slide's drawing calls for (canvas only).
    want: Region,
    editing_text: Option<ShapeId>,
}

impl Key {
    fn same_content(&self, other: &Self) -> bool {
        self.index == other.index
            && self.slide == other.slide
            && self.master == other.master
            && self.edit == other.edit
            && self.extra == other.extra
            && self.grayscale == other.grayscale
            && self.animation == other.animation
            && self.editing_text == other.editing_text
    }

    fn same_picture(&self, other: &Self) -> bool {
        self.same_content(other) && self.size == other.size
    }
}

struct Entry {
    key: Key,
    tex: TextureHandle,
    /// The region the texture covers (at least `key.want`).
    region: Region,
    // Keep the Arcs alive so their addresses can't be reused while cached.
    _slide: Arc<Slide>,
    _master: Option<Arc<Master>>,
    stamp: u64,
}

struct CanvasEntry {
    entry: Entry,
    estimate: Rect,
    drawn: Rect,
    bytes: u64,
}

const CANVAS_TEXTURE_LIMIT: usize = 4;
const CANVAS_BYTE_LIMIT: u64 = 64 * 1024 * 1024;
const CANVAS_SIZE_LIMIT: usize = 2;
const RESIZE_SETTLE_SECONDS: f64 = 0.1;

struct PendingResize {
    key: Key,
    changed_at: f64,
}

#[derive(Default)]
pub struct Textures {
    /// Least recently used first. At most four textures / 64 MiB of RGBA pixels; an active texture
    /// larger than that budget is retained alone to preserve device-pixel clarity. In that case
    /// the existing GPU maximum texture dimensions are the bound, and no other page is retained.
    /// A static page may retain two exact sizes, so toggling a fitted editor between its normal
    /// and expanded workspace does not repeatedly rasterize the same content at the same sizes.
    canvas: Vec<CanvasEntry>,
    /// Keep the immutable document alive: its address cannot be reused under a cached picture.
    /// A content, media, theme, ordering or page-size edit changes this Arc and drops old pages.
    canvas_document: Option<Arc<Presentation>>,
    resize: Option<PendingResize>,
    font_faces: usize,
    /// Canvas renders so far (tests, performance checks).
    pub canvas_renders: u64,
    thumbs: HashMap<usize, Entry>,
    /// SmartArt gallery pictures by layout, style and colours (and, for hover previews, the
    /// outline's hash).
    smartart: HashMap<String, TextureHandle>,
    clock: u64,
    pub last_render_ms: f64,
}

impl Textures {
    /// SmartArt gallery pictures cached so far (tests).
    pub fn smartart_cached(&self) -> usize {
        self.smartart.len()
    }

    /// A SmartArt layout drawn small for a gallery (`nodes` for a preview of the selected
    /// graphic's own outline), cached; drawn with the active presentation's theme.
    pub fn smartart(
        &mut self,
        ctx: &egui::Context,
        p: &office_presentation_model::Presentation,
        slide: usize,
        kind: &str,
        style: &str,
        colors: &str,
        nodes: Option<&[office_presentation_model::DiagramNode]>,
        width_px: u32,
    ) -> Option<TextureHandle> {
        let mut key = format!("{kind}|{style}|{colors}|{width_px}");
        if let Some(n) = nodes {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            for x in n {
                (x.text.as_str(), x.level).hash(&mut h);
            }
            key.push_str(&format!("|{:x}", h.finish()));
        }
        if let Some(t) = self.smartart.get(&key) {
            return Some(t.clone());
        }
        let mut s = p.slides.get(slide).or_else(|| p.slides.first())?.as_ref().clone();
        let g = office_presentation_engine::cmd::smartart::preview(kind, style, colors, nodes);
        let id = g.id;
        s.shapes = vec![g];
        let img = office_presentation_render::render_shape(p, &s, id, width_px as f64 / 336.0)?;
        let tex = upload(ctx, format!("smartart-{key}"), to_color_image(&img, false));
        if self.smartart.len() > 300 {
            self.smartart.clear();
        }
        self.smartart.insert(key, tex.clone());
        Some(tex)
    }
}

/// Snap `rect` onto the physical pixel grid.
///
/// The editor draws the slide as a texture of device pixels. A rect that starts or ends
/// between pixels is sampled with a linear filter, so every glyph edge is a blend of two
/// texels and small text looks soft. On a Retina display that offset is half a point, which
/// is the whole edge of an editing-size glyph. The slide show draws much larger glyphs, so
/// the same blend is not visible there (#184).
pub fn device_pixel_rect(rect: egui::Rect, ppp: f32) -> egui::Rect {
    if !ppp.is_finite() || ppp <= 0.0 || !rect.is_finite() {
        return rect;
    }
    let snap = |v: f32| {
        let p = v * ppp;
        if p.is_finite() { p.round() / ppp } else { v }
    };
    let min = egui::pos2(snap(rect.min.x), snap(rect.min.y));
    let step = 1.0 / ppp;
    let max = egui::pos2(snap(rect.max.x).max(min.x + step), snap(rect.max.y).max(min.y + step));
    egui::Rect::from_min_max(min, max)
}

/// Editor slide textures. Nearest magnification keeps a texel that is stretched by a
/// fraction of a pixel from blurring the glyph; minification still blends when many texels
/// share a screen pixel.
pub fn editor_texture_options() -> TextureOptions {
    TextureOptions {
        magnification: TextureFilter::Nearest,
        minification: TextureFilter::Linear,
        wrap_mode: TextureWrapMode::ClampToEdge,
        mipmap_mode: None,
    }
}

pub fn to_color_image(img: &Image, grayscale: bool) -> ColorImage {
    let w = img.width as usize;
    let h = img.height as usize;
    let mut px = Vec::with_capacity(w * h);
    for c in img.pixels.as_chunks::<4>().0 {
        let (r, g, b, a) = (c[0], c[1], c[2], c[3]);
        if grayscale {
            let y = ((r as u32 * 77 + g as u32 * 150 + b as u32 * 29) >> 8) as u8;
            px.push(egui::Color32::from_rgba_premultiplied(y, y, y, a));
        } else {
            px.push(egui::Color32::from_rgba_premultiplied(r, g, b, a));
        }
    }
    px.resize(w * h, egui::Color32::TRANSPARENT);
    ColorImage::new([w, h], px)
}

/// The largest texture side the renderer (GPU or software fallback) takes; egui panics on
/// a bigger texture.
pub fn max_side(ctx: &egui::Context) -> u32 {
    ctx.input(|i| i.max_texture_side).clamp(1, u32::MAX as usize) as u32
}

/// `(w, h)` scaled down, keeping its shape, so neither side exceeds `max` (and none is 0).
/// Render sizes go through this so a huge display, DPI or slide shape doesn't render a
/// picture the GPU can't hold.
pub fn fit_size((w, h): (u32, u32), max: u32) -> (u32, u32) {
    let (w, h, max) = (w.max(1), h.max(1), max.max(1));
    let big = w.max(h);
    if big <= max {
        return (w, h);
    }
    let k = max as f64 / big as f64;
    (((w as f64 * k).floor() as u32).clamp(1, max), ((h as f64 * k).floor() as u32).clamp(1, max))
}

/// `img` shrunk by whole-pixel box averaging until both sides fit `max`.
pub fn shrink_to(img: ColorImage, max: u32) -> ColorImage {
    let [w, h] = img.size;
    let max = max.max(1) as usize;
    if w <= max && h <= max {
        return img;
    }
    let f = w.max(h).div_ceil(max);
    let (nw, nh) = (w.div_ceil(f).max(1), h.div_ceil(f).max(1));
    let mut px = Vec::with_capacity(nw * nh);
    for y in 0..nh {
        for x in 0..nw {
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            for sy in y * f..((y + 1) * f).min(h) {
                for sx in x * f..((x + 1) * f).min(w) {
                    if let Some(c) = img.pixels.get(sy * w + sx) {
                        for (a, v) in acc.iter_mut().zip(c.to_array()) {
                            *a += v as u32;
                        }
                        n += 1;
                    }
                }
            }
            let n = n.max(1);
            px.push(egui::Color32::from_rgba_premultiplied((acc[0] / n) as u8, (acc[1] / n) as u8, (acc[2] / n) as u8, (acc[3] / n) as u8));
        }
    }
    ColorImage::new([nw, nh], px)
}

/// Upload a texture, shrunk to the renderer's limit if need be.
pub fn upload(ctx: &egui::Context, name: impl Into<String>, img: ColorImage) -> TextureHandle {
    ctx.load_texture(name, shrink_to(img, max_side(ctx)), TextureOptions::LINEAR)
}

/// Replace a texture's picture, shrunk to the renderer's limit if need be.
pub fn replace(ctx: &egui::Context, tex: &mut TextureHandle, img: ColorImage) {
    tex.set(shrink_to(img, max_side(ctx)), TextureOptions::LINEAR);
}

/// [`upload`] for editor slide pictures, drawn on the device pixel grid with
/// [`editor_texture_options`] (#184).
pub fn upload_editor(ctx: &egui::Context, name: impl Into<String>, img: ColorImage) -> TextureHandle {
    ctx.load_texture(name, shrink_to(img, max_side(ctx)), editor_texture_options())
}

/// [`replace`] for editor slide pictures (#184).
pub fn replace_editor(ctx: &egui::Context, tex: &mut TextureHandle, img: ColorImage) {
    tex.set(shrink_to(img, max_side(ctx)), editor_texture_options());
}

fn master_of(p: &Presentation, slide: &Slide) -> Option<Arc<Master>> {
    p.masters.iter().find(|m| m.layout(slide.layout).is_some()).cloned()
}

/// Mix the preview playhead into the canvas cache key. Zero means "no preview", so a playhead of
/// 0s still misses the at-rest texture (entrances start hidden).
fn anim_key(anim: Option<(&office_presentation_anim::Timeline, f64)>) -> u64 {
    let Some((_, t)) = anim else { return 0 };
    let ms = if t.is_finite() { (t * 1000.0).clamp(0.0, 1.0e12) as u64 } else { 0 };
    ms.wrapping_add(1).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

fn threads() -> u16 {
    if cfg!(target_arch = "wasm32") { 0 } else { std::thread::available_parallelism().map(|n| n.get().min(8) as u16).unwrap_or(0) }
}

impl Textures {
    /// The canvas texture for slide `index`, the slide being `size` pixels, and the region it
    /// covers: the slide, grown over the pasteboard to show what reaches off the slide within
    /// `visible` (the canvas, in pixels from the slide's top-left corner). `extra` changes with the
    /// GIF frames. `editing_text` replaces its placeholder prompt with gray empty list markers.
    #[allow(clippy::too_many_arguments)]
    pub fn slide(
        &mut self,
        ctx: &egui::Context,
        p: &Arc<Presentation>,
        index: usize,
        size: (u32, u32),
        visible: Region,
        edit: bool,
        extra: u64,
        grayscale: bool,
        gif_times: &[(ShapeId, f64)],
        editing_text: Option<ShapeId>,
        anim: Option<(&office_presentation_anim::Timeline, f64)>,
        settle_resize: bool,
    ) -> Option<(TextureHandle, Region)> {
        self.sync_fonts();
        let mut reusable = None;
        if !self.canvas_document.as_ref().is_some_and(|doc| Arc::ptr_eq(doc, p)) {
            // Reuse one allocation during typing/dragging, but never an old document's pixels.
            reusable = self.canvas.pop().map(|e| e.entry.tex);
            self.canvas.clear();
            self.canvas_document = Some(p.clone());
            self.resize = None;
        }
        let slide = p.slides.get(index)?.clone();
        let master = master_of(p, &slide);
        let scale = size.0 as f64 / p.slide_size.width.max(1.0);
        let mut key = Key {
            index,
            slide: Arc::as_ptr(&slide) as usize,
            master: master.as_ref().map(|m| Arc::as_ptr(m) as usize).unwrap_or(0),
            size,
            edit,
            extra,
            grayscale,
            animation: anim_key(anim),
            want: visible,
            editing_text,
        };
        // The actual drawn extent belongs to this page and render state, including overflowing
        // text. Restoring it with the texture avoids false misses on A → B → A.
        let prior = self.canvas.iter().find(|e| e.entry.key.same_picture(&key));
        let (estimate, reach) = match prior {
            Some(e) => (e.estimate, e.estimate.union(e.drawn)),
            None => {
                let estimate = office_presentation_render::slide_extent(p, index);
                (estimate, estimate)
            }
        };
        // The GPU's (or software fallback's) texture limit: a larger canvas texture panics in egui.
        let max_side = max_side(ctx);
        let want = fit_texture(office_presentation_render::pasteboard_region(size, scale, reach, visible), visible, max_side);
        key.want = want;
        if let Some(at) = self.canvas.iter().position(|e| e.entry.key == key) {
            let e = self.canvas.remove(at);
            let result = (e.entry.tex.clone(), e.entry.region);
            self.canvas.push(e);
            self.resize = None;
            self.last_render_ms = 0.0;
            return Some(result);
        }
        // Resize/trackpad bursts should not CPU-rasterize every intermediate fitted size.
        // Reuse only a static, complete slide with identical content. Pasteboard regions,
        // text editing and animated frames always render exactly, so this cannot omit an
        // off-slide object or lag a text/animation change. Once size stops changing, request
        // a final frame at the exact device resolution even if the pointer has stopped.
        if settle_resize && key.extra == 0 && key.animation == 0 && editing_text.is_none() && want == Region::slide(size.0, size.1) {
            // Drawing bounds travel through pixel/point transforms; tolerate only floating
            // point roundoff, never visible overflow from text or effects.
            let page = Rect::new(0.0, 0.0, p.slide_size.width, p.slide_size.height).inflate(1e-6, 1e-6);
            let previous = self.canvas.iter().rev().find(|e| {
                e.entry.key.same_content(&key)
                    && e.entry.key.size != size
                    && e.entry.region == Region::slide(e.entry.key.size.0, e.entry.key.size.1)
                    && page.union(e.estimate).union(e.drawn) == page
            });
            if let Some(previous) = previous {
                let now = ctx.input(|input| input.time);
                if self.resize.as_ref().is_none_or(|pending| pending.key != key) {
                    self.resize = Some(PendingResize { key: key.clone(), changed_at: now });
                }
                let elapsed = self.resize.as_ref().map(|pending| now - pending.changed_at).unwrap_or(RESIZE_SETTLE_SECONDS);
                if elapsed.is_finite() && (0.0..RESIZE_SETTLE_SECONDS).contains(&elapsed) {
                    ctx.request_repaint_after(std::time::Duration::from_secs_f64(RESIZE_SETTLE_SECONDS - elapsed));
                    self.last_render_ms = 0.0;
                    return Some((previous.entry.tex.clone(), want));
                }
            }
        }
        self.resize = None;
        // Content or interaction changes invalidate every size variant of this page. Retain
        // one allocation for reuse, but never show old animation/text-editing pixels.
        let mut at = 0;
        while at < self.canvas.len() {
            let Some(old) = self.canvas.get(at).map(|entry| &entry.entry.key) else { break };
            if old.index == index && !old.same_content(&key) {
                reusable = Some(self.canvas.remove(at).entry.tex);
            } else {
                at += 1;
            }
        }
        // Static pages keep only two sizes within the existing global budget. Scrolling a
        // pasteboard replaces its region at that size; GIF/animation frames retain just one.
        // Continuous zoom therefore cannot consume an unbounded texture per wheel event.
        let variants = self.canvas.iter().filter(|e| e.entry.key.index == index).count();
        let keep_sizes = key.extra == 0 && key.animation == 0;
        if let Some(at) =
            self.canvas.iter().position(|e| e.entry.key.index == index && (e.entry.key.size == size || !keep_sizes || variants >= CANVAS_SIZE_LIMIT))
        {
            reusable = Some(self.canvas.remove(at).entry.tex);
        }
        let t0 = crate::now_ms();
        let render = |region: Region| {
            let state_of = |id: ShapeId| anim.map(|(tl, time)| crate::preview::shape_state_at(tl, id, time)).unwrap_or_default();
            let state: Option<&dyn Fn(ShapeId) -> office_presentation_render::ShapeState> = if anim.is_some() { Some(&state_of) } else { None };
            let opts = RenderOpts {
                scale,
                edit,
                placeholder_prompt: Some(crate::i18n::tr),
                gif_times,
                threads: threads(),
                offset: region.offset(),
                size: Some(region.size()),
                state,
                editing_text,
                ..Default::default()
            };
            office_presentation_render::render_slide_drawn(p, index, &opts)
        };
        let (mut img, drawn) = render(want);
        self.canvas_renders += 1;
        let mut region = want;
        // Text spilling out of its box can reach further than the boxes said. Once drawn, the
        // region it calls for is known (and is next frame's key): render again only if it shows
        // more than this render covered.
        let key = Key {
            want: fit_texture(office_presentation_render::pasteboard_region(size, scale, estimate.union(drawn), visible), visible, max_side),
            ..key
        };
        if !region.contains(&key.want) {
            region = key.want;
            img = render(region).0;
            self.canvas_renders += 1;
        }
        self.last_render_ms = crate::now_ms() - t0;
        let bytes = u64::from(img.width).saturating_mul(u64::from(img.height)).saturating_mul(4);
        while !self.canvas.is_empty() && (self.canvas.len() >= CANVAS_TEXTURE_LIMIT || self.canvas_bytes().saturating_add(bytes) > CANVAS_BYTE_LIMIT)
        {
            let old = self.canvas.remove(0);
            if reusable.is_none() {
                reusable = Some(old.entry.tex);
            }
        }
        let ci = to_color_image(&img, grayscale);
        let tex = match reusable {
            Some(mut tex) => {
                replace_editor(ctx, &mut tex, ci);
                tex
            }
            None => upload_editor(ctx, format!("slide-canvas-{index}"), ci),
        };
        self.canvas.push(CanvasEntry {
            entry: Entry { key, tex: tex.clone(), region, _slide: slide, _master: master, stamp: 0 },
            estimate,
            drawn,
            bytes,
        });
        Some((tex, region))
    }

    pub fn canvas_count(&self) -> usize {
        self.canvas
            .iter()
            .enumerate()
            .filter(|(at, e)| !self.canvas.iter().take(*at).any(|before| before.entry.key.index == e.entry.key.index))
            .count()
    }

    pub fn canvas_variant_count(&self) -> usize {
        self.canvas.len()
    }

    pub fn canvas_resize_pending(&self) -> bool {
        self.resize.is_some()
    }

    pub fn canvas_bytes(&self) -> u64 {
        self.canvas.iter().fold(0u64, |total, e| total.saturating_add(e.bytes))
    }

    fn sync_fonts(&mut self) {
        let faces = office_presentation_fonts::FontDb::global().loaded_face_count();
        if faces != self.font_faces {
            self.invalidate();
            self.font_faces = faces;
        }
    }

    /// Cached thumbnails (bounded; soak tests check it).
    pub fn thumb_count(&self) -> usize {
        self.thumbs.len()
    }

    /// Force the canvas to re-render next time (fonts loaded, theme changed in place…).
    pub fn invalidate(&mut self) {
        self.canvas.clear();
        self.canvas_document = None;
        self.resize = None;
        self.thumbs.clear();
        self.smartart.clear();
    }

    /// A thumbnail texture; renders at most `budget` new thumbnails per frame (returns None when
    /// it is over budget, so the caller draws a placeholder and asks for another frame).
    pub fn thumb(&mut self, ctx: &egui::Context, p: &Presentation, index: usize, width_px: u32, budget: &mut u32) -> Option<TextureHandle> {
        self.sync_fonts();
        let slide = p.slides.get(index)?.clone();
        let master = master_of(p, &slide);
        let h = (width_px as f64 * p.slide_size.height / p.slide_size.width.max(1.0)).round().max(1.0) as u32;
        let key = Key {
            index,
            slide: Arc::as_ptr(&slide) as usize,
            master: master.as_ref().map(|m| Arc::as_ptr(m) as usize).unwrap_or(0),
            size: (width_px, h),
            edit: false,
            extra: 0,
            grayscale: false,
            animation: 0,
            want: Region::slide(width_px, h),
            editing_text: None,
        };
        self.clock += 1;
        let clock = self.clock;
        if let Some(e) = self.thumbs.get_mut(&key.slide)
            && e.key == key
        {
            e.stamp = clock;
            return Some(e.tex.clone());
        }
        if *budget == 0 {
            // Keep showing the stale thumbnail while the new one waits.
            return self.thumbs.get(&key.slide).map(|e| e.tex.clone());
        }
        *budget -= 1;
        let (tw, th) = fit_size((width_px, h), max_side(ctx));
        let scale = tw as f64 / p.slide_size.width.max(1.0);
        let img = office_presentation_render::render_slide(p, index, &RenderOpts { scale, size: Some((tw, th)), threads: 0, ..Default::default() });
        let tex = upload_editor(ctx, format!("thumb-{index}"), to_color_image(&img, false));
        // Drop the old entry for this slide address; entries for slides that no longer exist age out.
        let region = key.want;
        self.thumbs.insert(key.slide, Entry { key, tex: tex.clone(), region, _slide: slide, _master: master, stamp: clock });
        if self.thumbs.len() > 600 {
            let mut v: Vec<(usize, u64)> = self.thumbs.iter().map(|(k, e)| (*k, e.stamp)).collect();
            v.sort_by_key(|x| x.1);
            for (k, _) in v.into_iter().take(200) {
                self.thumbs.remove(&k);
            }
        }
        Some(tex)
    }
}

#[cfg(test)]
mod tests {
    use super::device_pixel_rect;
    use egui::{Rect, pos2, vec2};

    fn on_grid(v: f32, ppp: f32) -> bool {
        let px = v * ppp;
        (px - px.round()).abs() < 1e-3
    }

    #[test]
    fn a_retina_slide_rect_lands_on_device_pixels() {
        let ppp = 2.0;
        let r = Rect::from_min_size(pos2(10.3, 20.25), vec2(100.2, 50.4));
        let s = device_pixel_rect(r, ppp);
        assert!(on_grid(s.min.x, ppp) && on_grid(s.min.y, ppp) && on_grid(s.max.x, ppp) && on_grid(s.max.y, ppp));
        assert!(s.width() > 0.0 && s.height() > 0.0);
        // One texture pixel per device pixel: the snapped size is an integer pixel count.
        let px = ((s.width() * ppp).round() as u32, (s.height() * ppp).round() as u32);
        assert!((s.width() / px.0 as f32 * ppp - 1.0).abs() < 1e-3);
        assert!((s.height() / px.1 as f32 * ppp - 1.0).abs() < 1e-3);
        let aligned = Rect::from_min_max(pos2(1.0, 2.5), pos2(80.0, 40.0));
        assert_eq!(device_pixel_rect(aligned, ppp), aligned);
    }

    #[test]
    fn a_bad_scale_does_not_move_the_rect() {
        let r = Rect::from_min_size(pos2(3.0, 4.0), vec2(10.0, 12.0));
        assert_eq!(device_pixel_rect(r, 0.0), r);
        assert_eq!(device_pixel_rect(r, f32::NAN), r);
    }
}

#[cfg(test)]
mod canvas_cache_tests {
    use super::*;

    fn deck() -> Arc<Presentation> {
        let mut session = office_presentation_engine::Session::with_new();
        for _ in 0..5 {
            session.execute("slide.new", &serde_json::json!({"layout": "blank"})).unwrap();
        }
        session.active().unwrap().doc.clone()
    }

    fn draw(cache: &mut Textures, ctx: &egui::Context, doc: &Arc<Presentation>, index: usize) -> TextureHandle {
        cache.slide(ctx, doc, index, (160, 90), Region::slide(160, 90), true, 0, false, &[], None, None, false).unwrap().0
    }

    fn resized(cache: &mut Textures, ctx: &egui::Context, doc: &Arc<Presentation>, size: (u32, u32), time: f64) -> TextureHandle {
        ctx.begin_pass(egui::RawInput { time: Some(time), ..Default::default() });
        let texture = cache.slide(ctx, doc, 0, size, Region::slide(size.0, size.1), true, 0, false, &[], None, None, true).unwrap().0;
        ctx.end_pass().textures_delta.clear();
        texture
    }

    #[test]
    fn a_resize_burst_renders_its_final_resolution_after_input_stops() {
        let ctx = egui::Context::default();
        let doc = deck();
        let mut cache = Textures::default();
        let original = resized(&mut cache, &ctx, &doc, (160, 90), 0.0);
        let renders = cache.canvas_renders;
        for (i, width) in [192, 224, 256, 288, 320].into_iter().enumerate() {
            let preview = resized(&mut cache, &ctx, &doc, (width, width * 9 / 16), 0.02 * (i + 1) as f64);
            assert_eq!(preview.id(), original.id());
            assert!(cache.canvas_resize_pending());
            assert_eq!(cache.canvas_renders, renders, "intermediate sizes only reposition the unchanged complete slide");
        }
        let exact = resized(&mut cache, &ctx, &doc, (320, 180), 0.25);
        assert_eq!(exact.size(), [320, 180]);
        assert!(!cache.canvas_resize_pending());
        assert_eq!(cache.canvas_renders, renders + 1, "one final exact raster after the settle deadline");
        let renders = cache.canvas_renders;
        assert_eq!(resized(&mut cache, &ctx, &doc, (160, 90), 0.3).id(), original.id());
        assert_eq!(resized(&mut cache, &ctx, &doc, (320, 180), 0.35).id(), exact.id());
        assert_eq!(cache.canvas_renders, renders, "repeated workspace sizes need neither preview nor raster work");
    }

    #[test]
    fn resize_preview_never_defers_new_content_or_an_exposed_pasteboard() {
        let ctx = egui::Context::default();
        let mut session = office_presentation_engine::Session::with_new();
        let doc = session.active().unwrap().doc.clone();
        let mut cache = Textures::default();
        let _ = resized(&mut cache, &ctx, &doc, (160, 90), 0.0);
        let _ = resized(&mut cache, &ctx, &doc, (320, 180), 0.02);
        assert!(cache.canvas_resize_pending());
        session.execute("shape.insert", &serde_json::json!({"preset": "rect", "rect": [-40, -40, 100, 80]})).unwrap();
        let changed = session.active().unwrap().doc.clone();
        let before = cache.canvas_renders;
        let _ = resized(&mut cache, &ctx, &changed, (320, 180), 0.04);
        assert!(!cache.canvas_resize_pending(), "a content edit must not wait on an older resize timer");
        assert!(cache.canvas_renders > before);
        let before = cache.canvas_renders;
        let size = (400, 225);
        ctx.begin_pass(egui::RawInput { time: Some(0.06), ..Default::default() });
        let (_, region) =
            cache.slide(&ctx, &changed, 0, size, Region { x: -100, y: -100, w: 600, h: 425 }, true, 0, false, &[], None, None, true).unwrap();
        ctx.end_pass().textures_delta.clear();
        assert!(!cache.canvas_resize_pending());
        assert!(cache.canvas_renders > before, "newly visible off-slide content needs an exact raster immediately");
        assert!(region.x < 0 || region.y < 0);
    }

    #[test]
    fn revisiting_a_slide_reuses_its_texture_and_rendered_extent() {
        let ctx = egui::Context::default();
        let doc = deck();
        let mut cache = Textures::default();
        let first = draw(&mut cache, &ctx, &doc, 0);
        let _ = draw(&mut cache, &ctx, &doc, 1);
        let renders = cache.canvas_renders;
        let again = draw(&mut cache, &ctx, &doc, 0);
        assert_eq!(first.id(), again.id());
        assert_eq!(cache.canvas_renders, renders);
        assert_eq!(cache.canvas_count(), 2);
    }

    #[test]
    fn toggling_fitted_workspace_sizes_reuses_exact_resolution_textures() {
        let ctx = egui::Context::default();
        let doc = deck();
        let mut cache = Textures::default();
        let regular = draw(&mut cache, &ctx, &doc, 0);
        let expanded = cache.slide(&ctx, &doc, 0, (320, 180), Region::slide(320, 180), true, 0, false, &[], None, None, false).unwrap().0;
        let renders = cache.canvas_renders;
        for _ in 0..3 {
            assert_eq!(draw(&mut cache, &ctx, &doc, 0).id(), regular.id());
            let again = cache.slide(&ctx, &doc, 0, (320, 180), Region::slide(320, 180), true, 0, false, &[], None, None, false).unwrap().0;
            assert_eq!(again.id(), expanded.id());
            assert_eq!(again.size(), [320, 180], "cached workspace toggles preserve device-pixel resolution");
        }
        assert_eq!(cache.canvas_renders, renders, "warm workspace toggles must not rerasterize either size");
        assert_eq!(cache.canvas_count(), 1);
        assert_eq!(cache.canvas_variant_count(), 2);
    }

    #[test]
    fn continuous_zoom_and_animated_states_do_not_accumulate_page_variants() {
        let ctx = egui::Context::default();
        let doc = deck();
        let mut cache = Textures::default();
        let _ = draw(&mut cache, &ctx, &doc, 1);
        for width in [160, 200, 240, 280, 320] {
            let height = width * 9 / 16;
            let _ = cache.slide(&ctx, &doc, 0, (width, height), Region::slide(width, height), true, 0, false, &[], None, None, false).unwrap();
            assert!(cache.canvas_variant_count() <= CANVAS_SIZE_LIMIT + 1);
            assert!(cache.canvas_bytes() <= CANVAS_BYTE_LIMIT);
        }
        let renders = cache.canvas_renders;
        let _ = draw(&mut cache, &ctx, &doc, 1);
        assert_eq!(cache.canvas_renders, renders, "zooming one page must preserve the other recently used page");
        for frame in 1..5 {
            let _ = cache.slide(&ctx, &doc, 0, (160, 90), Region::slide(160, 90), true, frame, false, &[], None, None, false).unwrap();
            assert_eq!(cache.canvas_count(), 2);
            assert_eq!(cache.canvas_variant_count(), 2, "an animated page retains one frame, not both stale size variants");
        }
        let mut changed = doc.clone();
        Arc::make_mut(&mut changed).first_slide_number = 10;
        let renders = cache.canvas_renders;
        let _ = draw(&mut cache, &ctx, &changed, 0);
        assert!(cache.canvas_renders > renders);
        assert_eq!(cache.canvas_variant_count(), 1, "document edits invalidate every prior size");
    }

    #[test]
    fn least_recent_pages_are_evicted_without_discarding_recent_hits() {
        let ctx = egui::Context::default();
        let doc = deck();
        let mut cache = Textures::default();
        for index in 0..4 {
            let _ = draw(&mut cache, &ctx, &doc, index);
        }
        let _ = draw(&mut cache, &ctx, &doc, 0);
        let _ = draw(&mut cache, &ctx, &doc, 4);
        assert_eq!(cache.canvas_count(), CANVAS_TEXTURE_LIMIT);
        assert!(cache.canvas_bytes() <= CANVAS_BYTE_LIMIT);
        let renders = cache.canvas_renders;
        let _ = draw(&mut cache, &ctx, &doc, 0);
        assert_eq!(cache.canvas_renders, renders);
        let _ = draw(&mut cache, &ctx, &doc, 1);
        assert!(cache.canvas_renders > renders, "the least recent page must render again");
        assert_eq!(cache.canvas_count(), CANVAS_TEXTURE_LIMIT);
    }

    #[test]
    fn document_and_interaction_changes_never_reuse_old_pixels() {
        let ctx = egui::Context::default();
        let doc = deck();
        let mut cache = Textures::default();
        let _ = draw(&mut cache, &ctx, &doc, 0);
        let _ = draw(&mut cache, &ctx, &doc, 1);
        let mut changed = doc.clone();
        Arc::make_mut(&mut changed).first_slide_number = 10;
        assert!(Arc::ptr_eq(&doc.slides[0], &changed.slides[0]));
        let before = cache.canvas_renders;
        let _ = draw(&mut cache, &ctx, &changed, 0);
        assert!(cache.canvas_renders > before, "global properties affect fields even when slide Arcs are unchanged");
        assert_eq!(cache.canvas_count(), 1);

        let before = cache.canvas_renders;
        let _ = cache.slide(&ctx, &changed, 0, (160, 90), Region::slide(160, 90), true, 0, true, &[], None, None, false).unwrap();
        assert!(cache.canvas_renders > before);
        assert_eq!(cache.canvas_count(), 1, "render variants must replace the same page's entry");
        let before = cache.canvas_renders;
        let _ = cache.slide(&ctx, &changed, 0, (320, 180), Region::slide(320, 180), true, 0, true, &[], None, None, false).unwrap();
        assert!(cache.canvas_renders > before, "a DPI or zoom change must render at the new resolution");
        let before = cache.canvas_renders;
        cache.invalidate();
        let _ = draw(&mut cache, &ctx, &changed, 0);
        assert!(cache.canvas_renders > before);
    }

    #[test]
    fn editing_and_undoing_a_visited_page_invalidate_its_old_picture() {
        let ctx = egui::Context::default();
        let mut session = office_presentation_engine::Session::with_new();
        let original = session.active().unwrap().doc.clone();
        let mut cache = Textures::default();
        let _ = draw(&mut cache, &ctx, &original, 0);
        session.execute("shape.insert", &serde_json::json!({"preset": "rect", "rect": [20, 20, 100, 80]})).unwrap();
        let changed = session.active().unwrap().doc.clone();
        let before = cache.canvas_renders;
        let _ = draw(&mut cache, &ctx, &changed, 0);
        assert!(cache.canvas_renders > before);
        session.execute("edit.undo", &serde_json::json!({})).unwrap();
        let restored = session.active().unwrap().doc.clone();
        assert_eq!(*restored, *original);
        let before = cache.canvas_renders;
        let _ = draw(&mut cache, &ctx, &restored, 0);
        assert!(cache.canvas_renders > before);
        let other_document = Arc::new(Presentation::default());
        let before = cache.canvas_renders;
        let _ = draw(&mut cache, &ctx, &other_document, 0);
        assert!(cache.canvas_renders > before, "a newly opened document cannot inherit a previous document's picture");
        assert_eq!(cache.canvas_count(), 1);
    }
}

/// `r` cut to at most `max` pixels a side, keeping as much of `visible` as fits.
pub(crate) fn fit_texture(mut r: Region, visible: Region, max: u32) -> Region {
    fn axis(start: &mut i32, len: &mut u32, vis: i32, max: u32) {
        if *len > max {
            let hi = *start as i64 + (*len - max) as i64;
            *start = (vis as i64).clamp(*start as i64, hi) as i32;
            *len = max;
        }
    }
    axis(&mut r.x, &mut r.w, visible.x, max);
    axis(&mut r.y, &mut r.h, visible.y, max);
    r
}

#[cfg(test)]
mod fit_tests {
    use super::*;

    #[test]
    fn canvas_textures_stay_within_the_texture_limit() {
        let r = Region { x: -100, y: -50, w: 5000, h: 1000 };
        let f = fit_texture(r, Region { x: 300, y: 0, w: 800, h: 600 }, 2048);
        assert_eq!((f.x, f.y, f.w, f.h), (300, -50, 2048, 1000));
        // Visible past the far end: the cut is pinned there.
        let f = fit_texture(r, Region { x: 4800, y: 0, w: 800, h: 600 }, 2048);
        assert_eq!((f.x, f.w), (-100 + 5000 - 2048, 2048));
        assert_eq!(fit_texture(r, r, 8192), r);
    }

    #[test]
    fn render_sizes_and_pictures_shrink_to_the_limit_keeping_their_shape() {
        assert_eq!(fit_size((195, 10920), 2048), (36, 2048));
        assert_eq!(fit_size((3000, 1500), 2048), (2048, 1024));
        assert_eq!(fit_size((800, 600), 2048), (800, 600));
        assert_eq!(fit_size((0, 0), 0), (1, 1));
        // A 5000 × 3 picture: half red, half blue, averaged down to 1667 × 1.
        let img = ColorImage::new(
            [5000, 3],
            (0..3)
                .flat_map(|y| (0..5000).map(move |x| (x, y)))
                .map(|(x, _)| if x < 2500 { egui::Color32::RED } else { egui::Color32::BLUE })
                .collect(),
        );
        let small = shrink_to(img, 2048);
        assert_eq!(small.size, [1667, 1]);
        assert_eq!(small.pixels[0], egui::Color32::RED);
        assert_eq!(small.pixels[1666], egui::Color32::BLUE);
        let ok = ColorImage::filled([10, 10], egui::Color32::WHITE);
        assert_eq!(shrink_to(ok.clone(), 2048).size, ok.size);
    }
}
