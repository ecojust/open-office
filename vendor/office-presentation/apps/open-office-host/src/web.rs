use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use js_sys::{Function, Promise, Uint8Array};
use office_presentation_ui_egui::{Inbox, InboxEvent, InboxFile, Services};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::document::{Entry, clean_error};

const MAX_SESSIONS: usize = 8;
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_PARAMS_BYTES: usize = 96 * 1024 * 1024;
type PictureInbox = Inbox;

struct FlushWaiter {
    session_id: String,
    resolve: Function,
    reject: Function,
}

struct State {
    entries: BTreeMap<String, Entry>,
    pictures: BTreeMap<String, PictureInbox>,
    active: Option<String>,
    enabled: bool,
    theme: String,
    drain_input: bool,
    destroyed: bool,
    started: bool,
    next_document_id: u32,
    ctx: Option<egui::Context>,
    callback: Function,
    actions: Rc<RefCell<Vec<Value>>>,
    waiters: Vec<FlushWaiter>,
}

impl State {
    fn entry_mut(&mut self, id: &str) -> Result<&mut Entry, JsValue> {
        if self.destroyed {
            return Err(js_error("editor host is destroyed"));
        }
        self.entries.get_mut(id).ok_or_else(|| js_error("unknown editor session"))
    }

    fn snapshot(&mut self, id: &str) -> Result<Value, JsValue> {
        let ctx = if self.active.as_deref() == Some(id) { self.ctx.clone() } else { None };
        self.entry_mut(id)?.snapshot(id, ctx.as_ref()).map_err(js_error)
    }

    fn repaint(&self) {
        if let Some(ctx) = &self.ctx {
            ctx.request_repaint();
        }
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&clean_error(error))
}
fn json_string(value: &Value) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(js_error)
}

fn host_action(id: &str) -> Option<&'static str> {
    match id {
        "host.pasteClipboard" => Some("pasteClipboard"),
        "host.toggleTemplates" => Some("toggleTemplates"),
        "file.new" => Some("new"),
        "file.open" | "ui.openFileDialog" | "app.openDialog" | "app.home" => Some("open"),
        "file.save" => Some("save"),
        "file.saveAs" | "app.saveAsDialog" => Some("saveAs"),
        "file.exportPdf" | "app.exportDialog" => Some("exportPdf"),
        "file.close" => Some("close"),
        "file.print" | "ui.printSubmit" | "app.print" => Some("print"),
        _ => None,
    }
}

fn shell_policy(id: &str, params: &Value) -> Option<Result<Value, String>> {
    if (id.starts_with("file.") && !matches!(id, "file.properties" | "file.info" | "file.render" | "file.templates"))
        || id.starts_with("window.")
        || matches!(
            id,
            "view.newWindow"
                | "view.hideWindow"
                | "view.unhideWindow"
                | "automate.runScript"
                | "app.quit"
                | "app.about"
                | "app.contributors"
                | "view.dark"
                | "view.brightness"
        )
    {
        return Some(Err("此操作由 Open Office 文件工作区管理。".into()));
    }
    if params.as_object().is_some_and(|object| {
        object.iter().any(|(key, value)| value.is_string() && matches!(key.as_str(), "path" | "outputPath" | "filePath" | "folder"))
    }) {
        return Some(Err("请使用 Open Office 文件选择器和文件字节，不接受文件系统路径。".into()));
    }
    None
}

fn services(session_id: &str, actions: Rc<RefCell<Vec<Value>>>, picture: PictureInbox) -> Services {
    let action_id = session_id.to_owned();
    let command_actions = actions.clone();
    let picture_id = session_id.to_owned();
    Services {
        embedded_editor: true,
        host_command: Some(Box::new(move |id, params| {
            if let Some(action) = if id == "edit.paste" && params.as_object().is_some_and(|params| params.is_empty()) {
                Some("pasteClipboard")
            } else {
                host_action(id)
            } {
                if let Ok(mut queue) = command_actions.try_borrow_mut() {
                    queue.push(json!({"type":"action","sessionId":action_id,"action":action}));
                    return Some(Ok(json!({"pending":"host","action":action})));
                }
                return Some(Err("host action queue is busy".into()));
            }
            shell_policy(id, params)
        })),
        open_async: Some(Box::new(move |purpose, request| {
            if let Ok(mut queue) = actions.try_borrow_mut() {
                queue.push(json!({"type":"action","sessionId":picture_id,"action":"pickFile","purpose":purpose,"requestId":request}));
            }
        })),
        inbox: Some(picture),
        clipboard_set_html: Some(Box::new(|html, text| copy_html(html, text).is_ok())),
        // No downloader, presentation inbox or native file service: export never acknowledges save.
        ..Services::default()
    }
}

#[wasm_bindgen]
pub struct OfficePresentationHost {
    state: Rc<RefCell<State>>,
    runner: eframe::WebRunner,
}

#[wasm_bindgen(js_name = createHost)]
pub fn create_host(callback: Function) -> OfficePresentationHost {
    OfficePresentationHost {
        state: Rc::new(RefCell::new(State {
            entries: BTreeMap::new(),
            pictures: BTreeMap::new(),
            active: None,
            enabled: true,
            theme: "system".into(),
            drain_input: false,
            destroyed: false,
            started: false,
            next_document_id: 1,
            ctx: None,
            callback,
            actions: Rc::new(RefCell::new(Vec::new())),
            waiters: Vec::new(),
        })),
        runner: eframe::WebRunner::new(),
    }
}

#[wasm_bindgen]
impl OfficePresentationHost {
    /// Parsing completes before inserting a session; failed imports never replace an open tab.
    pub fn prepare(&self, id: &str, name: &str, bytes: &[u8]) -> Result<String, JsValue> {
        if id.is_empty() || id.len() > 256 || name.len() > 4096 || bytes.len() > MAX_INPUT_BYTES {
            return Err(js_error("invalid session/name or presentation exceeds the 64 MiB import limit"));
        }
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed {
            return Err(js_error("editor host is destroyed"));
        }
        if state.entries.contains_key(id) {
            return Err(js_error("editor session already exists"));
        }
        if state.entries.len() >= MAX_SESSIONS {
            return Err(js_error("at most eight presentation sessions may be open"));
        }
        let picture: PictureInbox = Inbox::default();
        let document_id = state.next_document_id;
        let next_document_id = document_id.checked_add(1).ok_or_else(|| js_error("document identifiers exhausted"))?;
        let mut entry = Entry::new(name, bytes, document_id, services(id, state.actions.clone(), picture.clone())).map_err(js_error)?;
        entry.app.set_host_theme(&state.theme, state.ctx.as_ref()).map_err(js_error)?;
        let snapshot = entry.snapshot(id, None).map_err(js_error)?;
        state.next_document_id = next_document_id;
        state.entries.insert(id.to_owned(), entry);
        state.pictures.insert(id.to_owned(), picture);
        json_string(&snapshot)
    }

    pub async fn start(&self, canvas: web_sys::HtmlCanvasElement) -> Result<(), JsValue> {
        {
            let mut state = self.state.try_borrow_mut().map_err(js_error)?;
            if state.destroyed || state.started {
                return Err(js_error("editor host is already started or destroyed"));
            }
            state.started = true;
        }
        let shared = self.state.clone();
        let result = self
            .runner
            .start(
                canvas,
                eframe::WebOptions::default(),
                Box::new(move |creation| {
                    if let Ok(mut state) = shared.try_borrow_mut() {
                        state.ctx = Some(creation.egui_ctx.clone());
                    }
                    Ok(Box::new(HostApp { state: shared }))
                }),
            )
            .await;
        if self.state.try_borrow().map_err(js_error)?.destroyed {
            self.runner.destroy();
        }
        if result.is_err() {
            self.runner.destroy();
            if let Ok(mut state) = self.state.try_borrow_mut() {
                state.started = false;
                state.ctx = None;
            }
        }
        result
    }

    pub fn activate(&self, id: &str) -> Result<String, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        state.entry_mut(id)?;
        if state.active.as_deref() != Some(id) {
            if !state.waiters.is_empty() {
                return Err(js_error("flush the previous tab before activating another session"));
            }
            if state.active.as_ref().and_then(|id| state.entries.get(id)).is_some_and(|entry| entry.app.has_pending_input()) {
                return Err(js_error("flush pending input before activating another session"));
            }
            if let Some(ctx) = state.ctx.clone() {
                if let Some(previous) = state.active.clone().and_then(|id| state.entries.get_mut(&id)) {
                    previous.memory = Some(ctx.memory(Clone::clone));
                }
                let memory = state.entry_mut(id)?.memory.clone().unwrap_or_default();
                ctx.memory_mut(|current| *current = memory);
                let theme = state.theme.clone();
                state.entry_mut(id)?.app.set_host_theme(&theme, Some(&ctx)).map_err(js_error)?;
            }
            state.entry_mut(id)?.app.activate_host_context();
            state.active = Some(id.to_owned());
        }
        state.repaint();
        json_string(&state.snapshot(id)?)
    }

    pub fn inspect(&self, id: &str) -> Result<String, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        json_string(&state.snapshot(id)?)
    }

    /// Appearance belongs to the shell, including sessions that are not currently mounted.
    #[wasm_bindgen(js_name = setTheme)]
    pub fn set_theme(&self, mode: &str) -> Result<(), JsValue> {
        if !matches!(mode, "light" | "dark" | "system") {
            return Err(js_error("theme mode must be system, light, or dark"));
        }
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed {
            return Err(js_error("editor host is destroyed"));
        }
        state.theme = mode.into();
        let ctx = state.ctx.clone();
        for entry in state.entries.values_mut() {
            entry.app.set_host_theme(mode, ctx.as_ref()).map_err(js_error)?;
        }
        if let Some(ctx) = &state.ctx {
            ctx.set_theme(match mode {
                "dark" => egui::ThemePreference::Dark,
                "light" => egui::ThemePreference::Light,
                _ => egui::ThemePreference::System,
            });
        }
        state.repaint();
        Ok(())
    }

    pub fn command(&self, id: &str, command_id: &str, params_json: &str) -> Result<String, JsValue> {
        if params_json.len() > MAX_PARAMS_BYTES {
            return Err(js_error("command payload exceeds the size limit"));
        }
        let params: Value = serde_json::from_str(params_json).map_err(js_error)?;
        if !params.is_object() {
            return Err(js_error("command parameters must be a JSON object"));
        }
        let response = {
            let mut state = self.state.try_borrow_mut().map_err(js_error)?;
            let is_active = state.active.as_deref() == Some(id);
            if (command_id.starts_with("ui.") || command_id.starts_with("show.")) && !is_active {
                return Err(js_error("请先切换到此演示文稿，再执行界面操作。"));
            }
            let ctx = if is_active { state.ctx.clone() } else { None };
            let picture = state.pictures.get(id).cloned();
            let entry = state.entry_mut(id)?;
            entry.sync().map_err(js_error)?;
            let result = match command_id {
                "mcp.list" | "mcp.describe" | "mcp.query" | "mcp.execute" => crate::mcp::run(entry, command_id, &params),
                "template.applyBytes" => entry.apply_template(params),
                "host.cancelPicture" | "host.cancelFile" => cancel_file(picture, &params),
                "host.deliverPicture" | "host.deliverFile" => deliver_file(&entry.app, picture, &params),
                "ui.inspect" | "ui.text" | "ui.ime" | "ui.key" | "ui.click" | "ui.move" | "ui.drag" | "ui.pointer" | "ui.tool.select" | "ui.set"
                | "ui.dialog.close" | "show.start" | "show.end" | "show.key" => {
                    if let Some(ctx) = ctx {
                        if command_id == "ui.set" && params.get("dark").is_some() {
                            Err("界面外观由 Open Office 全局设置管理。".into())
                        } else {
                            let (request, _receiver) = office_presentation_ui_egui::ControlRequest::new(command_id, params.clone());
                            match office_presentation_ui_egui::control::handle(&mut entry.app, &ctx, &request) {
                                office_presentation_ui_egui::control::Outcome::Done(value) => {
                                    if value.get("ok").and_then(Value::as_bool) == Some(true) {
                                        Ok(value.get("result").cloned().unwrap_or(Value::Null))
                                    } else {
                                        Err(value.get("error").and_then(Value::as_str).unwrap_or("UI command failed").to_owned())
                                    }
                                }
                                _ => Err("this UI command requires a browser screenshot".into()),
                            }
                        }
                    } else {
                        Err("editor canvas is not active".into())
                    }
                }
                _ => entry.app.run(command_id, params).map_err(clean_error),
            };
            let snapshot = state.snapshot(id)?;
            state.repaint();
            match result {
                Ok(result) => json!({"ok":true,"result":result,"snapshot":snapshot}),
                Err(error) => json!({"ok":false,"error":clean_error(error),"snapshot":snapshot}),
            }
        };
        dispatch_actions(&self.state);
        json_string(&response)
    }

    #[wasm_bindgen(js_name = exportFile)]
    pub fn export_file(&self, id: &str, format: &str) -> Result<Uint8Array, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Err(js_error("await flush before exporting"));
        }
        let bytes = state.entry_mut(id)?.export(format).map_err(js_error)?;
        Ok(Uint8Array::from(bytes.as_slice()))
    }

    /// Wait for one rendered input batch, then commit the current speaker-notes draft.
    pub fn flush(&self, id: &str) -> Result<Promise, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        state.entry_mut(id)?;
        if !state.started || state.active.as_deref() != Some(id) {
            state.entry_mut(id)?.commit_pending().map_err(js_error)?;
            return Ok(Promise::resolve(&JsValue::UNDEFINED));
        }
        let promise = Promise::new(&mut |resolve, reject| {
            state.waiters.push(FlushWaiter { session_id: id.to_owned(), resolve, reject });
        });
        state.repaint();
        Ok(promise)
    }

    #[wasm_bindgen(js_name = markSaved)]
    pub fn mark_saved(&self, id: &str, document_id: f64, revision: f64) -> Result<bool, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Ok(false);
        }
        let saved = state.entry_mut(id)?.mark_saved(document_id, revision).map_err(js_error)?;
        state.repaint();
        Ok(saved)
    }

    #[wasm_bindgen(js_name = discardChanges)]
    pub fn discard_changes(&self, id: &str, document_id: f64, revision: f64) -> Result<bool, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Ok(false);
        }
        let discarded = state.entry_mut(id)?.discard(document_id, revision).map_err(js_error)?;
        state.repaint();
        Ok(discarded)
    }

    pub fn close(&self, id: &str, document_id: f64, revision: f64, force: bool) -> Result<bool, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Ok(false);
        }
        let entry = state.entry_mut(id)?;
        if !entry.can_close(document_id, revision, force).map_err(js_error)? {
            return Ok(false);
        }
        state.entries.remove(id);
        state.pictures.remove(id);
        if state.active.as_deref() == Some(id) {
            state.active = None;
        }
        state.repaint();
        Ok(true)
    }

    #[wasm_bindgen(js_name = setActive)]
    pub fn set_active(&self, active: bool) -> Result<(), JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed {
            return Err(js_error("editor host is destroyed"));
        }
        if state.enabled && !active {
            state.drain_input = true;
        }
        state.enabled = active;
        state.repaint();
        Ok(())
    }

    pub fn destroy(&self) {
        self.runner.destroy();
        let waiters = if let Ok(mut state) = self.state.try_borrow_mut() {
            state.destroyed = true;
            state.started = false;
            state.ctx = None;
            state.entries.clear();
            state.pictures.clear();
            state.active = None;
            std::mem::take(&mut state.waiters)
        } else {
            Vec::new()
        };
        for waiter in waiters {
            let _ = waiter.reject.call1(&JsValue::UNDEFINED, &js_error("editor host destroyed before input was flushed"));
        }
    }
}

fn request_id(params: &Value) -> Result<u64, String> {
    params.get("requestId").and_then(Value::as_u64).ok_or_else(|| "missing file request identity".into())
}
fn cancel_file(inbox: Option<PictureInbox>, params: &Value) -> Result<Value, String> {
    let request = request_id(params)?;
    let inbox = inbox.ok_or("file request is no longer active")?;
    inbox.lock().map_err(|_| "file inbox is unavailable")?.push(InboxEvent::Cancelled { id: request });
    Ok(json!({"cancelled":true}))
}
fn deliver_file(app: &office_presentation_ui_egui::SlideApp, inbox: Option<PictureInbox>, params: &Value) -> Result<Value, String> {
    let request = request_id(params)?;
    let data = params.get("data").and_then(Value::as_str).ok_or("picked files require base64 byte data")?;
    if data.len() > 44 * 1024 * 1024 {
        return Err("插入的媒体不能超过 32 MiB。".into());
    }
    let bytes = office_presentation_engine::cmd::base64_decode(data).ok_or("invalid file base64")?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("插入的媒体不能超过 32 MiB。".into());
    }
    let name = params.get("name").and_then(Value::as_str).ok_or("picked file requires a name")?;
    app.validate_host_file(request, name, &bytes)?;
    let inbox = inbox.ok_or("file request is no longer active")?;
    inbox.lock().map_err(|_| "file inbox is unavailable")?.push(InboxEvent::File(InboxFile { id: request, name: name.into(), bytes }));
    Ok(json!({"delivered":true}))
}

struct HostApp {
    state: Rc<RefCell<State>>,
}

impl eframe::App for HostApp {
    fn as_any_mut(&mut self) -> Option<&mut dyn std::any::Any> {
        Some(self)
    }

    fn raw_input_hook(&mut self, _ctx: &egui::Context, raw: &mut egui::RawInput) {
        if let Ok(mut state) = self.state.try_borrow_mut() {
            if !state.enabled && !state.drain_input {
                // Composition may finish after blur; preserve its final text while blocking
                // unrelated keyboard/pointer input in inactive shell tabs.
                raw.events.retain(|event| matches!(event, egui::Event::Ime(_)));
            }
            raw.dropped_files.clear();
            raw.hovered_files.clear();
            if let Some(entry) = state.active.clone().and_then(|id| state.entries.get_mut(&id)) {
                entry.app.raw_input_hook(raw);
            }
        }
    }

    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Ok(mut state) = self.state.try_borrow_mut() {
            ctx.input_mut(|input| input.raw.dropped_files.clear());
            let theme = state.theme.clone();
            if let Some(entry) = state.active.clone().and_then(|id| state.entries.get_mut(&id)) {
                let _ = entry.app.set_host_theme(&theme, Some(ctx));
                entry.app.logic(ctx);
            }
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let (notices, completions, callback) = {
            let Ok(mut state) = self.state.try_borrow_mut() else { return };
            let mut notices = Vec::new();
            let mut completions = Vec::new();
            let active = state.active.clone();
            let flushing = state.waiters.iter().any(|waiter| Some(&waiter.session_id) == active.as_ref());
            let mut flush_result: Result<(), String> = Ok(());
            let mut pending_input = false;
            if let Some(id) = &active
                && let Some(entry) = state.entries.get_mut(id)
            {
                entry.app.ui(ui);
                pending_input = entry.app.has_pending_input();
                if flushing && !pending_input {
                    flush_result = entry.commit_pending();
                }
                if let Err(error) = entry.sync() {
                    notices.push(json!({"type":"error","sessionId":id,"error":error}));
                }
                let signature = json!([
                    entry.revision,
                    entry.dirty(),
                    entry.app.show.as_ref().map(|show| (show.state.slide, show.state.step, show.ended)),
                    entry.app.session.active().map(|doc| (&doc.selection, doc.history.undo.len(), doc.history.redo.len(), doc.selection.slide))
                ])
                .to_string();
                if signature != entry.notified {
                    entry.notified = signature;
                    if let Ok(snapshot) = entry.snapshot(id, Some(ui.ctx())) {
                        notices.push(json!({"type":"change","sessionId":id,"snapshot":snapshot}));
                    }
                }
            }
            for waiter in std::mem::take(&mut state.waiters) {
                if pending_input && active.as_deref() == Some(&waiter.session_id) {
                    state.waiters.push(waiter);
                    continue;
                }
                let result = if active.as_deref() == Some(&waiter.session_id) {
                    flush_result.clone()
                } else {
                    Err("the session changed before its input was flushed".into())
                };
                completions.push((waiter, result));
            }
            if pending_input {
                state.repaint();
            }
            state.drain_input = false;
            (notices, completions, state.callback.clone())
        };
        for notice in notices {
            notify(&callback, &notice);
        }
        dispatch_actions(&self.state);
        for (waiter, result) in completions {
            match result {
                Ok(()) => {
                    let _ = waiter.resolve.call0(&JsValue::UNDEFINED);
                }
                Err(error) => {
                    let _ = waiter.reject.call1(&JsValue::UNDEFINED, &js_error(error));
                }
            }
        }
    }
}

fn notify(callback: &Function, event: &Value) {
    if let Ok(json) = serde_json::to_string(event) {
        let callback = callback.clone();
        // Defer beyond eframe's RefCell borrow; callbacks can close the final tab and destroy it.
        wasm_bindgen_futures::spawn_local(async move {
            let _ = callback.call1(&JsValue::UNDEFINED, &JsValue::from_str(&json));
        });
    }
}

fn dispatch_actions(shared: &Rc<RefCell<State>>) {
    let (actions, callback) = {
        let Ok(mut state) = shared.try_borrow_mut() else { return };
        let queue = state.actions.clone();
        let Ok(mut queue) = queue.try_borrow_mut() else { return };
        let mut actions = std::mem::take(&mut *queue);
        for action in &mut actions {
            if let Some(id) = action.get("sessionId").and_then(Value::as_str).map(str::to_owned)
                && let Some(entry) = state.entries.get_mut(&id)
            {
                let _ = entry.sync();
                action["revision"] = json!(entry.revision);
                action["documentId"] = json!(entry.document_id);
                action["selection"] = json!(entry.app.session.active().map(|doc| &doc.selection));
            }
        }
        (actions, state.callback.clone())
    };
    for action in actions {
        if action.get("action").and_then(Value::as_str) == Some("pasteClipboard") {
            paste_clipboard(shared, action);
        } else {
            notify(&callback, &action);
        }
    }
}

/// Read the current system clipboard for ribbon/menu Paste. An unavailable/denied clipboard
/// reports an error instead of falling back to an older internally copied range.
fn paste_clipboard(shared: &Rc<RefCell<State>>, receipt: Value) {
    let weak = Rc::downgrade(shared);
    wasm_bindgen_futures::spawn_local(async move {
        let content = read_clipboard().await;
        let Some(shared) = weak.upgrade() else { return };
        let Some(id) = receipt.get("sessionId").and_then(Value::as_str) else { return };
        let notice = {
            let Ok(mut state) = shared.try_borrow_mut() else { return };
            if state.destroyed {
                return;
            }
            let callback = state.callback.clone();
            let result = (|| -> Result<Value, String> {
                if state.active.as_deref() != Some(id) || !state.enabled {
                    return Err("读取剪贴板期间已切换演示文稿，粘贴已取消。".into());
                }
                let entry = state.entries.get_mut(id).ok_or("演示文稿已关闭，粘贴已取消。")?;
                if entry.app.dialog.is_some() || entry.app.palette.is_some() {
                    return Err("读取剪贴板期间已打开其他编辑操作，请完成后重新粘贴。".into());
                }
                entry.sync()?;
                let document_id = receipt.get("documentId").and_then(Value::as_f64).ok_or("missing clipboard receipt")?;
                let revision = receipt.get("revision").and_then(Value::as_f64).ok_or("missing clipboard revision")?;
                let selection = json!(entry.app.session.active().map(|doc| &doc.selection));
                if !entry.matches(document_id, revision) || receipt.get("selection") != Some(&selection) {
                    return Err("读取剪贴板期间内容或选区已有变化，请重新粘贴。".into());
                }
                let (text, html) = content?;
                entry.commit_pending()?;
                let mut params = json!({"text":text});
                if let Some(html) = html {
                    params["html"] = json!(html);
                }
                entry.app.run("edit.paste", params).map_err(clean_error)?;
                entry.snapshot(id, None)
            })();
            state.repaint();
            let event = match result {
                Ok(snapshot) => json!({"type":"change","sessionId":id,"snapshot":snapshot}),
                Err(error) => json!({"type":"error","sessionId":id,"error":error}),
            };
            (callback, event)
        };
        notify(&notice.0, &notice.1);
    });
}

async fn clipboard_flavor(item: &web_sys::ClipboardItem, mime: &str) -> Result<Option<String>, String> {
    if !item.types().iter().any(|kind| kind.as_string().as_deref() == Some(mime)) {
        return Ok(None);
    }
    let blob = wasm_bindgen_futures::JsFuture::from(item.get_type(mime))
        .await
        .map_err(|_| "无法读取剪贴板内容。")?
        .dyn_into::<web_sys::Blob>()
        .map_err(|_| "剪贴板格式无效。")?;
    if blob.size() > 8.0 * 1024.0 * 1024.0 {
        return Err("单次粘贴不能超过 8 MiB。".into());
    }
    wasm_bindgen_futures::JsFuture::from(blob.text())
        .await
        .map_err(|_| "无法读取剪贴板文本。")?
        .as_string()
        .map(Some)
        .ok_or_else(|| "剪贴板没有可读取的文本。".into())
}

async fn read_clipboard() -> Result<(String, Option<String>), String> {
    let window = web_sys::window().ok_or("当前环境无法访问剪贴板。")?;
    let clipboard = window.navigator().clipboard();
    if clipboard.is_undefined() || clipboard.is_null() {
        return Err("剪贴板不可用，请使用 Ctrl/Cmd+V 粘贴。".into());
    }
    if js_sys::Reflect::get(&clipboard, &"read".into()).ok().is_some_and(|method| method.is_function())
        && let Ok(items) = wasm_bindgen_futures::JsFuture::from(clipboard.read()).await
        && let Some(item) = js_sys::Array::from(&items).iter().find_map(|item| item.dyn_into::<web_sys::ClipboardItem>().ok())
    {
        let text = clipboard_flavor(&item, "text/plain").await?;
        let html = clipboard_flavor(&item, "text/html").await?;
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            return Ok((text, html));
        }
        return Err("剪贴板没有可粘贴的文本。".into());
    }
    if !js_sys::Reflect::get(&clipboard, &"readText".into()).ok().is_some_and(|method| method.is_function()) {
        return Err("当前浏览器不支持读取剪贴板，请使用 Ctrl/Cmd+V。".into());
    }
    let text = wasm_bindgen_futures::JsFuture::from(clipboard.read_text())
        .await
        .map_err(|_| "读取剪贴板被拒绝，请允许剪贴板权限或使用 Ctrl/Cmd+V。")?
        .as_string()
        .ok_or("剪贴板没有可读取的文本。")?;
    if text.is_empty() {
        return Err("剪贴板没有可粘贴的文本。".into());
    }
    if text.len() > 8 * 1024 * 1024 {
        return Err("单次粘贴不能超过 8 MiB。".into());
    }
    Ok((text, None))
}

fn copy_html(html: &str, text: &str) -> Result<(), String> {
    let js = |error: JsValue| format!("{error:?}");
    let window = web_sys::window().ok_or("no window")?;
    let clipboard = window.navigator().clipboard();
    if clipboard.is_undefined() || clipboard.is_null() {
        return Err("browser clipboard is unavailable".into());
    }
    if !js_sys::Reflect::get(&clipboard, &"write".into()).map_err(js)?.is_function() {
        return Err("rich clipboard writes are unavailable".into());
    }
    let data = js_sys::Object::new();
    for (mime, value) in [("text/html", html), ("text/plain", text)] {
        let options = web_sys::BlobPropertyBag::new();
        options.set_type(mime);
        let blob = web_sys::Blob::new_with_str_sequence_and_options(&js_sys::Array::of1(&JsValue::from_str(value)), &options).map_err(js)?;
        js_sys::Reflect::set(&data, &mime.into(), &blob).map_err(js)?;
    }
    let item = web_sys::ClipboardItem::new_with_record_from_str_to_blob_promise(&data).map_err(js)?;
    let promise = clipboard.write(&js_sys::Array::of1(&item));
    let text = text.to_owned();
    wasm_bindgen_futures::spawn_local(async move {
        if wasm_bindgen_futures::JsFuture::from(promise).await.is_err() {
            let _ = wasm_bindgen_futures::JsFuture::from(clipboard.write_text(&text)).await;
        }
    });
    Ok(())
}
