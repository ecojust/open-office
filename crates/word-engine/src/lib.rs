//! Independent Rust document, command, DOCX and layout engine.
pub mod docx;
pub mod engine;
pub mod layout;
pub mod model;

pub use engine::{Command, Engine, Request, Response, Snapshot};

pub const MAX_REQUEST_BYTES: usize = 24 * 1024 * 1024;

/// Parsing and command dispatch share one error response contract on all hosts.
pub fn request_json(engine: &mut Engine, bytes: &[u8]) -> Vec<u8> {
    let response = if bytes.len() > MAX_REQUEST_BYTES {
        Response::error("Request exceeds 24 MiB")
    } else {
        match serde_json::from_slice::<Request>(bytes) {
            Ok(request) => engine.request(request),
            Err(error) => Response::error(format!("Invalid engine request: {error}")),
        }
    };
    serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"Cannot encode engine response"}"#.to_vec())
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use std::cell::RefCell;
    thread_local! {
        static ENGINE: RefCell<Engine> = RefCell::new(Engine::new());
        static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
        static INPUTS: RefCell<std::collections::HashMap<u32, Box<[u8]>>> = RefCell::new(std::collections::HashMap::new());
    }

    #[no_mangle]
    pub extern "C" fn word_engine_alloc(len: u32) -> u32 {
        if len == 0 || len as usize > MAX_REQUEST_BYTES {
            return 0;
        }
        INPUTS.with(|inputs| {
            let mut inputs = inputs.borrow_mut();
            // A worker needs at most one pending input. Bound abandoned buffers.
            if inputs.len() >= 2 {
                return 0;
            }
            let mut bytes = vec![0; len as usize].into_boxed_slice();
            let ptr = bytes.as_mut_ptr() as u32;
            inputs.insert(ptr, bytes);
            ptr
        })
    }
    #[no_mangle]
    pub extern "C" fn word_engine_dealloc(ptr: u32, len: u32) {
        INPUTS.with(|inputs| {
            let mut inputs = inputs.borrow_mut();
            if inputs
                .get(&ptr)
                .is_some_and(|input| input.len() == len as usize)
            {
                inputs.remove(&ptr);
            }
        });
    }
    #[no_mangle]
    pub extern "C" fn word_engine_request(ptr: u32, len: u32) -> u32 {
        let response = INPUTS.with(|inputs| {
            let inputs = inputs.borrow();
            match inputs.get(&ptr).filter(|input| input.len() == len as usize) {
                Some(bytes) => ENGINE.with(|engine| request_json(&mut engine.borrow_mut(), bytes)),
                None => {
                    serde_json::to_vec(&Response::error("Invalid WASM input allocation")).unwrap()
                }
            }
        });
        RESULT.with(|result| {
            *result.borrow_mut() = response;
            result.borrow().as_ptr() as u32
        })
    }
    #[no_mangle]
    pub extern "C" fn word_engine_result_len() -> u32 {
        RESULT.with(|result| result.borrow().len() as u32)
    }
}
