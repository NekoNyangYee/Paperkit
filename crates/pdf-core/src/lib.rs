//! Tauri-independent PDF engine boundary.
//!
//! PDFium and documents stay on a dedicated worker; native handles never cross IPC.

mod block;
pub mod document;
pub mod edit;
mod flow;
mod font_recovery;
pub mod fonts;
pub mod layout;
mod movement;
pub mod render;
mod save;
pub mod selection;
mod system_fonts;
pub mod text;

mod move_stream;
mod text_spacing;

pub mod alignment;
