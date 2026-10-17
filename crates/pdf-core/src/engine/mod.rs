//! Paperframe: local PDF editing with verified changes.
//! The client sends owned data to one worker. Only that worker owns native handles.
mod client;
mod protocol;
mod raster;
mod worker;
use crate::{editing::EditState, text::PageText};
pub use client::Paperframe;

pub struct RenderedPage {
    pub page_count: i32,
    pub page_index: i32,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
    pub text: PageText,
    pub state: EditState,
}
