use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use js_sys::{Function, Promise, Uint8Array};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::document::{Entry, MAX_INPUT_BYTES, guarded};
use crate::input_barrier::InputDiscardBarrier;

const MAX_SESSIONS: usize = 8;
const MAX_PARAMS_BYTES: usize = 8 * 1024 * 1024;
const DISCARD_INPUT_EVENT: &str = "open-office-pdf-discard-input";

struct FlushWaiter {
    session_id: String,
    resolve: Function,
    reject: Function,
    since: f64,
}

struct State {
    entries: BTreeMap<String, Entry>,
    active: Option<String>,
    enabled: bool,
    theme: String,
    drain_input: bool,
    discard_input: InputDiscardBarrier,
    destroyed: bool,
    started: bool,
    next_document_id: u32,
    ctx: Option<egui::Context>,
    canvas: Option<web_sys::HtmlCanvasElement>,
    callback: Function,
    actions: Rc<RefCell<Vec<Value>>>,
    waiters: Vec<FlushWaiter>,
}

impl State {
    fn entry_mut(&mut self, id: &str) -> Result<&mut Entry, JsValue> {
        if self.destroyed {
            return Err(js_error("PDF 编辑器已关闭。"));
        }
        self.entries.get_mut(id).ok_or_else(|| js_error("找不到此 PDF 会话。"))
    }
    fn snapshot(&mut self, id: &str) -> Result<Value, JsValue> {
        self.entry_mut(id)?.snapshot(id).map_err(js_error)
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

#[wasm_bindgen]
pub struct OfficePdfHost {
    state: Rc<RefCell<State>>,
    runner: eframe::WebRunner,
}

#[wasm_bindgen(js_name = createHost)]
pub fn create_host(callback: Function) -> OfficePdfHost {
    OfficePdfHost {
        state: Rc::new(RefCell::new(State {
            entries: BTreeMap::new(),
            active: None,
            enabled: true,
            theme: "system".into(),
            drain_input: false,
            discard_input: InputDiscardBarrier::default(),
            destroyed: false,
            started: false,
            next_document_id: 1,
            ctx: None,
            canvas: None,
            callback,
            actions: Rc::new(RefCell::new(Vec::new())),
            waiters: Vec::new(),
        })),
        runner: eframe::WebRunner::new(),
    }
}

#[wasm_bindgen(js_name = inspectBytes)]
pub fn inspect_bytes(bytes: &[u8]) -> Result<String, JsValue> {
    json_string(&crate::document::inspect_bytes(bytes).map_err(js_error)?)
}

#[wasm_bindgen]
impl OfficePdfHost {
    /// Fully parse a candidate before admitting it; errors leave every existing session untouched.
    pub fn prepare(&self, id: &str, name: &str, bytes: &[u8]) -> Result<String, JsValue> {
        if id.is_empty() || id.len() > 256 || name.len() > 4096 || bytes.len() > MAX_INPUT_BYTES {
            return Err(js_error("会话或文件名无效，或 PDF 文件超过 64 MiB。"));
        }
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed || state.entries.contains_key(id) {
            return Err(js_error("编辑器已关闭或 PDF 会话已存在。"));
        }
        if state.entries.len() >= MAX_SESSIONS {
            return Err(js_error("最多同时打开八个 PDF 文档。"));
        }
        let document_id = state.next_document_id;
        let next = document_id.checked_add(1).ok_or_else(|| js_error("文档编号已达到上限。"))?;
        let mut entry = Entry::new(name, bytes, document_id).map_err(js_error)?;
        entry.app.set_option("theme", &state.theme).map_err(js_error)?;
        let actions = state.actions.clone();
        let session_id = id.to_owned();
        entry.app.host_action = Some(Box::new(move |action| {
            if let Ok(mut queue) = actions.try_borrow_mut() {
                queue.push(json!({"type":"action","sessionId":session_id,"action":action}));
            }
        }));
        let snapshot = entry.snapshot(id).map_err(js_error)?;
        state.next_document_id = next;
        state.entries.insert(id.to_owned(), entry);
        json_string(&snapshot)
    }

    pub async fn start(&self, canvas: web_sys::HtmlCanvasElement) -> Result<(), JsValue> {
        {
            let mut state = self.state.try_borrow_mut().map_err(js_error)?;
            if state.destroyed || state.started {
                return Err(js_error("PDF 编辑器已启动或已关闭。"));
            }
            state.started = true;
        }
        let shared = self.state.clone();
        let mut result = self
            .runner
            .start(
                canvas.clone(),
                eframe::WebOptions { renderer: eframe::Renderer::Glow, ..Default::default() },
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
            return Err(js_error("PDF 编辑器已关闭。"));
        }
        if result.is_ok() {
            // eframe owns a separate DOM-event queue. Its public event bridge gives
            // us a logic pass that takes this queue, including while the canvas is
            // hidden. This bounds discard cleanup without depending on a RAF.
            result = self.runner.add_event_listener::<web_sys::Event>(canvas.as_ref(), DISCARD_INPUT_EVENT, |_, runner| runner.logic());
            if result.is_ok() {
                self.state.try_borrow_mut().map_err(js_error)?.canvas = Some(canvas);
            }
        }
        if result.is_err() {
            self.runner.destroy();
            if let Ok(mut state) = self.state.try_borrow_mut() {
                state.started = false;
                state.ctx = None;
                state.canvas = None;
            }
        }
        result
    }

    pub fn activate(&self, id: &str) -> Result<String, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        state.entry_mut(id)?;
        if state.discard_input.pending() {
            return Err(js_error("请先完成已关闭文档的输入清理，再切换 PDF 文档。"));
        }
        if state.active.as_deref() != Some(id) {
            if !state.waiters.is_empty()
                || state.active.as_ref().and_then(|id| state.entries.get(id)).is_some_and(|entry| entry.app.has_pending_input())
            {
                return Err(js_error("请先完成当前输入，再切换 PDF 文档。"));
            }
            if let Some(ctx) = state.ctx.clone() {
                if let Some(previous) = state.active.clone().and_then(|id| state.entries.get_mut(&id)) {
                    previous.memory = Some(ctx.memory(Clone::clone));
                }
                let memory = state.entry_mut(id)?.memory.clone().unwrap_or_default();
                ctx.memory_mut(|current| *current = memory);
                state.entry_mut(id)?.app.activate_host_context(&ctx);
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

    pub fn command(&self, id: &str, command: &str, params_json: &str) -> Result<String, JsValue> {
        if params_json.len() > MAX_PARAMS_BYTES || command.len() > 128 {
            return Err(js_error("PDF 操作参数超出大小限制。"));
        }
        let params: Value = serde_json::from_str(params_json).map_err(js_error)?;
        if !params.is_object() {
            return Err(js_error("PDF 操作参数必须为 JSON 对象。"));
        }
        let response = {
            let mut state = self.state.try_borrow_mut().map_err(js_error)?;
            if command.starts_with("ui.") && state.active.as_deref() != Some(id) {
                return Err(js_error("请先切换到此 PDF 文档，再执行界面操作。"));
            }
            let result = state.entry_mut(id)?.command(command, &params);
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
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Err(js_error("请等待当前输入提交后再保存。"));
        }
        let bytes = state.entry_mut(id)?.export(format).map_err(js_error)?;
        Ok(Uint8Array::from(bytes.as_slice()))
    }

    /// A rendered input batch and all editable drafts must settle before a save snapshot is made.
    pub fn flush(&self, id: &str) -> Result<Promise, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        state.entry_mut(id)?;
        if !state.started || state.active.as_deref() != Some(id) {
            state.entry_mut(id)?.commit_pending().map_err(js_error)?;
            return Ok(Promise::resolve(&JsValue::UNDEFINED));
        }
        let promise = Promise::new(&mut |resolve, reject| {
            state.waiters.push(FlushWaiter { session_id: id.to_owned(), resolve, reject, since: js_sys::Date::now() });
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
        let result = state.entry_mut(id)?.mark_saved(document_id, revision).map_err(js_error)?;
        state.repaint();
        Ok(result)
    }

    #[wasm_bindgen(js_name = discardChanges)]
    pub fn discard_changes(&self, id: &str, document_id: f64, revision: f64) -> Result<bool, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Ok(false);
        }
        let result = state.entry_mut(id)?.discard(document_id, revision).map_err(js_error)?;
        state.repaint();
        Ok(result)
    }

    pub fn close(&self, id: &str, document_id: f64, revision: f64, force: bool) -> Result<bool, JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.waiters.iter().any(|waiter| waiter.session_id == id) {
            return Ok(false);
        }
        if !state.entry_mut(id)?.can_close(document_id, revision, force).map_err(js_error)? {
            return Ok(false);
        }
        if force {
            state.entry_mut(id)?.app.discard_pending();
            if state.active.as_deref() == Some(id) && state.canvas.is_some() {
                state.discard_input.arm();
            }
            if state.active.as_deref() == Some(id)
                && let Some(ctx) = &state.ctx
            {
                // Clear the last egui pass here; drainDiscardedInput consumes the
                // separate queue still owned by eframe before the next activation.
                ctx.input_mut(|input| {
                    input.events.clear();
                    input.raw.events.clear();
                });
                if let Some(focus) = ctx.memory(|memory| memory.focused()) {
                    ctx.memory_mut(|memory| memory.surrender_focus(focus));
                }
            }
        }
        state.entries.remove(id);
        if state.active.as_deref() == Some(id) {
            state.active = None;
        }
        state.repaint();
        Ok(true)
    }

    #[wasm_bindgen(js_name = drainDiscardedInput)]
    pub fn drain_discarded_input(&self) -> Result<Promise, JsValue> {
        let canvas = {
            let state = self.state.try_borrow().map_err(js_error)?;
            if !state.discard_input.pending() {
                return Ok(Promise::resolve(&JsValue::UNDEFINED));
            }
            state.canvas.clone().ok_or_else(|| js_error("PDF 输入清理不可用。"))?
        };
        // Never hold State while the event bridge re-enters raw_input_hook.
        let event = web_sys::Event::new(DISCARD_INPUT_EVENT)?;
        canvas.dispatch_event(&event)?;
        if self.state.try_borrow().map_err(js_error)?.discard_input.pending() {
            return Err(js_error("PDF 输入尚未清理完成，请重试关闭操作。"));
        }
        Ok(Promise::resolve(&JsValue::UNDEFINED))
    }

    #[wasm_bindgen(js_name = setTheme)]
    pub fn set_theme(&self, theme: &str) -> Result<(), JsValue> {
        if !matches!(theme, "light" | "dark" | "system") {
            return Err(js_error("外观仅支持 light、dark 或 system。"));
        }
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed {
            return Err(js_error("PDF 编辑器已关闭。"));
        }
        state.theme = theme.into();
        for entry in state.entries.values_mut() {
            entry.app.set_option("theme", theme).map_err(js_error)?;
        }
        if let Some(ctx) = &state.ctx {
            ctx.set_theme(match theme {
                "light" => egui::ThemePreference::Light,
                "dark" => egui::ThemePreference::Dark,
                _ => egui::ThemePreference::System,
            });
        }
        state.repaint();
        Ok(())
    }

    #[wasm_bindgen(js_name = setActive)]
    pub fn set_active(&self, active: bool) -> Result<(), JsValue> {
        let mut state = self.state.try_borrow_mut().map_err(js_error)?;
        if state.destroyed {
            return Err(js_error("PDF 编辑器已关闭。"));
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
            state.canvas = None;
            state.discard_input = InputDiscardBarrier::default();
            state.entries.clear();
            state.active = None;
            std::mem::take(&mut state.waiters)
        } else {
            Vec::new()
        };
        for waiter in waiters {
            let _ = waiter.reject.call1(&JsValue::UNDEFINED, &js_error("PDF 编辑器已关闭，输入未提交。"));
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

    fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        if let Ok(mut state) = self.state.try_borrow_mut() {
            state.discard_input.consume(raw);
            if !state.enabled && !state.drain_input {
                raw.events.retain(|event| matches!(event, egui::Event::Ime(_)));
            }
            raw.dropped_files.clear();
            raw.hovered_files.clear();
            if let Some(entry) = state.active.clone().and_then(|id| state.entries.get_mut(&id)) {
                eframe::App::raw_input_hook(&mut entry.app, ctx, raw);
            }
        }
    }

    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        let (error, expired) = if let Ok(mut state) = self.state.try_borrow_mut() {
            ctx.input_mut(|input| input.raw.dropped_files.clear());
            let active = state.active.clone();
            let callback = state.callback.clone();
            let error = active.and_then(|id| {
                let entry = state.entries.get_mut(&id)?;
                guarded(|| {
                    eframe::App::logic(&mut entry.app, ctx, frame);
                    Ok(())
                })
                .err()
                .map(|error| (callback, json!({"type":"error","sessionId":id,"error":error})))
            });
            let mut expired = Vec::new();
            for waiter in std::mem::take(&mut state.waiters) {
                if js_sys::Date::now() - waiter.since >= 10_000.0 {
                    expired.push(waiter);
                } else {
                    state.waiters.push(waiter);
                }
            }
            if !state.waiters.is_empty() {
                // eframe runs logic while its canvas is hidden, but no UI pass: keep the
                // bounded wait alive so a hidden tab cannot hold the shell's task queue forever.
                state.repaint();
            }
            (error, expired)
        } else {
            (None, Vec::new())
        };
        if let Some((callback, error)) = error {
            notify(&callback, &error);
        }
        for waiter in expired {
            let _ = waiter.reject.call1(&JsValue::UNDEFINED, &js_error("PDF 输入尚未提交，请回到 PDF 页面完成输入后重试。"));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let (notices, completions, callback) = {
            let Ok(mut state) = self.state.try_borrow_mut() else { return };
            let mut notices = Vec::new();
            let mut completions = Vec::new();
            let active = state.active.clone();
            let flushing = state.waiters.iter().any(|waiter| Some(&waiter.session_id) == active.as_ref());
            let mut result: Result<(), String> = Ok(());
            let mut pending_input = false;
            if let Some(id) = &active
                && let Some(entry) = state.entries.get_mut(id)
            {
                result = guarded(|| {
                    eframe::App::ui(&mut entry.app, ui, frame);
                    pending_input = entry.app.is_composing();
                    if flushing && !pending_input {
                        entry.commit_pending()?;
                    }
                    entry.sync()
                });
                if let Err(error) = &result {
                    notices.push(json!({"type":"error","sessionId":id,"error":error}));
                }
                if let Ok(snapshot) = entry.snapshot(id) {
                    // Include view state so navigation and layout changes reach the shell too.
                    let signature = snapshot.to_string();
                    if signature != entry.notified {
                        entry.notified = signature;
                        notices.push(json!({"type":"change","sessionId":id,"snapshot":snapshot}));
                    }
                }
            }
            for waiter in std::mem::take(&mut state.waiters) {
                if pending_input && active.as_deref() == Some(&waiter.session_id) && js_sys::Date::now() - waiter.since < 10_000.0 {
                    state.waiters.push(waiter);
                    continue;
                }
                let outcome = if active.as_deref() != Some(&waiter.session_id) {
                    Err("输入提交之前切换了 PDF 文档。".into())
                } else if pending_input {
                    Err("请先完成输入法组词，再保存或切换文档。".into())
                } else {
                    result.clone()
                };
                completions.push((waiter, outcome));
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
        // Callbacks may close the last tab. Leave all eframe/host borrows first.
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
                action["documentId"] = json!(entry.document_id);
                action["revision"] = json!(entry.revision);
            }
        }
        (actions, state.callback.clone())
    };
    for action in actions {
        notify(&callback, &action);
    }
}
