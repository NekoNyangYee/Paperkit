//! Compatibility facade for existing consumers. Prefer `Paperframe` for new integrations.
pub use crate::engine::error::EngineError as PreviewError;
pub use crate::engine::{Paperframe as PreviewEngine, RenderedPage};
