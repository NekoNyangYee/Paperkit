use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentInput {
    pub source_path: String,
    pub display_name: String,
    pub size_bytes: i64,
    pub source_modified_at: Option<i64>,
    pub source_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    #[serde(flatten)]
    pub input: DocumentInput,
    pub created_at: i64,
    pub last_opened_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tab {
    pub id: String,
    pub document_id: Option<String>,
    pub page_index: i64,
    pub zoom: f64,
    pub sidebar_open: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceInput {
    pub expected_revision: i64,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<Tab>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub revision: i64,
    pub updated_at: i64,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<Tab>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryQuery {
    pub expected_revision: i64,
    pub source_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub document_id: String,
    pub snapshot_hash: String,
    pub source_hash: String,
    pub revision: i64,
    pub size_bytes: i64,
    pub format_version: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftInput {
    pub expected_revision: i64,
    pub snapshot_hash: String,
    pub page_index: i64,
    pub target_locator: Value,
    pub original_text: String,
    pub draft_text: String,
    pub font_options: Value,
    pub alignment: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub document_id: String,
    pub revision: i64,
    pub updated_at: i64,
    pub snapshot_hash: String,
    pub page_index: i64,
    pub target_locator: Value,
    pub original_text: String,
    pub draft_text: String,
    pub font_options: Value,
    pub alignment: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
}
