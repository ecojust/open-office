//! Document-scoped automation. This is deliberately separate from the UI command bridge:
//! clients can edit the open document, but cannot launch dialogs or own files/the application.

use office_word_engine::Session;
use office_word_ui_egui::WordApp;
use serde_json::{Value, json};

pub fn allowed(id: &str) -> bool {
    let family = id.split('.').next().unwrap_or("");
    let document_command = matches!(
        family,
        "text"
            | "caret"
            | "select"
            | "edit"
            | "format"
            | "para"
            | "list"
            | "styles"
            | "table"
            | "insert"
            | "equation"
            | "layout"
            | "arrange"
            | "references"
            | "fields"
            | "review"
            | "design"
            | "hf"
            | "object"
            | "picture"
            | "shape"
            | "chart"
            | "smartArt"
            | "draw"
            | "canvas"
            | "wordArt"
            | "developer"
            | "outline"
            | "link"
            | "document"
            | "mailings"
    ) || matches!(
        id,
        "font.list" | "file.properties" | "file.privacy" | "file.privacyOptions"
    );
    document_command
        && !matches!(
            id,
            "edit.repeat"
                | "edit.copy"
                | "edit.cut"
                | "edit.clipboardPane"
                | "edit.clipboardItems"
                | "edit.pasteClipboardItem"
                | "edit.pasteAllClipboard"
                | "edit.deleteClipboardItem"
                | "edit.clearClipboard"
                | "edit.findReplace"
                | "format.fontDialog"
                | "para.dialog"
                | "styles.manage"
                | "styles.organizer"
                | "styles.copyFrom"
                | "insert.object"
                | "insert.textFromFile"
                | "mailings.labels"
                | "mailings.finish"
                | "review.readAloud"
                | "review.addToDictionary"
                | "review.proofing"
                | "design.setDefault"
                | "references.researcher"
                | "table.draw"
                | "table.eraser"
                | "table.borderPainter"
        )
}

pub fn query_allowed(id: &str) -> bool {
    matches!(
        id,
        "document.inspect"
            | "document.text"
            | "document.paragraph"
            | "document.selection"
            | "document.layout"
            | "format.state"
            | "styles.inspect"
            | "font.list"
            | "edit.undoHistory"
            | "link.targets"
            | "file.privacy"
    )
}

fn has_file_path(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            (value.is_string()
                && matches!(
                    key.as_str(),
                    "path" | "filePath" | "outputPath" | "folder" | "original"
                ))
                || has_file_path(value)
        }),
        Value::Array(values) => values.iter().any(has_file_path),
        _ => false,
    }
}

pub fn validate(id: &str, params: &Value) -> Result<(), String> {
    if !allowed(id) {
        return Err("This command is not available for document automation.".into());
    }
    if !params.is_object() {
        return Err("Command parameters must be an object.".into());
    }
    if has_file_path(params) {
        return Err(
            "Use inline content or base64 images; filesystem paths are not accepted.".into(),
        );
    }
    let has = |key: &str| params.get(key).is_some();
    let string = |key: &str| params.get(key).and_then(Value::as_str).is_some();
    let ready = match id {
        "insert.picture" | "picture.change" => string("data"),
        "insert.icon" => string("id"),
        "insert.chart" => string("type") || has("data"),
        "format.phonetic" => has("ruby"),
        "layout.pageSetup" => params.get("section").is_some_and(Value::is_object),
        "insert.link" => {
            string("url")
                || string("bookmark")
                || params.get("heading").and_then(Value::as_u64).is_some()
                || params.get("top") == Some(&Value::Bool(true))
        }
        "edit.find" | "edit.advancedFind" => string("text"),
        "edit.goto" => {
            params.get("page").and_then(Value::as_u64).is_some()
                || params.get("pageBy").and_then(Value::as_i64).is_some()
                || string("bookmark")
                || params.get("paragraph").and_then(Value::as_u64).is_some()
        }
        "edit.paste" | "edit.pasteMerge" => ["text", "html", "rtf"].iter().any(|key| string(key)),
        "edit.pasteText" => string("text"),
        "edit.pasteSpecial" => {
            string("as")
                && ["text", "html", "rtf", "picture"]
                    .iter()
                    .any(|key| string(key))
        }
        "mailings.envelopes" => params.get("add") == Some(&Value::Bool(true)),
        "review.compare" | "review.combine" => {
            string("text") && params.get("showIn").and_then(Value::as_str) == Some("original")
        }
        _ => true,
    };
    if !ready {
        return Err("Supply the document content/operation parameters listed by word_list_commands; interactive dialogs and system clipboard access are unavailable.".into());
    }
    Ok(())
}

pub fn execute(app: &mut WordApp, id: &str, params: Value, query: bool) -> Result<Value, String> {
    if query && !query_allowed(id) {
        return Err("This command is not a read-only document query.".into());
    }
    validate(id, &params)?;
    if app.session.registry.get(id).is_none() {
        return Err("Unknown document command.".into());
    }
    if query {
        return app
            .session
            .run(id, &params)
            .map_err(|error| error.to_string());
    }
    if app.dialog.is_some() || app.colors.is_some() {
        return Err("请先完成或取消文稿中已打开的设置弹窗，再执行 MCP 编辑。".into());
    }
    app.execute_noninteractive(id, params)
}

/// Registry-backed discovery includes contextual enablement and the engine's exact parameter
/// documentation. Pagination keeps a client from losing the end of a large command catalog.
pub fn commands(session: &Session, params: &Value) -> Value {
    let search = params
        .get("search")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .clamp(1, 100) as usize;
    let mut commands: Vec<_> = session
        .registry
        .all()
        .iter()
        .filter(|command| {
            allowed(command.id)
                && (search.is_empty()
                    || [command.id, command.label, command.location, command.params]
                        .iter()
                        .any(|value| value.to_lowercase().contains(&search)))
        })
        .collect();
    commands.sort_by_key(|command| command.id);
    let total = commands.len();
    let entries: Vec<_> = commands.into_iter().skip(offset).take(limit).map(|command| {
        let disabled = (command.enabled)(session);
        json!({"id":command.id, "label":command.label, "category":command.location,
            "parameters":command.params, "enabled":disabled.is_none(), "disabledReason":disabled,
            "changesDocument":command.mutates || matches!(command.id, "edit.undo" | "edit.undoTo" | "edit.redo"),
            "query":query_allowed(command.id)})
    }).collect();
    json!({"commands":entries,"total":total,"offset":offset,"nextOffset":(offset.saturating_add(limit)<total).then_some(offset.saturating_add(limit)),
        "usage":"Use word_execute_command with an id and params. Positions use UTF-8 byte offsets (not JS character indices); inspect paragraphs or use select.text. Images require base64 data. All changes use the live editor and its undo history."})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_includes_the_live_editing_families_but_not_ui_or_file_operations() {
        let session = Session::new(office_word_doc::Document::from_text("Hello"));
        let catalog = commands(&session, &json!({"limit":100}));
        assert!(catalog["total"].as_u64().unwrap() > 250);
        for id in [
            "select.range",
            "format.bold",
            "para.set",
            "insert.table",
            "table.merge",
            "insert.picture",
            "picture.crop",
            "layout.margins",
            "review.newComment",
            "shape.fill",
            "chart.editData",
        ] {
            assert!(session.registry.get(id).is_some(), "{id}");
            assert!(allowed(id), "{id}");
        }
        for id in [
            "ui.dialog",
            "file.open",
            "file.save",
            "tools.macros",
            "edit.repeat",
            "format.fontDialog",
            "font.add",
            "insert.textFromFile",
        ] {
            assert!(!allowed(id), "{id}");
        }
    }

    #[test]
    fn validation_rejects_paths_and_dialog_fallbacks_before_mutation() {
        for (id, params) in [
            ("insert.picture", json!({})),
            ("insert.chart", json!({})),
            ("format.phonetic", json!({})),
            ("edit.goto", json!({"page":null})),
            ("insert.link", json!({"heading":null})),
            ("review.compare", json!({"text":"Revised", "showIn":"new"})),
            (
                "review.combine",
                json!({"text":"Revised", "showIn":"original", "original":"/tmp/private"}),
            ),
            ("edit.paste", json!({})),
            ("edit.pasteSpecial", json!({"text":"hello"})),
            (
                "insert.picture",
                json!({"data":"abc", "nested":{"path":"/tmp/private"}}),
            ),
            ("mailings.envelopes", json!({"delivery":"Address"})),
        ] {
            assert!(validate(id, &params).is_err(), "{id}");
        }
        assert!(validate("document.paragraph", &json!({"path":[0]})).is_ok());
        assert!(validate("insert.picture", &json!({"data":"abc"})).is_ok());
        assert!(validate("format.phonetic", &json!({"ruby":null})).is_ok());
        assert!(validate("edit.pasteSpecial", &json!({"as":"text","text":"hello"})).is_ok());
        assert!(
            validate(
                "review.compare",
                &json!({"text":"Revised", "showIn":"original"})
            )
            .is_ok()
        );
        assert!(!query_allowed("document.setText"));
        assert!(!query_allowed("edit.undo"));
    }

    #[test]
    fn noninteractive_fallback_never_leaves_a_dialog_or_undo_step() {
        let mut app = WordApp::new(
            Session::new(office_word_doc::Document::from_text("Keep this document")),
            office_word_ui_egui::Services {
                embedded_editor: true,
                ..Default::default()
            },
        );
        let before = app.session.doc.clone();
        let selection = app.session.sel.clone();
        let history = app.session.undo_depth();
        // Exercise the generic UI-request barrier directly, independently of the MCP
        // parameter guards. These engine commands otherwise open a picker or settings.
        for (id, params) in [
            ("insert.picture", json!({})),
            ("insert.chart", json!({})),
            ("layout.pageSetup", json!({})),
            ("format.phonetic", json!({})),
            ("format.fontDialog", json!({})),
            ("para.dialog", json!({})),
            ("edit.goto", json!({"page":null})),
            ("insert.link", json!({"heading":null})),
        ] {
            assert!(app.execute_noninteractive(id, params).is_err(), "{id}");
            assert!(app.dialog.is_none(), "{id}");
            assert!(app.colors.is_none(), "{id}");
            assert!(app.session.ui_requests.is_empty(), "{id}");
            assert_eq!(app.session.doc, before, "{id}");
            assert_eq!(app.session.sel, selection, "{id}");
            assert_eq!(app.session.undo_depth(), history, "{id}");
        }
        execute(
            &mut app,
            "text.insert",
            json!({"text":"Still editable ","raw":true}),
            false,
        )
        .unwrap();
        assert!(
            app.session
                .doc
                .plain_text(office_word_doc::StoryRef::Body)
                .contains("Still editable")
        );
        execute(&mut app, "edit.undo", json!({}), false).unwrap();
        assert_eq!(app.session.doc, before);
    }

    #[test]
    fn compare_and_combine_apply_inline_revisions_to_the_current_document_with_undo() {
        for id in ["review.compare", "review.combine"] {
            let mut app = WordApp::new(
                Session::new(office_word_doc::Document::from_text(
                    "The original sentence.",
                )),
                office_word_ui_egui::Services {
                    embedded_editor: true,
                    ..Default::default()
                },
            );
            app.session.file_name = Some("Existing.docx".into());
            let before = app.session.doc.clone();
            let identity = app.session.document_id();
            let result = execute(
                &mut app,
                id,
                json!({"text":"The revised sentence.", "showIn":"original", "author":"Reviewer"}),
                false,
            )
            .unwrap();
            assert!(result["changes"].as_u64().unwrap() > 0, "{id}");
            assert!(!app.session.doc.revisions.is_empty(), "{id}");
            assert_eq!(app.session.document_id(), identity, "{id}");
            assert_eq!(
                app.session.file_name.as_deref(),
                Some("Existing.docx"),
                "{id}"
            );
            execute(&mut app, "edit.undo", json!({}), false).unwrap();
            assert_eq!(app.session.doc, before, "{id}");
        }
    }

    #[test]
    fn editing_uses_the_real_engine_and_history_while_queries_are_passive() {
        let mut app = WordApp::new(
            Session::new(office_word_doc::Document::from_text("Hello 世界")),
            office_word_ui_egui::Services {
                embedded_editor: true,
                ..Default::default()
            },
        );
        execute(
            &mut app,
            "file.privacyOptions",
            json!({"removePersonalInfo":true}),
            false,
        )
        .unwrap();
        assert_eq!(
            execute(&mut app, "file.privacy", json!({}), true).unwrap()["removePersonalInfo"],
            true
        );
        execute(&mut app, "edit.undo", json!({}), false).unwrap();
        assert!(!app.session.doc.settings.remove_personal_info);
        execute(&mut app, "select.text", json!({"text":"世界"}), false).unwrap();
        execute(
            &mut app,
            "format.set",
            json!({"props":{"bold":true,"size":22,"color":"D52B3F"}}),
            false,
        )
        .unwrap();
        let selection = app.session.sel.clone();
        let before_query = app.session.undo_depth();
        let info = execute(&mut app, "document.inspect", json!({}), true).unwrap();
        assert_eq!(info["blocks"][0]["text"], "Hello 世界");
        assert!(
            info["blocks"][0]["runs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|run| run["props"]["bold"] == true)
        );
        assert_eq!(app.session.sel, selection);
        assert_eq!(app.session.undo_depth(), before_query);
        execute(
            &mut app,
            "text.insert",
            json!({"text":"Open Office","raw":true}),
            false,
        )
        .unwrap();
        assert_eq!(
            app.session.doc.plain_text(office_word_doc::StoryRef::Body),
            "Hello Open Office"
        );
        execute(&mut app, "edit.undo", json!({}), false).unwrap();
        assert_eq!(
            app.session.doc.plain_text(office_word_doc::StoryRef::Body),
            "Hello 世界"
        );
        execute(&mut app, "edit.redo", json!({}), false).unwrap();
        execute(
            &mut app,
            "layout.orientation",
            json!({"value":"landscape"}),
            false,
        )
        .unwrap();
        assert!(app.session.doc.last_section.landscape);
        execute(&mut app, "caret.docEnd", json!({}), false).unwrap();
        execute(&mut app, "insert.table", json!({"rows":2,"cols":3}), false).unwrap();
        let info = execute(&mut app, "document.inspect", json!({}), true).unwrap();
        assert!(
            info["blocks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|block| block["type"] == "table" && block["rows"] == 2 && block["cols"] == 3)
        );
        let before = app.session.doc.clone();
        assert!(
            execute(
                &mut app,
                "text.insert",
                json!({"text":"must not run"}),
                true
            )
            .is_err()
        );
        assert!(execute(&mut app, "ui.dialog", json!({"name":"font"}), false).is_err());
        assert!(execute(&mut app, "insert.picture", json!({}), false).is_err());
        assert_eq!(app.session.doc, before);
        assert!(app.dialog.is_none());
    }
}
