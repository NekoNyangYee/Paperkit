use crate::models::*;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;
const APPLICATION_ID: i32 = 0x504b4954;
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_core.sql"),
    include_str!("../migrations/002_ownership.sql"),
];
pub const SCHEMA_VERSION: usize = MIGRATIONS.len();

#[derive(Debug)]
pub enum Error {
    Invalid(&'static str),
    NotFound,
    Conflict,
    Busy,
    Sql(rusqlite::Error),
    Internal,
}
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        match &error {
            rusqlite::Error::SqliteFailure(code, _)
                if code.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Self::Conflict
            }
            _ => Self::Sql(error),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone)]
pub struct Database(Arc<Mutex<Connection>>);

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
pub fn valid_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn next_revision(current: i64, expected: i64) -> Result<i64> {
    if current != expected || expected < 0 {
        return Err(Error::Conflict);
    }
    current.checked_add(1).ok_or(Error::Conflict)
}

impl Database {
    pub fn open(path: &Path) -> std::result::Result<Self, Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let app: i32 = connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if (app != 0 && app != APPLICATION_ID) || !(0..=SCHEMA_VERSION as i64).contains(&version) {
            return Err("Unrecognized database application/schema version".into());
        }
        if version == 0 {
            let tables: i64 = connection.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                [], |r| r.get(0),
            )?;
            if tables != 0 {
                return Err("Refusing to initialize a non-empty, unrecognized database".into());
            }
        } else if app != APPLICATION_ID {
            return Err("Database application ID mismatch".into());
        }
        connection.pragma_update(None, "foreign_keys", true)?;
        let journal: String = connection.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        if journal != "wal" {
            return Err("Database must support WAL on local storage".into());
        }
        connection.pragma_update(None, "synchronous", "FULL")?;
        for (index, migration) in MIGRATIONS.iter().enumerate() {
            let target_version = index as i64 + 1;
            let checksum = sha256(migration.as_bytes());
            if target_version <= version {
                let stored: String = connection.query_row(
                    "SELECT checksum FROM schema_migrations WHERE version=?1",
                    [target_version],
                    |r| r.get(0),
                )?;
                if stored != checksum {
                    return Err(
                        "Migration checksum mismatch; do not edit applied migrations".into(),
                    );
                }
                continue;
            }
            // The ownership migration rebuilds a referenced table. Foreign keys
            // are checked before commit and always enabled before serving requests.
            connection.pragma_update(None, "foreign_keys", false)?;
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(migration)?;
            tx.execute(
                "INSERT INTO schema_migrations VALUES (?1, ?2, ?3)",
                params![target_version, checksum, now()],
            )?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", target_version)?;
            if tx
                .prepare("PRAGMA foreign_key_check")?
                .query([])?
                .next()?
                .is_some()
            {
                return Err("Migration foreign_key_check failed".into());
            }
            tx.commit()?;
            connection.pragma_update(None, "foreign_keys", true)?;
        }
        let integrity: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err("SQLite quick_check failed".into());
        }
        if connection
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
        {
            return Err("SQLite foreign_key_check failed".into());
        }
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub async fn run<T, F>(&self, task: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let database = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database.0.lock().map_err(|_| Error::Internal)?;
            task(&mut connection)
        })
        .await
        .map_err(|_| Error::Internal)?
    }

    pub fn backup(
        &self,
        destination: &Path,
    ) -> std::result::Result<(), Box<dyn std::error::Error>> {
        // Atomic reservation: never overwrite an existing file or follow its symlink.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        drop(file);
        let source = self.0.lock().map_err(|_| "Database lock poisoned")?;
        let mut target = Connection::open(destination)?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
            backup.run_to_completion(256, Duration::from_millis(25), None)?;
        }
        let integrity: String = target.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err("Backup integrity_check failed".into());
        }
        Ok(())
    }
}

fn document_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get(0)?,
        input: DocumentInput {
            source_path: row.get(1)?,
            display_name: row.get(2)?,
            size_bytes: row.get(3)?,
            source_modified_at: row.get(4)?,
            source_hash: row.get(5)?,
        },
        created_at: row.get(6)?,
        last_opened_at: row.get(7)?,
    })
}
const DOCUMENT_COLUMNS: &str = "id,source_path,display_name,size_bytes,source_modified_at,source_hash,created_at,last_opened_at";
pub fn create_document(
    conn: &mut Connection,
    owner: &str,
    input: DocumentInput,
) -> Result<Document> {
    if !valid_id(owner) {
        return Err(Error::Invalid("Invalid owner"));
    }
    if input.source_path.trim().is_empty()
        || input.source_path.len() > 4096
        || input.source_path.chars().any(char::is_control)
        || input.display_name.trim().is_empty()
        || input.display_name.len() > 255
        || input.display_name.chars().any(char::is_control)
        || input.size_bytes <= 0
        || input.source_hash.as_deref().is_some_and(|h| !valid_hash(h))
        || input.source_modified_at.is_some_and(|v| v < 0)
    {
        return Err(Error::Invalid("Invalid document metadata"));
    }
    let document = Document {
        id: Uuid::new_v4().to_string(),
        input,
        created_at: now(),
        last_opened_at: now(),
    };
    let d = &document;
    conn.execute(
        "INSERT INTO documents VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            d.id,
            d.input.source_path,
            d.input.display_name,
            d.input.size_bytes,
            d.input.source_modified_at,
            d.input.source_hash,
            d.created_at,
            d.last_opened_at,
            owner
        ],
    )?;
    Ok(document)
}
pub fn get_document(conn: &Connection, owner: &str, id: &str) -> Result<Document> {
    conn.query_row(
        &format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE id=?1 AND owner_id=?2"),
        [id, owner],
        document_row,
    )
    .optional()?
    .ok_or(Error::NotFound)
}
// No user-controlled SQL identifiers: only this static column list is interpolated.
pub fn list_documents(
    conn: &Connection,
    owner: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Document>> {
    let mut statement = conn.prepare(&format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE owner_id=?1 ORDER BY last_opened_at DESC, id LIMIT ?2 OFFSET ?3"))?;
    let documents = statement
        .query_map(params![owner, limit, offset], document_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(documents)
}
pub fn delete_document(conn: &mut Connection, owner: &str, id: &str) -> Result<()> {
    if conn.execute(
        "DELETE FROM documents WHERE id=?1 AND owner_id=?2",
        [id, owner],
    )? == 0
    {
        return Err(Error::NotFound);
    }
    Ok(())
}

pub fn put_workspace(
    conn: &mut Connection,
    owner: &str,
    id: &str,
    input: WorkspaceInput,
) -> Result<Workspace> {
    if !valid_id(owner) {
        return Err(Error::Invalid("Invalid owner"));
    }
    let mut tab_ids = HashSet::new();
    let mut document_ids = HashSet::new();
    if input.tabs.len() > 128 || input.expected_revision < 0 {
        return Err(Error::Invalid(
            "At most 128 tabs and a nonnegative expectedRevision are required",
        ));
    }
    for tab in &input.tabs {
        if !valid_id(&tab.id)
            || !tab_ids.insert(&tab.id)
            || tab
                .document_id
                .as_ref()
                .is_some_and(|d| !valid_id(d) || !document_ids.insert(d))
            || tab.page_index < 0
            || !tab.zoom.is_finite()
            || !(25.0..=400.0).contains(&tab.zoom)
        {
            return Err(Error::Invalid("Invalid or duplicate tab"));
        }
    }
    if input
        .active_tab_id
        .as_ref()
        .is_some_and(|id| !tab_ids.contains(id))
        || (input.tabs.is_empty() != input.active_tab_id.is_none())
    {
        return Err(Error::Invalid(
            "activeTabId must identify a tab, or be null for an empty workspace",
        ));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(Option<String>, i64)> = tx
        .query_row(
            "SELECT owner_id, revision FROM workspaces WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let current = match existing {
        Some((Some(existing_owner), revision)) if existing_owner == owner => revision,
        Some(_) => return Err(Error::NotFound),
        None => 0,
    };
    for document_id in input
        .tabs
        .iter()
        .filter_map(|tab| tab.document_id.as_deref())
    {
        get_document(&tx, owner, document_id)?;
    }
    let revision = next_revision(current, input.expected_revision)?;
    let updated_at = now();
    tx.execute("INSERT INTO workspaces(id,active_tab_id,revision,updated_at,owner_id) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET active_tab_id=excluded.active_tab_id,revision=excluded.revision,updated_at=excluded.updated_at", params![id,input.active_tab_id,revision,updated_at,owner])?;
    tx.execute("DELETE FROM workspace_tabs WHERE workspace_id=?1", [id])?;
    for (position, tab) in input.tabs.iter().enumerate() {
        tx.execute(
            "INSERT INTO workspace_tabs VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                id,
                tab.id,
                tab.document_id,
                position as i64,
                tab.page_index,
                tab.zoom,
                tab.sidebar_open
            ],
        )?;
        if let Some(document_id) = &tab.document_id {
            tx.execute(
                "UPDATE documents SET last_opened_at=?1 WHERE id=?2 AND owner_id=?3",
                params![updated_at, document_id, owner],
            )?;
        }
    }
    tx.commit()?;
    Ok(Workspace {
        id: id.into(),
        revision,
        updated_at,
        active_tab_id: input.active_tab_id,
        tabs: input.tabs,
    })
}
pub fn get_workspace(conn: &Connection, owner: &str, id: &str) -> Result<Workspace> {
    let mut workspace = conn
        .query_row(
            "SELECT revision,updated_at,active_tab_id FROM workspaces WHERE id=?1 AND owner_id=?2",
            [id, owner],
            |r| {
                Ok(Workspace {
                    id: id.into(),
                    revision: r.get(0)?,
                    updated_at: r.get(1)?,
                    active_tab_id: r.get(2)?,
                    tabs: vec![],
                })
            },
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    workspace.tabs = conn.prepare("SELECT id,document_id,page_index,zoom,sidebar_open FROM workspace_tabs WHERE workspace_id=?1 ORDER BY position")?.query_map([id], |r| Ok(Tab { id: r.get(0)?, document_id: r.get(1)?, page_index: r.get(2)?, zoom: r.get(3)?, sidebar_open: r.get(4)? }))?.collect::<rusqlite::Result<_>>()?;
    Ok(workspace)
}
pub fn recovery(conn: &Connection, owner: &str, id: &str) -> Result<Recovery> {
    get_document(conn, owner, id)?;
    conn.query_row("SELECT snapshot_hash,source_hash,revision,length(snapshot_pdf),format_version,updated_at FROM document_recovery WHERE document_id=?1", [id], |r| Ok(Recovery { document_id: id.into(), snapshot_hash: r.get(0)?, source_hash: r.get(1)?, revision: r.get(2)?, size_bytes: r.get(3)?, format_version: r.get(4)?, updated_at: r.get(5)? })).optional()?.ok_or(Error::NotFound)
}
pub fn put_recovery(
    conn: &mut Connection,
    owner: &str,
    id: &str,
    query: RecoveryQuery,
    bytes: Vec<u8>,
) -> Result<Recovery> {
    if query.expected_revision < 0
        || !valid_hash(&query.source_hash)
        || bytes.len() > MAX_PDF_BYTES
        || bytes.len() < 9
        || !bytes.starts_with(b"%PDF-")
    {
        return Err(Error::Invalid(
            "A PDF snapshot (9 bytes..32 MiB), sourceHash and expectedRevision are required",
        ));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    get_document(&tx, owner, id)?;
    let current = tx
        .query_row(
            "SELECT revision FROM document_recovery WHERE document_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let revision = next_revision(current, query.expected_revision)?;
    let hash = sha256(&bytes);
    tx.execute("DELETE FROM editor_drafts WHERE document_id=?1", [id])?;
    tx.execute("INSERT INTO document_recovery(document_id,snapshot_pdf,snapshot_hash,source_hash,revision,updated_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(document_id) DO UPDATE SET snapshot_pdf=excluded.snapshot_pdf,snapshot_hash=excluded.snapshot_hash,source_hash=excluded.source_hash,revision=excluded.revision,updated_at=excluded.updated_at", params![id,bytes,hash,query.source_hash,revision,now()])?;
    let result = recovery(&tx, owner, id)?;
    tx.commit()?;
    Ok(result)
}
pub fn snapshot(conn: &Connection, owner: &str, id: &str) -> Result<Vec<u8>> {
    get_document(conn, owner, id)?;
    conn.query_row(
        "SELECT snapshot_pdf FROM document_recovery WHERE document_id=?1",
        [id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or(Error::NotFound)
}
pub fn put_draft(conn: &mut Connection, owner: &str, id: &str, input: DraftInput) -> Result<Draft> {
    if !valid_hash(&input.snapshot_hash)
        || input.page_index < 0
        || input.expected_revision < 0
        || !input.target_locator.is_object()
        || !input.font_options.is_object()
        || input.original_text.len() > 65536
        || input.draft_text.len() > 65536
        || input
            .alignment
            .as_deref()
            .is_some_and(|a| !["left", "center", "right", "justify"].contains(&a))
        || [input.width, input.height]
            .into_iter()
            .flatten()
            .any(|v| !v.is_finite() || v <= 0.0 || v > 100000.0)
    {
        return Err(Error::Invalid("Invalid draft or snapshot reference"));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let saved = recovery(&tx, owner, id)?;
    if saved.snapshot_hash != input.snapshot_hash {
        return Err(Error::Conflict);
    }
    let current = tx
        .query_row(
            "SELECT revision FROM editor_drafts WHERE document_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let revision = next_revision(current, input.expected_revision)?;
    tx.execute("INSERT INTO editor_drafts VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT(document_id) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,page_index=excluded.page_index,target_locator=excluded.target_locator,original_text=excluded.original_text,draft_text=excluded.draft_text,font_options=excluded.font_options,alignment=excluded.alignment,width=excluded.width,height=excluded.height,revision=excluded.revision,updated_at=excluded.updated_at", params![id,input.snapshot_hash,input.page_index,input.target_locator.to_string(),input.original_text,input.draft_text,input.font_options.to_string(),input.alignment,input.width,input.height,revision,now()])?;
    let result = draft(&tx, owner, id)?;
    tx.commit()?;
    Ok(result)
}
pub fn draft(conn: &Connection, owner: &str, id: &str) -> Result<Draft> {
    get_document(conn, owner, id)?;
    conn.query_row("SELECT snapshot_hash,page_index,target_locator,original_text,draft_text,font_options,alignment,width,height,revision,updated_at FROM editor_drafts WHERE document_id=?1", [id], |r| {
        // Only JSON validated by both serde and the schema is written here.
        let locator: String = r.get(2)?;
        let font: String = r.get(5)?;
        Ok(Draft { document_id: id.into(), snapshot_hash: r.get(0)?, page_index: r.get(1)?, target_locator: serde_json::from_str(&locator).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,Box::new(e)))?, original_text: r.get(3)?, draft_text: r.get(4)?, font_options: serde_json::from_str(&font).map_err(|e| rusqlite::Error::FromSqlConversionFailure(5,rusqlite::types::Type::Text,Box::new(e)))?, alignment: r.get(6)?, width: r.get(7)?, height: r.get(8)?, revision: r.get(9)?, updated_at: r.get(10)? })
    }).optional()?.ok_or(Error::NotFound)
}
