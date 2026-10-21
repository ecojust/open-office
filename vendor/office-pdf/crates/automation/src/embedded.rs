//! Current-document automation used by the local editor. No filesystem or network access.
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

use office_pdf_engine::{DocId, Session};
use serde_json::{Value, json};

use crate::{Automation, Content, Result, ToolDef, ToolError, failed, tools};

/// An explicit set: adding a future CLI/system tool cannot expand editor access.
fn allowed(name: &str) -> bool {
    matches!(
        name,
        "doc_info"
            | "doc_set_info"
            | "object_list"
            | "object_move"
            | "text_word_count"
            | "text_extract"
            | "text_find"
            | "text_lines"
            | "text_fonts"
            | "text_paragraphs"
            | "text_edit_layout"
            | "text_edit"
            | "page_images"
            | "image_hit"
            | "image_edit"
            | "page_rotate"
            | "page_enhance_camera"
            | "page_delete"
            | "page_move"
            | "page_insert_blank"
            | "page_insert_file"
            | "page_replace"
            | "page_duplicate"
            | "page_number"
            | "page_transition_set"
            | "page_set_box"
            | "bookmark_list"
            | "bookmark_add"
            | "bookmark_rename"
            | "bookmark_delete"
            | "bookmark_move"
            | "bookmark_set_page"
            | "bookmark_from_structure"
            | "form_fields"
            | "form_fill"
            | "form_reset"
            | "form_add_field"
            | "form_set_image"
            | "form_set_props"
            | "form_tab_order"
            | "form_delete_field"
            | "form_detect_fields"
            | "doc_import_data"
            | "redact_mark"
            | "redact_apply"
            | "redact_clear"
            | "doc_hidden_info"
            | "doc_remove_hidden"
            | "doc_audit_redactions"
            | "content_list"
            | "page_add_text"
            | "page_add_image"
            | "content_update"
            | "content_delete"
            | "link_list"
            | "link_add"
            | "link_edit"
            | "link_delete"
            | "links_from_urls"
            | "links_remove"
            | "measure_distance"
            | "measure_perimeter"
            | "measure_area"
            | "measure_info"
            | "measure_list"
            | "measure_scale"
            | "measure_snap"
            | "comment_list"
            | "comment_add"
            | "comment_reply"
            | "comment_set_status"
            | "comment_mark"
            | "comment_lock"
            | "comment_edit"
            | "comment_delete"
            | "stamp_custom"
            | "fill_sign_add"
            | "sign_list"
            | "doc_protect"
            | "doc_unprotect"
            | "doc_header_footer"
            | "doc_watermark"
            | "doc_background"
            | "doc_remove_marks"
            | "accessibility_autotag_preview"
            | "accessibility_autotag_apply"
            | "accessibility_autotag_form_fields"
            | "accessibility_check"
            | "accessibility_find_untagged"
            | "accessibility_fix"
            | "accessibility_figures"
            | "accessibility_set_alt"
            | "accessibility_tags"
            | "accessibility_tag_content"
            | "accessibility_set_tag_property"
            | "accessibility_mark_tag_artifact"
            | "accessibility_move_tag"
            | "pdfa_verify"
            | "print_readiness"
            | "pdfa_convert"
            | "doc_initial_view"
            | "doc_audit_space"
            | "doc_revisions"
            | "doc_flatten"
            | "xfa_to_static"
            | "edit_undo"
            | "edit_redo"
    )
}

pub fn embedded_tools() -> Vec<ToolDef> {
    tools()
        .into_iter()
        .filter(|tool| allowed(tool.name))
        .map(|mut tool| {
            // The shell binds the document, never the agent. Paths name inline assets only.
            if let Some(props) = tool.input_schema.get_mut("properties").and_then(Value::as_object_mut) {
                props.remove("doc");
                for key in ["path", "image", "file"] {
                    if let Some(property) = props.get_mut(key).filter(|property| property["type"] == "string") {
                        property["description"] = json!("Filename supplied in assets as base64. External filesystem paths are not supported.");
                    }
                }
            }
            if let Some(required) = tool.input_schema.get_mut("required").and_then(Value::as_array_mut) {
                required.retain(|value| value.as_str() != Some("doc"));
            }
            tool
        })
        .collect()
}

impl Automation {
    /// Temporarily borrow the *live* engine session; restoration also happens after an error
    /// or escaped panic. The GUI's undo history and revision identity are never replaced.
    pub fn call_in_session(
        session: &mut Session,
        id: DocId,
        name: &str,
        params: &Value,
        assets: HashMap<String, Vec<u8>>,
        read_only: bool,
    ) -> Result<Value> {
        let def = embedded_tools().into_iter().find(|tool| tool.name == name).ok_or_else(|| ToolError::UnknownTool(name.into()))?;
        if read_only && !def.read_only {
            return Err(failed("This command edits the document; use pdf_execute_command."));
        }
        crate::tools::check_args(&def, params)?;
        let mut args = params.as_object().cloned().ok_or_else(|| failed("params must be an object"))?;
        args.insert("doc".into(), json!(id.0));
        let mut runner = Self::new();
        runner.embedded_assets = Some(assets);
        std::mem::swap(&mut runner.session, session);
        let result = catch_unwind(AssertUnwindSafe(|| runner.call(name, &Value::Object(args))));
        std::mem::swap(&mut runner.session, session);
        let contents = result.map_err(|_| failed("The PDF edit could not be completed; the document is still open."))??;
        let mut results = contents.into_iter().filter_map(|content| match content {
            Content::Json(value) => Some(value),
            Content::Png { .. } => None,
        });
        Ok(results.next().unwrap_or(Value::Null))
    }

    /// Embedded paths are names of supplied bytes, never names on the user's computer.
    pub(crate) fn input_bytes(&self, name: &str) -> Result<(PathBuf, Vec<u8>)> {
        if let Some(assets) = &self.embedded_assets {
            let bytes = assets.get(name).ok_or_else(|| failed("Supply this filename in assets as base64; external files are not accessible."))?;
            return Ok((PathBuf::from(name), bytes.clone()));
        }
        let path = self.resolve(name, false)?;
        let bytes = std::fs::read(&path).map_err(|error| failed(format!("{}: {error}", path.display())))?;
        Ok((path, bytes))
    }

    pub(crate) fn input_reader(&self, name: &str) -> Result<Box<dyn std::io::Read>> {
        if self.embedded_assets.is_some() {
            return Ok(Box::new(std::io::Cursor::new(self.input_bytes(name)?.1)));
        }
        let path = self.resolve(name, false)?;
        Ok(Box::new(std::fs::File::open(&path).map_err(|error| failed(format!("{}: {error}", path.display())))?))
    }
}

/// Kept separate from the transport: both native and web entrypoints enforce these bounds.
pub fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        && name != "."
        && name != ".."
        && Path::new(name).file_name().is_some()
}
