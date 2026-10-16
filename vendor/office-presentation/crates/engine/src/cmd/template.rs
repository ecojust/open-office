//! Replace a presentation from a template as one edit, retaining the destination file and history.
use std::io::Cursor;

use office_presentation_model::Presentation;
use serde_json::{Value, json};

use super::*;

const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = MAX_INPUT_BYTES.div_ceil(3) * 4;

pub fn specs() -> Vec<CommandSpec> {
    vec![cmd!("template.applyBytes", "切换模板", [], None, "{data: base64} → {slides}", has_doc, apply)]
}

/// Apply the same package limits when opening a file or using it as a template.
pub fn validate_package(bytes: &[u8]) -> Result<()> {
    let error = |message| bad("template.applyBytes", message);
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err(error("演示文稿必须有效且不能超过 64 MiB。"));
    }
    if office_presentation_pptx::is_encrypted(bytes) {
        return Err(error("暂不支持密码保护的演示文稿。"));
    }
    let mut package = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| error("请选择有效的 PPTX 演示文稿。"))?;
    if package.len() > 10_000 {
        return Err(error("演示文稿包含过多部件。"));
    }
    let mut expanded = 0u64;
    let mut presentation = false;
    for index in 0..package.len() {
        let file = package.by_index(index).map_err(|_| error("演示文稿中的部件已损坏。"))?;
        expanded = expanded.checked_add(file.size()).ok_or_else(|| error("演示文稿解压大小超出限制。"))?;
        if expanded > 256 * 1024 * 1024 {
            return Err(error("演示文稿解压后不能超过 256 MiB。"));
        }
        let name = file.name().to_ascii_lowercase();
        presentation |= name == "ppt/presentation.xml";
        if name.ends_with("vbaproject.bin") || name.starts_with("ppt/activex/") {
            return Err(error("暂不支持包含宏或 ActiveX 控件的演示文稿；原文件保持不变。"));
        }
    }
    if !presentation {
        return Err(error("请选择有效的 PPTX 演示文稿。"));
    }
    Ok(())
}

/// A host can preflight before committing its pending speaker-notes draft.
pub fn parse(params: &Value) -> Result<Presentation> {
    let data = str_param(params, "data").ok_or_else(|| bad("template.applyBytes", "缺少模板内容。"))?;
    if data.len() > MAX_BASE64_BYTES {
        return Err(bad("template.applyBytes", "模板文件不能超过 64 MiB。"));
    }
    let bytes = base64_decode(data).ok_or_else(|| bad("template.applyBytes", "模板内容已损坏。"))?;
    validate_package(&bytes)?;
    let presentation = super::file::open_presentation("模板.pptx", &bytes)?;
    if presentation.slides.is_empty() {
        return Err(bad("template.applyBytes", "模板至少需要一张幻灯片。"));
    }
    Ok(presentation)
}

fn apply(session: &mut Session, params: &Value) -> Result<Value> {
    let current = session.doc()?;
    // A live composition/gesture must never become an implicit, destructive template switch.
    if current.composition.is_some() || current.interaction.is_some() {
        return Err(bad("template.applyBytes", "请先完成当前输入或拖动，再切换模板。"));
    }
    let presentation = parse(params)?;
    let slides = presentation.slides.len();
    crate::fonts::install_embedded_fonts(&presentation);
    session.edit(|doc, selection| {
        *doc = presentation;
        *selection = Default::default();
        Ok(())
    })?;
    session.doc_mut()?.compare = None;
    session.painter = None;
    session.anim_painter = None;
    session.media_status.clear();
    session.gif_paused.clear();
    Ok(json!({"slides": slides}))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::DocState;
    use std::sync::Arc;

    fn session() -> Session {
        let mut session = Session::new();
        session.add_document(DocState::new(
            office_presentation_model::defaults::new_presentation(None),
            Some("/documents/current.pptx".into()),
            "当前文稿".into(),
        ));
        session
    }

    fn template() -> Value {
        let mut source = session();
        source.execute("design.slideSize", &json!({"w":720,"h":720})).unwrap();
        source.execute("design.theme", &json!({"name":"Harbor"})).unwrap();
        source.execute("insert.textBox", &json!({"text":"模板标题"})).unwrap();
        source.execute("shape.insert", &json!({"preset":"ellipse","rect":[50,50,100,100]})).unwrap();
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#334488"/></svg>"##;
        source.execute("insert.picture", &json!({"name":"original.svg","data":base64_encode(svg),"rect":[200,50,100,100]})).unwrap();
        source.execute("slide.notes", &json!({"text":"模板演讲者备注"})).unwrap();
        source.execute("slide.new", &json!({"title":"模板第二页"})).unwrap();
        let bytes = office_presentation_pptx::export(&source.doc().unwrap().doc).unwrap();
        json!({"data":base64_encode(&bytes)})
    }

    #[test]
    fn template_switch_replaces_complete_deck_and_undo_redo_retain_destination_identity() {
        let mut session = session();
        session.execute("insert.textBox", &json!({"text":"保留的旧编辑"})).unwrap();
        let before = session.doc().unwrap().clone();
        let params = template();
        let expected = parse(&params).unwrap();
        assert_eq!(expected.slide_size.width, 720.0);
        assert_eq!(expected.masters[0].theme.name, "Harbor");
        assert_eq!(expected.slides[0].notes_text(), "模板演讲者备注");
        assert!(!expected.media.is_empty());
        assert!(expected.slides[0].shapes.len() >= 3);
        session.execute("template.applyBytes", &params).unwrap();
        let switched = session.doc().unwrap().clone();
        assert_eq!(*switched.doc, expected);
        assert_eq!(session.documents().len(), 1);
        assert_eq!(switched.uid, before.uid);
        assert_eq!(switched.title, before.title);
        assert_eq!(switched.path, before.path);
        assert!(Arc::ptr_eq(&switched.saved_doc, &before.saved_doc));
        assert!(switched.is_dirty());
        assert_eq!(switched.history.undo.len(), before.history.undo.len() + 1);
        assert_eq!(switched.selection, Default::default());
        session.execute("edit.undo", &json!({})).unwrap();
        assert!(Arc::ptr_eq(&session.doc().unwrap().doc, &before.doc));
        assert_eq!(session.doc().unwrap().selection, before.selection);
        session.execute("edit.redo", &json!({})).unwrap();
        assert!(Arc::ptr_eq(&session.doc().unwrap().doc, &switched.doc));
        session.execute("edit.undo", &json!({})).unwrap();
        session.execute("edit.undo", &json!({})).unwrap();
        assert!(!session.doc().unwrap().is_dirty());
    }

    #[test]
    fn invalid_template_keeps_document_history_selection_and_live_composition() {
        let mut session = session();
        let id = session.execute("insert.textBox", &json!({"text":"原文稿"})).unwrap()["id"].clone();
        session.execute("text.edit", &json!({"id":id})).unwrap();
        session.execute("text.compose", &json!({"text":"候"})).unwrap();
        let before = session.doc().unwrap().clone();
        assert!(session.execute("template.applyBytes", &json!({"data":"broken"})).is_err());
        let after = session.doc().unwrap();
        assert!(Arc::ptr_eq(&after.doc, &before.doc));
        assert_eq!(after.selection, before.selection);
        assert_eq!(after.history.undo.len(), before.history.undo.len());
        assert!(after.composition.is_some());
        session.execute("text.commit", &json!({"text":"候选"})).unwrap();
        let before = session.doc().unwrap().clone();
        for params in [json!({}), json!({"data":"$invalid"}), json!({"data":base64_encode(b"not a pptx")})] {
            assert!(session.execute("template.applyBytes", &params).is_err());
            assert!(Arc::ptr_eq(&session.doc().unwrap().doc, &before.doc));
            assert_eq!(session.doc().unwrap().history.undo.len(), before.history.undo.len());
        }
    }

    #[test]
    fn template_rejects_macro_packages_before_modifying_document() {
        use std::io::Write;
        let mut package = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for name in ["ppt/presentation.xml", "ppt/vbaProject.bin"] {
            package.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            package.write_all(b"fixture").unwrap();
        }
        let bytes = package.finish().unwrap().into_inner();
        let mut session = session();
        let before = session.doc().unwrap().doc.clone();
        assert!(session.execute("template.applyBytes", &json!({"data":base64_encode(&bytes)})).unwrap_err().to_string().contains("宏"));
        assert!(Arc::ptr_eq(&session.doc().unwrap().doc, &before));
        assert!(session.doc().unwrap().history.undo.is_empty());
    }
}
