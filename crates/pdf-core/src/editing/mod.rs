//! Editing contracts and the transaction boundary.
mod action;
mod dispatch;
mod history;
mod replace;
pub use action::{EditAction, EditState};
pub(crate) use history::History;
