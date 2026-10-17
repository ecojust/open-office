//! Open Office's original three-slide starter, installed as a clean document before editing.
//! Background artwork is stored in the document; all headings and the closing wordmark remain text.

use std::sync::Arc;

use office_presentation_model::style::{Gradient, GradientShape, GradientStop, PictureFill};
use office_presentation_model::text::{Align, Anchor, AutoFit, Bullet, Spacing};
use office_presentation_model::{
    Background, ColorRef, CustomPath, Fill, Geom, LayoutType, Line, PhType, Placeholder, Presentation, Rgba, RunProps, Shape, ShapeId, ShapeKind,
    Slide, TextBody, Xfrm, defaults,
};

const COVER: &[u8] = include_bytes!("../../../assets/templates/open-office/cover.png");
const CLOSING: &[u8] = include_bytes!("../../../assets/templates/open-office/closing.png");
const NO_IDS: &str = "无法为演示文稿模板分配对象编号。";

fn color(r: u8, g: u8, b: u8) -> ColorRef {
    ColorRef::rgb(Rgba::rgb(r, g, b))
}

fn gradient(colors: [(u8, u8, u8); 2], angle: f64) -> Fill {
    Fill::Gradient(Gradient {
        stops: colors.into_iter().enumerate().map(|(index, (r, g, b))| GradientStop { pos: index as f64, color: color(r, g, b) }).collect(),
        shape: GradientShape::Linear { angle, scaled: true },
        rotate_with_shape: true,
        tile: [0.0; 4],
    })
}

fn background(doc: &mut Presentation, name: &str, data: &[u8]) -> Result<Background, String> {
    let media = doc.add_media(name, "image/png", data.to_vec()).ok_or(NO_IDS)?;
    Ok(Background::Fill { fill: Fill::Picture(PictureFill { media, ..Default::default() }) })
}

fn slide(doc: &mut Presentation, name: &str) -> Result<Slide, String> {
    let layout = defaults::layout_of_kind(doc, LayoutType::Blank).ok_or("演示文稿模板缺少空白版式。")?;
    let mut slide = defaults::new_slide(doc, layout).ok_or(NO_IDS)?;
    slide.name = name.into();
    slide.show_master_shapes = false;
    Ok(slide)
}

fn text(doc: &mut Presentation, name: &str, content: &str, rect: Xfrm, props: RunProps, align: Align, title: bool) -> Result<Shape, String> {
    let mut body = TextBody::from_text(content);
    body.body.inset_l = Some(0.0);
    body.body.inset_r = Some(0.0);
    body.body.inset_t = Some(0.0);
    body.body.inset_b = Some(0.0);
    body.body.anchor = Some(Anchor::Middle);
    body.body.wrap = Some(true);
    body.body.autofit = Some(AutoFit::Shrink { font_scale: Some(1.0), line_reduction: 0.0 });
    for paragraph in &mut body.paragraphs {
        paragraph.props.align = Some(align);
        paragraph.props.bullet = Some(Bullet::None);
        paragraph.props.margin_left = Some(0.0);
        paragraph.props.indent = Some(0.0);
        paragraph.props.line_spacing = Some(Spacing::Pct(1.1));
        paragraph.props.space_before = Some(Spacing::Pts(0.0));
        paragraph.props.space_after = Some(Spacing::Pts(0.0));
        paragraph.def_props = props.clone();
        paragraph.end_props = props.clone();
        for run in &mut paragraph.runs {
            run.props = props.clone();
        }
    }
    Ok(Shape {
        id: ShapeId(doc.alloc_id().ok_or(NO_IDS)?),
        name: name.into(),
        xfrm: Some(rect),
        text: Some(body),
        text_box: true,
        fill: Some(Fill::None),
        line: Some(Line::none()),
        ph: title.then_some(Placeholder { kind: PhType::Title, idx: 0, ..Default::default() }),
        ..Default::default()
    })
}

fn typography(size: f64, rgb: (u8, u8, u8), bold: bool) -> RunProps {
    RunProps {
        font: Some("Inter".into()),
        size: Some(size),
        bold: Some(bold),
        fill: Some(Fill::solid(color(rgb.0, rgb.1, rgb.2))),
        ..Default::default()
    }
}

fn mark_path(doc: &mut Presentation, rect: Xfrm, path: String, rgb: (u8, u8, u8)) -> Result<Shape, String> {
    Ok(Shape {
        id: ShapeId(doc.alloc_id().ok_or(NO_IDS)?),
        xfrm: Some(rect),
        geom: Geom::Custom { paths: vec![CustomPath { w: rect.w, h: rect.h, d: path, stroke: false, ..Default::default() }] },
        fill: Some(Fill::solid(color(rgb.0, rgb.1, rgb.2))),
        line: Some(Line::none()),
        decorative: true,
        ..Default::default()
    })
}

fn mark_rect(doc: &mut Presentation, rect: Xfrm, radius: f64, rgb: (u8, u8, u8)) -> Result<Shape, String> {
    let (w, h, r) = (rect.w, rect.h, radius);
    let (right, bottom) = (w - r, h - r);
    // Cubic quarter-circles match the SVG's rounded corners at every output scale.
    let k = r * 0.552_284_749_8;
    let (near, far_x, far_y) = (r - k, right + k, bottom + k);
    let path = format!(
        "M {r} 0 L {right} 0 C {far_x} 0 {w} {near} {w} {r} L {w} {bottom} C {w} {far_y} {far_x} {h} {right} {h} L {r} {h} C {near} {h} 0 {far_y} 0 {bottom} L 0 {r} C 0 {near} {near} 0 {r} 0 Z"
    );
    mark_path(doc, rect, path, rgb)
}

/// The geometry of assets/templates/open-office/content-mark.svg, kept as real vectors in PPTX
/// and PDF instead of depending on SVG-image support in a document viewer.
fn content_mark(doc: &mut Presentation) -> Result<Shape, String> {
    let children = vec![
        mark_rect(doc, Xfrm::new(0.0, 0.0, 160.0, 56.0), 12.0, (237, 242, 255))?,
        mark_rect(doc, Xfrm::new(14.0, 14.0, 34.0, 24.0), 4.0, (211, 222, 249))?,
        mark_rect(doc, Xfrm::new(22.0, 18.0, 34.0, 24.0), 4.0, (163, 185, 239))?,
        mark_rect(doc, Xfrm::new(30.0, 12.0, 36.0, 26.0), 4.0, (85, 117, 213))?,
        mark_path(doc, Xfrm::new(43.0, 19.0, 10.0, 12.0), "M 0 0 L 0 12 L 10 6 Z".into(), (255, 255, 255))?,
        mark_rect(doc, Xfrm::new(82.0, 16.0, 57.0, 4.0), 2.0, (104, 122, 196))?,
        mark_rect(doc, Xfrm::new(82.0, 26.0, 39.0, 4.0), 2.0, (160, 173, 219))?,
        mark_rect(doc, Xfrm::new(82.0, 36.0, 48.0, 4.0), 2.0, (195, 205, 236))?,
    ];
    Ok(Shape {
        id: ShapeId(doc.alloc_id().ok_or(NO_IDS)?),
        name: "演示主题图案".into(),
        xfrm: Some(Xfrm::new(64.0, 42.0, 96.0, 33.6)),
        kind: ShapeKind::Group { children, child: Xfrm::new(0.0, 0.0, 160.0, 56.0) },
        decorative: true,
        ..Default::default()
    })
}

pub(crate) fn presentation() -> Result<Presentation, String> {
    let mut doc = defaults::blank_presentation(defaults::WIDE, Default::default(), false);
    let mut cover = slide(&mut doc, "封面")?;
    cover.background = Some(background(&mut doc, "open-office-cover.png", COVER)?);
    cover.shapes.push(text(
        &mut doc,
        "主标题",
        "Open Office 演示",
        Xfrm::new(64.0, 168.0, 580.0, 92.0),
        typography(44.0, (30, 44, 78), true),
        Align::Left,
        true,
    )?);
    cover.shapes.push(text(
        &mut doc,
        "副标题",
        "从一个想法，开始精彩表达",
        Xfrm::new(66.0, 274.0, 520.0, 40.0),
        typography(21.0, (86, 105, 132), false),
        Align::Left,
        false,
    )?);
    cover.shapes.push(text(
        &mut doc,
        "署名",
        "汇报人 / 你的姓名",
        Xfrm::new(66.0, 420.0, 400.0, 28.0),
        typography(15.0, (86, 105, 132), false),
        Align::Left,
        false,
    )?);
    doc.slides.push(Arc::new(cover));

    let mut content = slide(&mut doc, "内容")?;
    content.background = Some(Background::Fill { fill: Fill::solid(color(250, 252, 255)) });
    content.shapes.push(content_mark(&mut doc)?);
    content.shapes.push(text(
        &mut doc,
        "内容标题",
        "请输入标题",
        Xfrm::new(64.0, 98.0, 820.0, 68.0),
        typography(36.0, (30, 44, 78), true),
        Align::Left,
        true,
    )?);
    doc.slides.push(Arc::new(content));

    let mut closing = slide(&mut doc, "结尾")?;
    closing.background = Some(background(&mut doc, "open-office-closing.png", CLOSING)?);
    let mut wordmark = typography(86.0, (255, 255, 255), true);
    wordmark.italic = Some(true);
    wordmark.spacing = Some(-2.0);
    wordmark.fill = Some(gradient([(255, 255, 255), (190, 234, 254)], 90.0));
    closing.shapes.push(text(&mut doc, "结束标题", "open office", Xfrm::new(100.0, 200.0, 760.0, 140.0), wordmark, Align::Center, true)?);
    doc.slides.push(Arc::new(closing));
    Ok(doc)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    fn editable_text(slide: &Slide) -> Vec<String> {
        slide.shapes.iter().filter_map(|shape| shape.text.as_ref().map(TextBody::text)).collect()
    }

    #[test]
    fn starter_has_cover_content_closing_and_separate_editable_text() {
        let doc = presentation().unwrap();
        assert_eq!(doc.slide_size, defaults::WIDE);
        assert_eq!(doc.slides.iter().map(|slide| slide.name.as_str()).collect::<Vec<_>>(), ["封面", "内容", "结尾"]);
        assert_eq!(editable_text(&doc.slides[0]), ["Open Office 演示", "从一个想法，开始精彩表达", "汇报人 / 你的姓名"]);
        assert_eq!(editable_text(&doc.slides[1]), ["请输入标题"]);
        assert_eq!(editable_text(&doc.slides[2]), ["open office"]);
        for slide in &doc.slides {
            assert!(!slide.show_master_shapes);
            assert!(slide.shapes.iter().filter(|shape| shape.text.is_some()).all(|shape| shape.text_box && !shape.locked));
        }
        let title = &doc.slides[2].shapes[0];
        let body = title.text.as_ref().unwrap();
        assert_eq!(body.paragraphs[0].props.align, Some(Align::Center));
        let style = &body.paragraphs[0].runs[0].props;
        assert_eq!(style.font.as_deref(), Some("Inter"));
        assert_eq!(style.bold, Some(true));
        assert_eq!(style.italic, Some(true));
        assert!(matches!(style.fill, Some(Fill::Gradient(_))));
    }

    #[test]
    fn background_artwork_and_vector_mark_survive_pptx_round_trip() {
        let doc = presentation().unwrap();
        let bytes = office_presentation_pptx::export(&doc).unwrap();
        let reopened = office_presentation_pptx::import(&bytes).unwrap();
        assert_eq!(reopened.slides.len(), 3);
        assert_eq!(reopened.slide_size, defaults::WIDE);
        for (before, after) in doc.slides.iter().zip(&reopened.slides) {
            assert_eq!(editable_text(before), editable_text(after));
            assert_eq!(before.shapes.len(), after.shapes.len());
            for (before, after) in before.shapes.iter().zip(&after.shapes) {
                assert_eq!(before.xfrm, after.xfrm);
            }
        }
        for (index, source) in [(0, COVER), (2, CLOSING)] {
            let Some(Background::Fill { fill: Fill::Picture(picture) }) = &reopened.slides[index].background else {
                panic!("starter artwork must be a real slide background");
            };
            let media = reopened.media(picture.media).unwrap();
            assert_eq!(media.content_type, "image/png");
            assert_eq!(media.data.as_slice(), source);
            assert!(source.starts_with(b"\x89PNG\r\n\x1a\n"));
        }
        let ShapeKind::Group { children, child } = &reopened.slides[1].shapes[0].kind else {
            panic!("the content mark must remain vector geometry");
        };
        assert_eq!(*child, Xfrm::new(0.0, 0.0, 160.0, 56.0));
        assert_eq!(children.len(), 8);
        assert!(children.iter().all(|shape| matches!(shape.geom, Geom::Custom { .. }) && matches!(shape.kind, ShapeKind::Shape)));
        for (before, after) in doc.slides[1].shapes[0].children().iter().zip(children) {
            assert_eq!(before.xfrm, after.xfrm);
            assert_eq!(before.fill, after.fill);
            let (Geom::Custom { paths: before }, Geom::Custom { paths: after }) = (&before.geom, &after.geom) else {
                panic!("the content mark lost its vector paths");
            };
            assert_eq!(before.len(), after.len());
            for (before, after) in before.iter().zip(after) {
                // OOXML rescales custom path coordinates to integer units on export.
                let tokens = |path: &CustomPath| path.d.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
                let (before_tokens, after_tokens) = (tokens(before), tokens(after));
                assert_eq!(before_tokens.len(), after_tokens.len());
                for (a, b) in before_tokens.iter().zip(&after_tokens) {
                    if let (Ok(a), Ok(b)) = (a.parse::<f64>(), b.parse::<f64>()) {
                        assert!((a / before.w.max(before.h) - b / after.w.max(after.h)).abs() < 0.00002);
                    } else {
                        assert_eq!(a, b);
                    }
                }
            }
        }
        let before = doc.slides[2].shapes[0].text.as_ref().unwrap();
        let after = reopened.slides[2].shapes[0].text.as_ref().unwrap();
        assert_eq!(before.paragraphs[0].runs[0].props.fill, after.paragraphs[0].runs[0].props.fill);
        assert_eq!(after.paragraphs[0].runs[0].props.italic, Some(true));
    }

    #[test]
    fn all_template_objects_have_unique_ids_and_the_next_edit_can_allocate() {
        let mut doc = presentation().unwrap();
        let mut ids = std::collections::HashSet::new();
        for master in &doc.masters {
            assert!(ids.insert(master.id.0));
            for layout in &master.layouts {
                assert!(ids.insert(layout.id.0));
                for shape in &layout.shapes {
                    assert!(ids.insert(shape.id.0));
                }
            }
            for shape in &master.shapes {
                assert!(ids.insert(shape.id.0));
            }
        }
        for slide in &doc.slides {
            assert!(ids.insert(slide.id.0));
            for shape in &slide.shapes {
                assert!(ids.insert(shape.id.0));
                for child in shape.children() {
                    assert!(ids.insert(child.id.0));
                }
            }
        }
        for media in &doc.media {
            assert!(ids.insert(media.id.0));
        }
        assert!(ids.insert(doc.alloc_id().unwrap()));
    }
}
