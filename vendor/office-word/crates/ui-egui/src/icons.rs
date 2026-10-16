//! Original Open Office interface icons, sourced from the shared SVG artwork.
//! Inserted document icons remain in the independent document artwork library.

use egui::{Color32, Painter, Pos2, Rect, Shape, Stroke, pos2, vec2};

/// Paint a shell-owned interface SVG with the current enabled/disabled theme colors.
pub fn paint(p: &Painter, r: Rect, name: &str, c: Color32, accent: Color32) {
    crate::office_svg::paint(p, r, name, c, accent);
}

/// Draw an Insert › Icons library icon into `r` in `c`, from the same path data the inserted
/// picture is rendered from (`office_word_render::icon_lib`).
pub fn library(p: &Painter, r: Rect, icon: &office_word_render::icon_lib::Icon, c: Color32) {
    use office_word_render::icon_lib::{GRID, STROKE};
    let s = r.width().min(r.height()) / GRID;
    let o = r.center() - vec2(GRID / 2.0 * s, GRID / 2.0 * s);
    let stroke = Stroke::new(STROKE * s, c);
    for piece in icon.pieces() {
        let pts: Vec<Pos2> = piece.points.iter().map(|q| pos2(o.x + q[0] * s, o.y + q[1] * s)).collect();
        if piece.fill {
            p.add(Shape::convex_polygon(pts, c, Stroke::NONE));
        } else if piece.closed {
            p.add(Shape::closed_line(pts, stroke));
        } else {
            // Round caps, as on the inserted picture.
            for end in [pts.first(), pts.last()].into_iter().flatten() {
                p.circle_filled(*end, stroke.width / 2.0, c);
            }
            p.add(Shape::line(pts, stroke));
        }
    }
}
