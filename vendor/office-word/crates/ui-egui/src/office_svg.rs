//! Original Open Office SVG interface artwork, compiled into static geometry offline.
//! No XML parsing, font glyphs, downloads or document-icon dependencies are involved.
use egui::{Color32, Painter, Pos2, Rect, Shape, Stroke, epaint::Mesh, pos2};

#[derive(Clone, Copy)]
pub enum Paint {
    None,
    Ink,
    Accent,
}

pub struct IconPath {
    pub points: &'static [[f32; 2]],
    pub triangles: &'static [u32],
    pub closed: bool,
    pub fill: Paint,
    pub stroke: Paint,
    pub fill_opacity: f32,
    pub stroke_opacity: f32,
}

impl Paint {
    fn color(self, ink: Color32, accent: Color32, opacity: f32) -> Color32 {
        match self {
            Self::None => Color32::TRANSPARENT,
            Self::Ink => ink.gamma_multiply(opacity),
            Self::Accent => accent.gamma_multiply(opacity),
        }
    }
}

/// Paint the 24×24 authoring viewport centered and uniformly scaled into `rect`.
/// The caller supplies both theme-aware colors, including their disabled alpha.
pub fn paint(painter: &Painter, rect: Rect, name: &str, ink: Color32, accent: Color32) {
    let scale = rect.width().min(rect.height()) / 24.0;
    if !scale.is_finite() || scale <= 0.0 || !rect.is_finite() {
        return;
    }
    let origin = rect.center() - egui::vec2(12.0 * scale, 12.0 * scale);
    let project = |point: &[f32; 2]| pos2(origin.x + point[0] * scale, origin.y + point[1] * scale);
    let Some(paths) = crate::office_icons::lookup(name) else {
        missing_icon(painter, origin, scale, ink, name);
        return;
    };
    for path in paths {
        let fill = path.fill.color(ink, accent, path.fill_opacity);
        if fill != Color32::TRANSPARENT && !path.triangles.is_empty() {
            let mut mesh = Mesh::default();
            mesh.vertices.reserve(path.points.len());
            mesh.indices.extend_from_slice(path.triangles);
            for point in path.points {
                mesh.colored_vertex(project(point), fill);
            }
            painter.add(Shape::mesh(mesh));
        }
        let stroke = path.stroke.color(ink, accent, path.stroke_opacity);
        if stroke != Color32::TRANSPARENT {
            // Keep curves continuous: separate segments snap independently to pixels
            // and endpoint circles would repeatedly darken translucent strokes.
            let width = 1.65 * scale;
            let points: Vec<_> = path.points.iter().map(project).collect();
            if path.closed {
                painter.add(closed_stroke(points, Stroke::new(width, stroke)));
            } else {
                // egui feathers open ends. Only opaque strokes receive additional
                // round caps; disabled/translucent ends retain their native alpha.
                if stroke.a() == 255 {
                    for point in [points.first(), points.last()].into_iter().flatten() {
                        painter.circle_filled(*point, width * 0.5, stroke);
                    }
                }
                painter.add(Shape::line(points, Stroke::new(width, stroke)));
            }
        }
    }
}

fn closed_stroke(points: Vec<Pos2>, stroke: Stroke) -> Shape {
    // Unlike open paths, epaint closed loops have unlimited miters. A narrow
    // checkmark can grow a spike >17 times its stroke radius at an acute corner.
    let sharp = points
        .iter()
        .cycle()
        .skip(points.len().saturating_sub(1))
        .zip(&points)
        .zip(points.iter().cycle().skip(1))
        .any(|((previous, current), next)| {
            let incoming = (*current - *previous).normalized();
            let outgoing = (*next - *current).normalized();
            ((incoming + outgoing) * 0.5).length_sq() < 0.5
        });
    if !sharp {
        return Shape::closed_line(points, stroke);
    }
    let Some((first, second)) = points.first().zip(points.get(1)) else {
        return Shape::Noop;
    };
    // A seam halfway along a straight edge makes all authored corners interior
    // vertices, where epaint's open-path bevel limits acute joins safely.
    let seam = first.lerp(*second, 0.5);
    let mut loop_points = Vec::with_capacity(points.len() + 2);
    loop_points.push(seam);
    loop_points.extend(points.iter().skip(1).copied());
    loop_points.push(*first);
    loop_points.push(seam);
    Shape::line(loop_points, stroke)
}

fn missing_icon(painter: &Painter, origin: Pos2, scale: f32, ink: Color32, name: &str) {
    // A conspicuous diagnostic fallback, never a silent generic icon substitution.
    // The generator checks complete asset coverage before every engine build.
    let point = |x, y| pos2(origin.x + x * scale, origin.y + y * scale);
    let stroke = Stroke::new(1.65 * scale, ink);
    painter.add(Shape::closed_line(
        vec![
            point(4.0, 4.0),
            point(20.0, 4.0),
            point(20.0, 20.0),
            point(4.0, 20.0),
        ],
        stroke,
    ));
    painter.line_segment([point(8.0, 8.0), point(16.0, 16.0)], stroke);
    painter.line_segment([point(8.0, 16.0), point(16.0, 8.0)], stroke);
    #[cfg(debug_assertions)]
    {
        use std::{
            collections::BTreeSet,
            sync::{Mutex, OnceLock},
        };
        static REPORTED: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
        if let Ok(mut reported) = REPORTED.get_or_init(Mutex::default).lock() {
            // Unknown names can originate at a UI boundary; bound diagnostics storage.
            if reported.len() < 128 && reported.insert(name.chars().take(80).collect()) {
                eprintln!("Open Office: missing original interface icon {name:?}");
            }
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = name;
}

#[cfg(test)]
mod tests {
    use super::{Color32, Shape, Stroke, closed_stroke, pos2};

    #[test]
    fn every_compiled_name_has_valid_static_geometry() {
        for name in crate::office_icons::NAMES {
            let paths = crate::office_icons::lookup(name);
            assert!(paths.is_some(), "missing compiled icon {name}");
            for path in paths.into_iter().flatten() {
                assert!(path.points.len() >= 2);
                assert_eq!(path.triangles.len() % 3, 0);
                assert!(
                    path.triangles
                        .iter()
                        .all(|index| (*index as usize) < path.points.len())
                );
                assert!(path.points.iter().flatten().all(|value| value.is_finite()));
            }
        }
        assert!(crate::office_icons::lookup("__missing_icon__").is_none());
    }

    #[test]
    fn acute_closed_checkmark_uses_a_straight_seam_and_limited_joins() {
        // This shape has a 17.27-radius miter at its acute upper-right tip.
        let points = vec![
            pos2(6.5, 12.0),
            pos2(10.5, 16.0),
            pos2(17.5, 8.5),
            pos2(10.5, 18.0),
        ];
        let shape = closed_stroke(points.clone(), Stroke::new(1.65, Color32::WHITE));
        assert!(matches!(&shape, Shape::Path(_)));
        if let Shape::Path(path) = shape {
            assert!(
                !path.closed,
                "acute turns must use epaint's limited open-path joins"
            );
            assert_eq!(path.points.len(), points.len() + 2);
            assert_eq!(path.points.first(), path.points.last());
            assert_eq!(path.points.first(), Some(&pos2(8.5, 14.0)));
            assert_eq!(
                &path.points[1..path.points.len() - 1],
                &[points[1], points[2], points[3], points[0]]
            );
            assert!(path.points.iter().all(|point| point.is_finite()));
        }
    }

    #[test]
    fn ordinary_rectangle_keeps_a_single_closed_stroke() {
        let points = vec![
            pos2(3.0, 3.0),
            pos2(21.0, 3.0),
            pos2(21.0, 21.0),
            pos2(3.0, 21.0),
        ];
        let shape = closed_stroke(points.clone(), Stroke::new(1.65, Color32::WHITE));
        assert!(matches!(&shape, Shape::Path(_)));
        if let Shape::Path(path) = shape {
            assert!(path.closed);
            assert_eq!(path.points, points);
        }
    }
}
