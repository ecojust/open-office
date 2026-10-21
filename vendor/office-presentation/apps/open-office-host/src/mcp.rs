//! The active document's automation surface. File ownership stays with the shell.
use office_presentation_engine::cmd::{CommandSpec, command_specs, find_command, parse_params};
use serde_json::{Map, Value, json};

use crate::document::Entry;

fn allowed(id: &str) -> bool {
    (!id.starts_with("file.") || matches!(id, "file.properties" | "file.info" | "file.templates" | "file.render"))
        && !["window.", "app.", "ui.", "host."].iter().any(|prefix| id.starts_with(prefix))
        && !matches!(
            id,
            "commands.list" | "review.addToDictionary" | "review.dictionary" | "show.fromStart" | "show.fromCurrent" | "text.compose" | "text.commit"
        )
}

fn specification(id: &str) -> Result<&'static CommandSpec, String> {
    find_command(id).filter(|spec| allowed(spec.id)).ok_or_else(|| "此命令不属于当前演示文稿的 MCP 编辑接口，请先查询命令列表。".into())
}

fn geometry_path(id: &str) -> bool {
    matches!(id, "shape.movePoint" | "shape.addPoint" | "shape.deletePoint" | "shape.pointType" | "shape.moveHandle")
}

fn describe(entry: &Entry, spec: &CommandSpec) -> Value {
    let parameters: Vec<Value> = parse_params(spec.params)
        .unwrap_or_default()
        .into_iter()
        .filter(|param| !(param.name == "path" && !geometry_path(spec.id)) && !matches!(param.name, "outputPath" | "filePath" | "folder"))
        .map(|param| json!({"name":param.name,"optional":param.optional,"description":param.about,"alternative":param.or,"group":param.object}))
        .collect();
    let properties: Map<String, Value> = parameters
        .iter()
        .filter_map(|parameter| {
            let name = parameter.get("name")?.as_str()?;
            let description = parameter.get("description").and_then(Value::as_str).unwrap_or("");
            let schema = if name == "path" && geometry_path(spec.id) {
                json!({"type":"integer","minimum":0,"description":"形状的子路径索引，从 0 开始。"})
            } else {
                json!({"description":description})
            };
            Some((name.into(), schema))
        })
        .collect();
    json!({"id":spec.id,"label":spec.label,"menu":spec.menu,"parameters":parameters,
        "params":spec.params,"enabled":(spec.enabled)(&entry.app.session).is_ok(),
        "readOnly":!spec.journal,"undoable":spec.undoable,"actsOn":spec.acts_on(),
        "inputSchema":{"type":"object","properties":properties,"additionalProperties":false},
        "usage":"页码索引从 0 开始，位置和尺寸以 pt 为单位。图片、音频、视频、主题和模板使用 data/base64 参数，不接受本机路径。参数类型和可选值见 params；需要选区的命令可先使用 slide.go、edit.select、text.edit。"})
}

fn check_value(value: &Value, depth: usize, allow_geometry_path: bool) -> Result<(), String> {
    if depth > 24 {
        return Err("命令参数嵌套过深。".into());
    }
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if key == "path" && depth == 0 && allow_geometry_path && value.as_u64().is_some() {
                    continue;
                }
                if matches!(key.as_str(), "path" | "outputPath" | "filePath" | "folder" | "__proto__" | "prototype" | "constructor") {
                    return Err("MCP 编辑仅接受文档内容和内嵌媒体，不接受文件系统路径或原型字段。".into());
                }
                check_value(value, depth + 1, allow_geometry_path)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                check_value(value, depth + 1, allow_geometry_path)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn check_edit_fields(command: &str, params: &Value) -> Result<(), String> {
    let fields: &[&str] = match command {
        "design.colors" => &["name", "colors"],
        "design.fonts" => &["name", "major", "minor"],
        "insert.photoAlbum" | "insert.photoAlbumEdit" => &["pictures"],
        "insert.dateTime" => &["format", "update", "language"],
        "shape.sizePosition" => &["x", "y", "w", "h", "rot", "scaleW", "scaleH"],
        "format.fontDialog" => &["family", "size", "bold", "italic", "underline", "color", "strike", "baseline", "caps", "spacing"],
        "format.paragraphDialog" => &[
            "align",
            "indentLeft",
            "indentRight",
            "indentFirst",
            "special",
            "specialBy",
            "spaceBefore",
            "spaceAfter",
            "lineSpacing",
            "lineSpacingPt",
        ],
        "format.tabs" => {
            if params.get("clear").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            &["set", "add", "move", "remove", "defaultTab"]
        }
        _ => return Ok(()),
    };
    if !fields.iter().any(|field| params.get(*field).is_some_and(|value| !value.is_null())) {
        return Err(format!("请提供编辑属性（{}）；MCP 不打开手工编辑对话框。", fields.join("、")));
    }
    Ok(())
}

pub(crate) fn run(entry: &mut Entry, action: &str, args: &Value) -> Result<Value, String> {
    if action == "mcp.list" {
        let filter = args.get("filter").and_then(Value::as_str).unwrap_or("").to_lowercase();
        return Ok(json!({"commands":command_specs().iter().filter(|spec| allowed(spec.id))
            .filter(|spec| filter.is_empty() || spec.id.to_lowercase().contains(&filter) || spec.label.to_lowercase().contains(&filter) || spec.menu.join(" ").to_lowercase().contains(&filter))
            .map(|spec| describe(entry, spec)).collect::<Vec<_>>()}));
    }
    let command = args.get("command").and_then(Value::as_str).ok_or("请指定 command。")?;
    let spec = specification(command)?;
    if action == "mcp.describe" {
        return Ok(describe(entry, spec));
    }
    if !matches!(action, "mcp.execute" | "mcp.query") {
        return Err("未知 MCP 操作。".into());
    }
    if action == "mcp.query" && spec.journal {
        return Err("此命令会修改文档或选区，请使用编辑工具。".into());
    }
    let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err("params 必须是对象。".into());
    }
    check_value(&params, 0, geometry_path(command))?;
    check_edit_fields(command, &params)?;
    if command == "shape.rotate" && params.get("gesture").and_then(Value::as_str) == Some("move") {
        return Err("请通过 deg 或 by 完成一次旋转，MCP 不保留未完成的手势。".into());
    }
    if action == "mcp.execute" && entry.app.dialog.is_some() {
        return Err("请先完成当前演示文稿中的对话框。".into());
    }
    if command == "template.applyBytes" {
        return entry.apply_template(params);
    }
    // The engine's private clipboard can be reused without requesting the OS clipboard.
    if matches!(command, "edit.copy" | "edit.cut" | "edit.paste" | "edit.pasteSpecial" | "edit.pasteText") {
        return entry.app.session.execute(command, &params).map_err(|error| error.to_string());
    }
    let had_dialog = entry.app.dialog.is_some();
    let result = entry.app.run(command, params);
    if !had_dialog && entry.app.dialog.is_some() {
        entry.app.dialog = None;
        return Err("请提供命令的编辑参数；MCP 已取消空操作打开的对话框，文档仍可继续编辑。".into());
    }
    result
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use office_presentation_ui_egui::Services;

    fn entry() -> Entry {
        Entry::new("测试.pptx", &[], 1, Services { embedded_editor: true, ..Services::default() }).unwrap()
    }

    #[test]
    fn exposes_real_editing_catalog_and_rejects_other_workspaces() {
        let mut entry = entry();
        let result = run(&mut entry, "mcp.list", &json!({})).unwrap();
        let commands = result["commands"].as_array().unwrap();
        assert!(commands.len() > 150);
        for id in [
            "text.set",
            "shape.fill",
            "shape.setBounds",
            "table.insertRowAbove",
            "animation.set",
            "transition.set",
            "design.theme",
            "template.applyBytes",
        ] {
            assert!(commands.iter().any(|command| command["id"] == id), "missing {id}");
        }
        for id in ["file.open", "file.close", "file.save", "window.next", "app.dialog", "review.addToDictionary"] {
            assert!(run(&mut entry, "mcp.execute", &json!({"command":id})).is_err(), "allowed {id}");
        }
        assert!(run(&mut entry, "mcp.query", &json!({"command":"slide.delete"})).is_err());
        assert!(run(&mut entry, "mcp.query", &json!({"command":"text.compose","params":{"text":"unfinished"}})).is_err());
        assert!(run(&mut entry, "mcp.execute", &json!({"command":"insert.picture","params":{"path":"/tmp/image.png"}})).is_err());
        assert!(run(&mut entry, "mcp.execute", &json!({"command":"insert.photoAlbum","params":{"pictures":[{"path":"/tmp/image.png"}]}})).is_err());
        assert!(run(&mut entry, "mcp.execute", &json!({"command":"design.colors"})).is_err());
        assert!(run(&mut entry, "mcp.execute", &json!({"command":"shape.rotate","params":{"by":15,"gesture":"move"}})).is_err());
        assert!(entry.app.dialog.is_none());
    }

    #[test]
    fn editing_uses_current_document_history_and_shape_ids() {
        let mut entry = entry();
        run(&mut entry, "mcp.execute", &json!({"command":"slide.go","params":{"index":0}})).unwrap();
        let shape =
            run(&mut entry, "mcp.execute", &json!({"command":"shape.insert","params":{"preset":"rect","rect":[40,60,200,80],"text":"before"}}))
                .unwrap();
        let id = shape["id"].as_u64().unwrap();
        run(&mut entry, "mcp.execute", &json!({"command":"text.set","params":{"id":id,"text":"after"}})).unwrap();
        run(&mut entry, "mcp.execute", &json!({"command":"shape.fill","params":{"ids":[id],"color":"FF8800"}})).unwrap();
        entry.sync().unwrap();
        assert!(entry.dirty());
        assert!(entry.revision > 1);
        let result = run(&mut entry, "mcp.query", &json!({"command":"text.get","params":{"id":id}})).unwrap();
        assert_eq!(result["text"], "after");
        run(&mut entry, "mcp.execute", &json!({"command":"edit.undo"})).unwrap();
        run(&mut entry, "mcp.execute", &json!({"command":"edit.undo"})).unwrap();
        let result = run(&mut entry, "mcp.query", &json!({"command":"text.get","params":{"id":id}})).unwrap();
        assert_eq!(result["text"], "before");
    }

    #[test]
    fn geometric_subpath_indices_are_discoverable_and_editable() {
        let mut entry = entry();
        for command in ["shape.movePoint", "shape.addPoint", "shape.deletePoint", "shape.pointType", "shape.moveHandle"] {
            let description = run(&mut entry, "mcp.describe", &json!({"command":command})).unwrap();
            assert_eq!(description["inputSchema"]["properties"]["path"]["type"], "integer");
            assert!(description["parameters"].as_array().unwrap().iter().any(|parameter| parameter["name"] == "path"));
        }
        let shape = run(
            &mut entry,
            "mcp.execute",
            &json!({"command":"shape.freeform","params":{
                "points":[[10,10],[100,10],[100,80],[10,80]],"closed":true
            }}),
        )
        .unwrap();
        let id = shape["id"].as_u64().unwrap();
        run(
            &mut entry,
            "mcp.execute",
            &json!({"command":"shape.movePoint","params":{
                "id":id,"path":0,"index":1,"x":120,"y":10
            }}),
        )
        .unwrap();
        let points = run(&mut entry, "mcp.query", &json!({"command":"shape.points","params":{"id":id}})).unwrap();
        assert_eq!(points["paths"][0][1], json!([120.0, 10.0]));
        for path in [json!("/tmp/shape.svg"), json!(-1), json!(0.5)] {
            assert!(
                run(
                    &mut entry,
                    "mcp.execute",
                    &json!({"command":"shape.movePoint","params":{
                        "id":id,"path":path,"index":1,"x":150,"y":10
                    }})
                )
                .is_err()
            );
        }
        assert!(run(&mut entry, "mcp.execute", &json!({"command":"insert.picture","params":{"path":0}})).is_err());
        assert!(check_value(&json!({"nested":{"path":0}}), 0, true).is_err());
    }
}
