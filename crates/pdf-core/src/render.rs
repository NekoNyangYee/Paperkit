//! Compatibility facade for existing consumers. Prefer `Paperframe` for new integrations.
pub use crate::engine::{Paperframe as PreviewEngine, RenderedPage};
pub use crate::error::EngineError as PreviewError;
