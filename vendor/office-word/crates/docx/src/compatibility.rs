//! Read the canvas transform namespace emitted by earlier versions.

pub(crate) fn canvas_transform_uri(uri: Option<&str>) -> bool {
    matches!(uri, Some(crate::CANVAS_SPIN_EXT | "urn:wordcraft:canvas-xfrm"))
}
