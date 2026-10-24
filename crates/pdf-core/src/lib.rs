//! Tauri-independent PDF engine boundary.
//!
//! PDFium and documents stay on a dedicated worker; native handles never cross IPC.

mod compat;
mod content_stream;
pub mod document;
mod editing;
pub mod engine;
pub mod fonts;
pub mod text;

// Preserve existing public module paths for downstream consumers.
pub use compat::{edit, render};
pub use document::{pages, selection};
pub use engine::{error, Paperframe};
pub use error::EngineError;
pub use text::{alignment, layout};
pub const ENGINE_NAME: &str = "Paperframe";
