use office_pdf_automation::Automation;
use office_pdf_engine::{DocId, Session};
use serde_json::{Value, json};
use std::collections::HashMap;

fn document() -> (Session, DocId) {
    let mut session = Session::new();
    let bytes = session.create_blank(300.0, 400.0, 1).unwrap();
    let id = session.open("current.pdf", None, bytes, None).unwrap();
    (session, id)
}
fn call(session: &mut Session, id: DocId, name: &str, args: Value, read_only: bool) -> Value {
    Automation::call_in_session(session, id, name, &args, HashMap::new(), read_only).unwrap()
}

#[test]
fn document_scripts_and_field_actions_are_editable_persistent_and_undoable() {
    let (mut session, id) = document();
    let source = "function total(a, b) { return a + b; }";
    call(&mut session, id, "js_set_document_script", json!({"name":"helpers","script":source}), false);
    assert_eq!(call(&mut session, id, "js_document_scripts", json!({}), true)["scripts"][0]["script"], source);
    call(&mut session, id, "edit_undo", json!({}), false);
    assert_eq!(call(&mut session, id, "js_document_scripts", json!({}), true)["scripts"], json!([]));
    call(&mut session, id, "edit_redo", json!({}), false);
    call(&mut session, id, "form_add_field", json!({"page":1,"type":"text","name":"City","rect":[20,20,180,42]}), false);
    call(&mut session, id, "form_set_actions", json!({"field":"City","actions":[{"trigger":"mouse_up","page":1}]}), false);
    assert!(call(&mut session, id, "form_actions", json!({"field":"City"}), true).to_string().contains("mouse_up"));
    call(&mut session, id, "form_set_script", json!({"field":"City","event":"validate","script":"event.rc = event.value.length < 100;"}), false);
    let saved = session.save_bytes(id).unwrap();
    let reopened = session.open("saved.pdf", None, saved, None).unwrap();
    assert_eq!(call(&mut session, reopened, "js_document_scripts", json!({}), true)["scripts"][0]["script"], source);
    assert!(call(&mut session, reopened, "form_actions", json!({"field":"City"}), true).to_string().contains("mouse_up"));
    for name in ["js_set_document_script", "form_set_actions", "form_set_script"] {
        assert!(Automation::call_in_session(&mut session, id, name, &json!({}), HashMap::new(), true).is_err());
    }
    assert!(Automation::call_in_session(&mut session, id, "js_run", &json!({"script":"1+1"}), HashMap::new(), false).is_err());
}

#[test]
fn document_fonts_are_loaded_only_from_inline_assets_and_can_be_undone() {
    let (mut session, id) = document();
    let args = json!({"page":1,"path":"inter.ttf"});
    let bytes = include_bytes!("../../../assets/fonts/Inter-Regular.ttf").to_vec();
    let assets = HashMap::from([("inter.ttf".into(), bytes)]);
    let imported = Automation::call_in_session(&mut session, id, "text_font_import", &args, assets.clone(), false).unwrap();
    assert_eq!(imported["font"], "Inter-Regular");
    let resource = imported["resource"].as_str().unwrap();
    assert!(call(&mut session, id, "text_fonts", json!({"page":1}), true).to_string().contains(resource));
    call(&mut session, id, "edit_undo", json!({}), false);
    assert!(!call(&mut session, id, "text_fonts", json!({"page":1}), true).to_string().contains(resource));
    assert!(Automation::call_in_session(&mut session, id, "text_font_import", &args, HashMap::new(), false).is_err());
    assert!(Automation::call_in_session(&mut session, id, "text_font_import", &args, assets, true).is_err());
}

#[test]
fn catalog_callers_cannot_change_shared_definitions_or_restore_document_arguments() {
    let mut first = office_pdf_automation::embedded_tools();
    let name = first[0].name;
    let schema = first[0].input_schema.clone();
    first[0].name = "tampered";
    first[0].input_schema["properties"]["doc"] = json!({"type":"integer"});
    first.clear();
    let second = office_pdf_automation::embedded_tools();
    assert_eq!(second[0].name, name);
    assert_eq!(second[0].input_schema, schema);
    assert!(second.iter().all(|tool| tool.input_schema["properties"].get("doc").is_none()));
    let source = office_pdf_automation::tools();
    let raw = source.iter().find(|tool| tool.name == "doc_info").unwrap();
    assert!(raw.input_schema["properties"].get("doc").is_some());
}
