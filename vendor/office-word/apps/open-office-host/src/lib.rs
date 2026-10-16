//! Local OfficeWord editor host. The Vue shell owns files and tabs; OfficeWord owns editing.
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

#[cfg(any(target_arch = "wasm32", test))]
mod document_state;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub use web::*;
