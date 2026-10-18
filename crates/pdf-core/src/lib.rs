//! Tauri-independent PDF engine boundary.
//!
//! PDFium and documents stay on a dedicated worker; native handles never cross IPC.

mod block;
pub mod document;
pub mod edit;
mod flow;
mod flow_followers;
mod flow_lines;
mod font_recovery;
pub mod fonts;
mod graphics;
pub mod layout;
mod movement;
pub mod pages;
pub mod render;
mod save;
pub mod selection;
mod system_fonts;
pub mod text;

mod move_stream;
mod text_patch;
mod text_spacing;
mod verification;

pub mod alignment;

mod editing;
pub mod engine;
pub mod error;
pub use engine::Paperframe;
pub use error::EngineError;
pub const ENGINE_NAME: &str = "Paperframe";
