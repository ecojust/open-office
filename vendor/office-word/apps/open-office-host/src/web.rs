use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use js_sys::{Function, Promise, Uint8Array};
use office_word_doc::StoryRef;
use office_word_engine::Session;
use office_word_ui_egui::{
    Services, WordApp,
    theme::{self, Appearance},
};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::document_state::DocumentState;

const MAX_SESSIONS: usize = 8;
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_PARAMS_BYTES: usize = 96 * 1024 * 1024;

struct Entry {
    app: WordApp,
    name: String,
    document_id: u32,
    document: DocumentState,
    memory: Option<egui::Memory>,
    notified: String,
}

impl Entry {
    fn sync(&mut self) -> Result<(), String> {
        self.document.sync(&self.app.session.doc)?;
        self.app.session.dirty = self.document.dirty();
        Ok(())
    }

    fn matches(&self, document_id: f64, revision: f64) -> bool {
        f64::from(self.document_id) == document_id && f64::from(self.document.revision()) == revision
    }

    fn snapshot(&mut self, id: &str, ctx: Option<&egui::Context>) -> Result<Value, String> {
        self.sync()?;
        let mut ui = ctx
            .map(|ctx| office_word_ui_egui::control::inspect(&mut self.app, ctx))
            .unwrap_or(Value::Null);
        if let (Some(ctx), Some(object)) = (ctx, ui.as_object_mut()) {
            let rects = ctx
                .data(|data| {
                    data.get_temp::<Vec<(egui::Rect, String)>>(
                        office_word_ui_egui::keytips::rects_id(),
                    )
                })
                .unwrap_or_default();
            let letters = ctx
                .data(|data| {
                    data.get_temp::<Vec<String>>(
                        office_word_ui_egui::keytips::letters_id().with(&self.app.ui.tab),
                    )
                })
                .unwrap_or_default();
            let controls = office_word_ui_egui::keytips::controls_public(&self.app.ui.tab);
            object.insert("ribbonControls".into(), json!(controls.iter().zip(letters.iter()).filter_map(|(control, key)| {
                rects.iter().find(|(_, letter)| letter == key).map(|(rect, _)| json!({"id":control.id,"label":control.tip,"key":key,"rect":[rect.left(),rect.top(),rect.width(),rect.height()]}))
            }).collect::<Vec<_>>()));
        }
        Ok(json!({
            "sessionId": id, "name": self.name, "documentId": self.document_id,
            "revision": self.document.revision(), "dirty": self.app.session.dirty,
            "canUndo": self.app.session.can_undo(), "canRedo": self.app.session.can_redo(),
            "pages": self.app.session.layout().pages.len(),
            "selection": self.app.session.sel,
            "format": office_word_engine::cmd::format::state(&self.app.session),
            "text": self.app.session.doc.plain_text(StoryRef::Body),
            "ui": ui,
        }))
    }
}

struct FlushWaiter {
    session_id: String,
    resolve: Function,
    reject: Function,
}

struct State {
    entries: BTreeMap<String, Entry>,
    theme: Appearance,
    active: Option<String>,
    enabled: bool,
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
        self.entries
            .get_mut(id)
            .ok_or_else(|| js_error("unknown editor session"))
    }

    fn snapshot(&mut self, id: &str) -> Result<Value, JsValue> {
        let ctx = if self.active.as_deref() == Some(id) {
            self.ctx.clone()
        } else {
            None
        };
        self.entry_mut(id)?
            .snapshot(id, ctx.as_ref())
            .map_err(js_error)
    }

    fn repaint(&self) {
        if let Some(ctx) = &self.ctx {
            ctx.request_repaint();
        }
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
fn json_string(value: &Value) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(js_error)
}

/// Commands that own files or replace a document are delegated before WordApp can mutate it.
/// The same hook runs for real ribbon/shortcut actions and programmatic commands.
fn host_action(id: &str) -> Option<&'static str> {
    match id {
        "file.new" => Some("new"),
        "file.open" | "ui.openFileDialog" => Some("open"),
        "file.save" => Some("save"),
        "file.saveAs" => Some("saveAs"),
        "file.exportPdf" => Some("exportPdf"),
        "file.close" => Some("close"),
        "file.print" | "ui.print" | "ui.printSubmit" => Some("print"),
        _ => None,
    }
}

fn shell_policy(id: &str, params: &Value) -> Option<Result<Value, String>> {
    // All disk-writing / replacing workflows stay in the shell. Plain editing commands do not
    // accept a path through this bridge, including insert.picture and insert.textFromFile.
    if id.starts_with("file.")
        && !matches!(
            id,
            "file.info"
                | "file.properties"
                | "file.options"
                | "file.accessibility"
                | "file.printMarkup"
                | "file.setAuthor"
                | "file.privacy"
                | "file.privacyOptions"
        )
    {
        return Some(Err("This file operation is managed by Open Office.".into()));
    }
    if matches!(id, "mailings.labels" | "mailings.finish")
        || (id == "mailings.envelopes" && params.get("add").and_then(Value::as_bool) != Some(true))
        || id.starts_with("ui.zotero.")
    {
        return Some(Err(
            "This workflow cannot replace a document inside an Open Office tab.".into(),
        ));
    }
    // These dispatch a recorded or nested command directly through Session::run, bypassing
    // WordApp's host hook. Keep the first embedding's file ownership boundary explicit.
    if matches!(id, "tools.macros" | "edit.repeat") {
        return Some(Err(
            "Recorded command execution is unavailable in the embedded editor.".into(),
        ));
    }
    if params.as_object().is_some_and(|object| {
        object.iter().any(|(key, value)| {
            value.is_string()
                && matches!(key.as_str(), "path" | "outputPath" | "filePath" | "folder")
        })
    }) {
        return Some(Err(
            "Use the host file picker and byte data; filesystem paths are not accepted.".into(),
        ));
    }
    None
}

fn services(session_id: &str, actions: Rc<RefCell<Vec<Value>>>) -> Services {
    let action_id = session_id.to_owned();
    let command_actions = actions.clone();
    let picker_id = session_id.to_owned();
    let save_id = session_id.to_owned();
    let save_actions = actions.clone();
    Services {
        embedded_editor: true,
        browser_clipboard: true,
        host_command: Some(Box::new(move |id, params| {
            if let Some(action) = host_action(id) {
                if let Ok(mut queue) = command_actions.try_borrow_mut() {
                    queue.push(json!({"type":"action", "sessionId":action_id, "action":action}));
                    return Some(Ok(json!({"pending":"host", "action":action})));
                }
                return Some(Err("host action queue is busy".into()));
            }
            shell_policy(id, params)
        })),
        open_async: Some(Box::new(move |purpose| {
            if let Ok(mut queue) = actions.try_borrow_mut() {
                queue.push(json!({"type":"action", "sessionId":picker_id, "action":"pickFile", "purpose":purpose}));
            }
        })),
        // Backstage's Save As / Export buttons ask the picker directly, rather than calling
        // run. Delegate the request and return cancellation so WordApp cannot write or mark saved.
        pick_save: Some(Box::new(move |name| {
            if let Ok(mut queue) = save_actions.try_borrow_mut() {
                if name.to_ascii_lowercase().ends_with(".pdf") {
                    queue.push(json!({"type":"action","sessionId":save_id,"action":"exportPdf"}));
                } else if name.to_ascii_lowercase().ends_with(".docx") {
                    queue.push(json!({"type":"action","sessionId":save_id,"action":"saveAs"}));
                } else {
                    queue.push(json!({"type":"error","sessionId":save_id,"error":"Open Office currently exports DOCX and PDF."}));
                }
            }
            None
        })),
        // Never install download: exporting cannot acknowledge a durable save.
        ..Services::default()
    }
}

#[wasm_bindgen]
pub struct OfficeWordHost {
    state: Rc<RefCell<State>>,
    runner: eframe::WebRunner,
}

#[wasm_bindgen(js_name = createHost)]
pub fn create_host(callback: Function) -> OfficeWordHost {
    OfficeWordHost {
        state: Rc::new(RefCell::new(State {
            entries: BTreeMap::new(),
            theme: Appearance::System,
            active: None,
            enabled: true,
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
impl OfficeWordHost {
    /// Parse completely before registering a session. Failed opens never change the active tab.
    pub fn prepare(&self, id: &str, name: &str, bytes: &[u8]) -> Result<String, JsValue> {
        if id.is_empty() || id.len() > 256 || name.len() > 4096 || bytes.len() > MAX_INPUT_BYTES {
            return Err(js_error(
                "invalid session/name or document exceeds the 64 MiB import limit",
            ));
        }
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed {
            return Err(js_error("editor host is destroyed"));
        }
        if state.entries.contains_key(id) {
            return Err(js_error("editor session already exists"));
        }
        if state.entries.len() >= MAX_SESSIONS {
            return Err(js_error("at most eight document sessions may be open"));
        }
        let region = office_word_ui_egui::i18n::system_region();
        let doc = if bytes.is_empty() {
            office_word_engine::blank_document(&region)
        } else {
            office_word_engine::io::open_bytes(name, bytes).map_err(js_error)?
        };
        let document_id = state.next_document_id;
        state.next_document_id = document_id
            .checked_add(1)
            .ok_or_else(|| js_error("document identifiers exhausted"))?;
        let mut session = Session::new(doc.clone());
        session.file_name = Some(name.to_owned());
        session.system_region = region;
        session.author = "Open Office User".into();
        // Browser paste-without-formatting is owned by its DOM Paste event. Keep shortcut
        // labels consistent while the explicit Paste Formatting command remains available.
        session
            .keymap
            .assigned
            .insert("Mod+Shift+V".into(), "edit.pasteText".into());
        let mut app = WordApp::new(session, services(id, state.actions.clone()));
        if !bytes.is_empty() {
            app.mark_host_saved();
        }
        app.autosave = false;
        app.ui.language = "zh-hans".into();
        app.set_host_theme(state.theme);
        let mut entry = Entry {
            app,
            name: name.to_owned(),
            document_id,
            document: DocumentState::new(doc),
            memory: None,
            notified: String::new(),
        };
        let snapshot = entry.snapshot(id, None).map_err(js_error)?;
        state.entries.insert(id.to_owned(), entry);
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
                        theme::apply(&creation.egui_ctx, state.theme);
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
                return Err(js_error(
                    "flush the previous tab before activating another session",
                ));
            }
            if let Some(ctx) = state.ctx.clone() {
                if let Some(previous) = state
                    .active
                    .clone()
                    .and_then(|id| state.entries.get_mut(&id))
                {
                    previous.memory = Some(ctx.memory(Clone::clone));
                    previous.app.canvas.focused = false;
                }
                let memory = state.entry_mut(id)?.memory.clone().unwrap_or_default();
                ctx.memory_mut(|current| *current = memory);
                // Session memory can contain the palette preference from an older frame.
                // The shell preference is shared by every tab, including restored tabs.
                theme::apply(&ctx, state.theme);
            }
            state.active = Some(id.to_owned());
        }
        state.repaint();
        json_string(&state.snapshot(id)?)
    }

    pub fn inspect(&self, id: &str) -> Result<String, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        json_string(&state.snapshot(id)?)
    }

    pub fn command(
        &self,
        id: &str,
        command_id: &str,
        params_json: &str,
    ) -> Result<String, JsValue> {
        if params_json.len() > MAX_PARAMS_BYTES {
            return Err(js_error("command payload exceeds the size limit"));
        }
        let params: Value = serde_json::from_str(params_json).map_err(js_error)?;
        if !params.is_object() {
            return Err(js_error("command parameters must be a JSON object"));
        }
        let response = {
            let mut state = self.state.try_borrow_mut().map_err(js_error)?;
            let entry = state.entry_mut(id)?;
            entry.sync().map_err(js_error)?;
            let result = if command_id == "host.cancelPicture" {
                entry.app.change_picture_target = None;
                Ok(json!({"cancelled":true}))
            } else if command_id == "host.deliverPicture" {
                if params.get("data").and_then(Value::as_str).is_none() {
                    Err("picked pictures require base64 byte data".into())
                } else if let Some(result) = shell_policy("insert.picture", &params) {
                    result
                } else {
                    entry.app.insert_or_change_picture(params)
                }
            } else if command_id.starts_with("ui.")
                || host_action(command_id).is_some()
                || entry
                    .app
                    .session
                    .registry
                    .all()
                    .iter()
                    .any(|command| command.id == command_id)
            {
                entry.app.execute(command_id, params)
            } else {
                Err("unknown editor command".into())
            };
            let snapshot = state.snapshot(id)?;
            state.repaint();
            match result {
                Ok(result) => json!({"ok":true,"result":result,"snapshot":snapshot}),
                Err(error) => json!({"ok":false,"error":error,"snapshot":snapshot}),
            }
        };
        dispatch_actions(&self.state);
        json_string(&response)
    }

    #[wasm_bindgen(js_name = exportFile)]
    pub fn export_file(&self, id: &str, format: &str) -> Result<Uint8Array, JsValue> {
        let name = match format {
            "docx" => "document.docx",
            "pdf" => "document.pdf",
            _ => return Err(js_error("export format must be docx or pdf")),
        };
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        let entry = state.entry_mut(id)?;
        entry.sync().map_err(js_error)?;
        let bytes =
            office_word_engine::io::save_bytes(name, &entry.app.session.doc).map_err(js_error)?;
        Ok(Uint8Array::from(bytes.as_slice()))
    }

    /// Wait for WordApp to consume already queued input before synchronous export + inspect.
    pub fn flush(&self, id: &str) -> Result<Promise, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        state.entry_mut(id)?;
        if !state.started || state.active.as_deref() != Some(id) {
            return Ok(Promise::resolve(&JsValue::UNDEFINED));
        }
        let promise = Promise::new(&mut |resolve, reject| {
            state.waiters.push(FlushWaiter {
                session_id: id.to_owned(),
                resolve,
                reject,
            });
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
        let entry = state.entry_mut(id)?;
        entry.sync().map_err(js_error)?;
        if !entry.matches(document_id, revision) {
            return Ok(false);
        }
        entry.document.mark_saved();
        entry.app.session.dirty = false;
        entry.app.mark_host_saved();
        state.repaint();
        Ok(true)
    }

    #[wasm_bindgen(js_name = discardChanges)]
    pub fn discard_changes(
        &self,
        id: &str,
        document_id: f64,
        revision: f64,
    ) -> Result<bool, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Ok(false);
        }
        let entry = state.entry_mut(id)?;
        entry.sync().map_err(js_error)?;
        if !entry.matches(document_id, revision) {
            return Ok(false);
        }
        let had_saved_copy = entry.app.has_saved_copy();
        entry.app.session.set_document(entry.document.saved().clone());
        if had_saved_copy {
            entry.app.mark_host_saved();
        }
        entry.app.session.file_name = Some(entry.name.clone());
        entry.sync().map_err(js_error)?;
        state.repaint();
        Ok(true)
    }

    pub fn close(
        &self,
        id: &str,
        document_id: f64,
        revision: f64,
        force: bool,
    ) -> Result<bool, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Ok(false);
        }
        let entry = state.entry_mut(id)?;
        entry.sync().map_err(js_error)?;
        if !entry.matches(document_id, revision) || (!force && entry.app.session.dirty) {
            return Ok(false);
        }
        state.entries.remove(id);
        if state.active.as_deref() == Some(id) {
            state.active = None;
        }
        state.repaint();
        Ok(true)
    }

    /// The shell owns interface appearance; this never changes document/page styling.
    #[wasm_bindgen(js_name = setTheme)]
    pub fn set_theme(&self, preference: &str) -> Result<(), JsValue> {
        let appearance = Appearance::from_code(preference)
            .ok_or_else(|| js_error("theme must be light, dark or system"))?;
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed {
            return Err(js_error("editor host is destroyed"));
        }
        state.theme = appearance;
        for entry in state.entries.values_mut() {
            entry.app.set_host_theme(appearance);
        }
        if let Some(ctx) = &state.ctx {
            theme::apply(ctx, appearance);
        }
        state.repaint();
        Ok(())
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
            state.active = None;
            std::mem::take(&mut state.waiters)
        } else {
            Vec::new()
        };
        for waiter in waiters {
            let _ = waiter.reject.call1(
                &JsValue::UNDEFINED,
                &js_error("editor host destroyed before input was flushed"),
            );
        }
    }
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
                // Blur can deliver compositionend after more than one animation frame. Keep
                // IME preedit/commit so disabling the shell never discards already started text.
                raw.events
                    .retain(|event| matches!(event, egui::Event::Ime(_)));
                raw.dropped_files.clear();
                raw.hovered_files.clear();
            }
            if let Some(id) = state.active.clone() {
                if let Some(entry) = state.entries.get_mut(&id) {
                    entry.app.raw_input_hook(raw);
                }
            }
        }
    }

    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Ok(mut state) = self.state.try_borrow_mut() {
            // Document drops must use the shell's prepare/open transaction; never hand them to
            // WordApp's inbox, which would replace the active document without tab ownership.
            ctx.input_mut(|input| {
                input.raw.dropped_files.clear();
            });
            if let Some(id) = state.active.clone() {
                if let Some(entry) = state.entries.get_mut(&id) {
                    entry.app.logic(ctx);
                }
            }
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let (notices, waiters, callback, active) = {
            let Ok(mut state) = self.state.try_borrow_mut() else {
                return;
            };
            let mut notices = Vec::new();
            if let Some(id) = state.active.clone() {
                if let Some(entry) = state.entries.get_mut(&id) {
                    entry.app.ui(ui);
                    if let Err(error) = entry.sync() {
                        entry.app.status(error);
                    }
                    let signature = json!([
                        entry.document.revision(),
                        entry.app.session.dirty,
                        entry.app.session.can_undo(),
                        entry.app.session.can_redo(),
                        entry.app.session.sel,
                        entry.app.session.view.zoom
                    ])
                    .to_string();
                    if signature != entry.notified {
                        entry.notified = signature;
                        if let Ok(snapshot) = entry.snapshot(&id, Some(ui.ctx())) {
                            notices
                                .push(json!({"type":"change","sessionId":id,"snapshot":snapshot}));
                        }
                    }
                }
            }
            state.drain_input = false;
            (
                notices,
                std::mem::take(&mut state.waiters),
                state.callback.clone(),
                state.active.clone(),
            )
        };
        // Never call JavaScript while borrowing State: callbacks may inspect the editor.
        for notice in notices {
            notify(&callback, &notice);
        }
        dispatch_actions(&self.state);
        for waiter in waiters {
            if active.as_deref() == Some(&waiter.session_id) {
                let _ = waiter.resolve.call0(&JsValue::UNDEFINED);
            } else {
                let _ = waiter.reject.call1(
                    &JsValue::UNDEFINED,
                    &js_error("the session changed before its input was flushed"),
                );
            }
        }
    }
}

fn notify(callback: &Function, event: &Value) {
    if let Ok(json) = serde_json::to_string(event) {
        let callback = callback.clone();
        // WordApp may be inside eframe's own RefCell borrow. A shell callback can close the
        // final tab and destroy WebRunner, so invoke it only after the rendering stack unwinds.
        wasm_bindgen_futures::spawn_local(async move {
            let _ = callback.call1(&JsValue::UNDEFINED, &JsValue::from_str(&json));
        });
    }
}

fn dispatch_actions(shared: &Rc<RefCell<State>>) {
    let (actions, callback) = {
        let Ok(mut state) = shared.try_borrow_mut() else {
            return;
        };
        let queue = state.actions.clone();
        let Ok(mut queue) = queue.try_borrow_mut() else {
            return;
        };
        let mut actions = std::mem::take(&mut *queue);
        for action in &mut actions {
            if let Some(id) = action
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                if let Some(entry) = state.entries.get_mut(&id) {
                    let _ = entry.sync();
                    action["revision"] = json!(entry.document.revision());
                    action["documentId"] = json!(entry.document_id);
                    action["selection"] = json!(entry.app.session.sel);
                }
            }
        }
        (actions, state.callback.clone())
    };
    for action in actions {
        notify(&callback, &action);
    }
}
