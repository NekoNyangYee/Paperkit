//! Editing contracts and the transaction boundary.
mod action;
pub(crate) mod block;
mod dispatch;
pub(crate) mod flow;
pub(crate) mod graphics;
mod history;
pub(crate) mod movement;
mod replace;
pub(crate) use replace::replace as replace_text_object;
mod stamps;
pub(crate) mod verification;
pub use action::{EditAction, EditState, WatermarkSettings};
pub(crate) use history::History;
