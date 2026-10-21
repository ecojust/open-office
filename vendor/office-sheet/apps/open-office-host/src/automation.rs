//! Document-scoped automation shares the visible workbook and its undo history.
//! It never routes through shell actions, file pickers or programmatic UI dialogs.
use office_sheet_engine::{Session, UiRequest, cmd};
use serde_json::{Value, json};

use crate::document::Entry;

const QUERY_COMMANDS: &[&str] = &[
    "document.inspect",
    "cell.get",
    "selection.stats",
    "history.list",
    "arrange.selectionPane",
    "formulas.functions",
    "formulas.nameManager",
    "formulas.evaluate",
    "pivot.list",
    "pivot.fields",
    "data.queriesConnections",
];

fn allowed(id: &str) -> bool {
    cmd::find_command(id).is_some()
        && (!id.starts_with("file.") || id == "file.properties")
        && !["app.", "host.", "ui.", "window.", "help.", "options."].iter().any(|prefix| id.starts_with(prefix))
        && !matches!(
            id,
            "automate.runScript"
                | "view.newWindow"
                | "view.hideWindow"
                | "view.unhideWindow"
                | "view.switchWindows"
                | "view.arrangeAll"
                | "edit.beginEdit"
                | "formulas.insertFunction"
                | "formulas.useInFormula"
                | "link.open"
                | "home.addIns"
        )
}

pub(crate) fn list(session: &Session, params: &Value) -> Result<Value, String> {
    let search = params.get("search").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0).min(10000) as usize;
    let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(60).clamp(1, 100) as usize;
    let commands: Vec<_> = session
        .commands()
        .into_iter()
        .filter(|command| {
            allowed(command.id)
                && format!("{} {} {} {}", command.id, command.label, command.menu.join(" "), command.params).to_lowercase().contains(&search)
        })
        .collect();
    let total = commands.len();
    let page: Vec<_> = commands.into_iter().skip(offset).take(limit).collect();
    Ok(json!({"commands":page, "total":total, "offset":offset, "nextOffset":(offset + limit < total).then_some(offset + limit)}))
}

fn validate_params(params: &Value, depth: usize) -> Result<(), String> {
    if depth > 12 {
        return Err("命令参数嵌套过深。".into());
    }
    match params {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(key.as_str(), "path" | "outputPath" | "filePath" | "folder" | "__proto__" | "constructor" | "prototype") {
                    return Err("MCP 编辑命令不接受文件系统路径或对象原型字段。".into());
                }
                validate_params(value, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_params(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn execute(entry: &mut Entry, payload: &Value, query: bool) -> Result<Value, String> {
    let id = payload.get("command").and_then(Value::as_str).ok_or("缺少工作簿命令名称。")?;
    if !allowed(id) || (query && !QUERY_COMMANDS.contains(&id)) {
        return Err("此命令不属于当前工作簿允许的编辑或读取操作。".into());
    }
    let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err("命令参数必须是 JSON 对象。".into());
    }
    validate_params(&params, 0)?;
    // A single import must fit comfortably inside the transport's bounded request.
    if serde_json::to_vec(&params).map_err(|error| error.to_string())?.len() > 7 * 1024 * 1024 {
        return Err("命令参数不能超过 7 MiB，请分批操作。".into());
    }
    if id == "range.setValues" {
        let cells: usize =
            params.get("values").and_then(Value::as_array).map(|rows| rows.iter().filter_map(Value::as_array).map(Vec::len).sum()).unwrap_or(0);
        if cells > 10000 {
            return Err("单次最多写入 10000 个单元格，请分批操作。".into());
        }
    }
    // Deliberately execute the engine registry, not SheetApp::run: menu-only calls
    // may open a dialog. Consume all UI requests so automation cannot leave a modal
    // behind that blocks subsequent saving or editing.
    let before = entry.app.session.doc().map_err(|error| error.to_string())?.wb.clone();
    let result = entry.app.session.execute(id, params).map_err(|error| error.to_string());
    let requests = entry.app.session.take_ui_requests();
    let needs_input = requests.iter().any(|request| matches!(request, UiRequest::Dialog(..) | UiRequest::EditCell(..) | UiRequest::OpenUrl(..)));
    let changed = !std::sync::Arc::ptr_eq(&before, &entry.app.session.doc().map_err(|error| error.to_string())?.wb);
    entry.sync()?;
    if needs_input && !changed {
        let docs = cmd::find_command(id).map(|command| command.params).unwrap_or("");
        return Err(format!("此命令需要明确参数；MCP 不会打开对话框。参数：{docs}"));
    }
    let result = result?;
    if id == "insert.chart" {
        entry.app.selected_chart = result.get("chart").and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok());
    }
    Ok(result)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use office_sheet_ui_egui::Services;

    fn run(entry: &mut Entry, command: &str, params: Value) -> Value {
        execute(entry, &json!({"command":command,"params":params}), false).expect("document command")
    }

    #[test]
    fn editing_uses_one_visible_model_and_real_history() {
        let mut entry = Entry::new("test.xlsx", &[], 1, Services::default()).unwrap();
        run(&mut entry, "range.setValues", json!({"range":"A1","values":[["Name","Amount"],["A",10],["B",20],["Total","=SUM(B2:B3)"]]}));
        run(&mut entry, "home.bold", json!({"range":"A1:B1","on":true}));
        run(&mut entry, "home.fillColor", json!({"range":"A1:B1","color":"#DBEAFE"}));
        run(&mut entry, "insert.chart", json!({"range":"A1:B3","type":"column","title":"MCP chart","at":"D2"}));
        let chart = entry.app.selected_chart;
        assert!(chart.is_some());
        let detail = run(&mut entry, "cell.get", json!({"cell":"A1"}));
        assert_eq!(detail["style"]["font"]["bold"], true);
        assert_eq!(run(&mut entry, "cell.get", json!({"cell":"B4"}))["value"].as_f64(), Some(30.0));
        assert!(entry.dirty());
        assert!(entry.app.dialog.is_none());
        run(&mut entry, "home.insertRows", json!({"rows":"2:2"}));
        assert_eq!(run(&mut entry, "cell.get", json!({"cell":"B5"}))["value"].as_f64(), Some(30.0));
        run(&mut entry, "edit.undo", json!({}));
        assert_eq!(run(&mut entry, "cell.get", json!({"cell":"B4"}))["value"].as_f64(), Some(30.0));
        run(&mut entry, "home.insertSheet", json!({"name":"MCP Data"}));
        assert_eq!(entry.app.session.doc().unwrap().wb.sheets.len(), 2);
        run(&mut entry, "sheet.activate", json!({"sheet":0}));
        assert_eq!(entry.app.session.doc().unwrap().wb.active_sheet, 0);
        assert!(entry.export("xlsx").unwrap().len() > 100);
    }

    #[test]
    fn catalog_covers_document_commands_and_blocks_shell_bypasses() {
        let mut entry = Entry::new("test.xlsx", &[], 1, Services::default()).unwrap();
        for id in ["home.bold", "sheet.rename", "object.move", "insert.picture", "pageLayout.orientation", "data.sort", "review.newComment"] {
            assert!(allowed(id), "{id}");
        }
        for id in [
            "file.open",
            "file.close",
            "file.save",
            "automate.runScript",
            "window.activate",
            "host.deliverPicture",
            "ui.dialog",
            "formulas.insertFunction",
            "formulas.useInFormula",
        ] {
            assert!(!allowed(id), "{id}");
            assert!(execute(&mut entry, &json!({"command":id}), false).is_err());
        }
        assert!(execute(&mut entry, &json!({"command":"insert.picture","params":{"path":"/tmp/picture.png"}}), false).is_err());
        assert!(execute(&mut entry, &json!({"command":"home.bold"}), true).is_err());
        assert!(execute(&mut entry, &json!({"command":"insert.picture"}), false).unwrap_err().contains("参数"));
        assert!(entry.app.dialog.is_none() && entry.app.session.take_ui_requests().is_empty());
        assert!(list(&entry.app.session, &json!({"search":"font","limit":5})).unwrap()["total"].as_u64().unwrap() > 5);
    }
}
