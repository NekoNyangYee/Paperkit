use crate::{
    db::{self, Error, Result},
    models::*,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn remember(conn: &mut Connection, owner: &str, input: DocumentInput) -> Result<Document> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM documents WHERE owner_id=?1 AND source_path=?2",
            params![owner, input.source_path],
            |r| r.get(0),
        )
        .optional()?;
    let document = if let Some(id) = existing {
        // Validate with the same rules as document creation before updating metadata.
        db::validate_document_input(owner, &input)?;
        tx.execute("UPDATE documents SET display_name=?1,size_bytes=?2,last_opened_at=?3 WHERE id=?4 AND owner_id=?5",
            params![input.display_name,input.size_bytes,now(),id,owner])?;
        db::get_document(&tx, owner, &id)?
    } else {
        db::create_document(&tx, owner, input)?
    };
    tx.commit()?;
    Ok(document)
}

pub fn documents(conn: &Connection, owner: &str, query: LibraryQuery) -> Result<Vec<Document>> {
    let q = query.q.unwrap_or_default();
    if q.chars().count() > 255 {
        return Err(Error::Invalid("Search is too long"));
    }
    // Resolve IDs first to reuse the document serialization contract.
    let mut stmt = conn.prepare("SELECT id FROM documents WHERE owner_id=?1 AND (?2=0 OR favorite=1) AND instr(lower(display_name),lower(?3))>0 ORDER BY favorite DESC,last_opened_at DESC,id LIMIT 50 OFFSET ?4")?;
    let ids = stmt
        .query_map(
            params![
                owner,
                query.favorites.unwrap_or(false),
                q,
                query.offset.unwrap_or(0)
            ],
            |r| r.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.iter()
        .map(|id| db::get_document(conn, owner, id))
        .collect()
}

pub fn favorite(conn: &Connection, owner: &str, id: &str, value: bool) -> Result<Document> {
    if conn.execute(
        "UPDATE documents SET favorite=?1 WHERE id=?2 AND owner_id=?3",
        params![value, id, owner],
    )? == 0
    {
        return Err(Error::NotFound);
    }
    db::get_document(conn, owner, id)
}

fn tool_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTool> {
    Ok(LibraryTool {
        id: row.get(0)?,
        input: ToolInput {
            name: row.get(1)?,
            kind: row.get(2)?,
            content: row.get(3)?,
        },
        created_at: row.get(4)?,
    })
}

pub fn tools(conn: &Connection, owner: &str) -> Result<Vec<LibraryTool>> {
    let mut stmt = conn.prepare("SELECT id,name,kind,content,created_at FROM library_tools WHERE owner_id=?1 ORDER BY created_at DESC,id")?;
    let values = stmt
        .query_map([owner], tool_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
}

fn validate_tool(owner: &str, input: &ToolInput) -> Result<()> {
    if !db::valid_id(owner)
        || input.name.trim().is_empty()
        || input.name.chars().count() > 80
        || input.name.chars().any(char::is_control)
    {
        return Err(Error::Invalid("Invalid tool name"));
    }
    if input.content.trim().is_empty() {
        return Err(Error::Invalid("Tool content is required"));
    }
    match input.kind.as_str() {
        "text" | "watermark"
            if input.content.chars().count() <= 4000 && input.content.len() <= 16000 => {}
        "image" | "signature" => {
            let encoded = input
                .content
                .strip_prefix("data:image/png;base64,")
                .ok_or(Error::Invalid("Use a PNG image"))?;
            if encoded.len() > 1_398_104 {
                return Err(Error::Invalid("Image must be at most 1 MB"));
            }
            let png = STANDARD
                .decode(encoded)
                .map_err(|_| Error::Invalid("Invalid PNG"))?;
            if png.len() < 24 || !png.starts_with(b"\x89PNG\r\n\x1a\n") || &png[12..16] != b"IHDR" {
                return Err(Error::Invalid("Invalid PNG"));
            }
            let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
            let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
            if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
                return Err(Error::Invalid("Image dimensions are too large"));
            }
        }
        _ => return Err(Error::Invalid("Invalid tool kind or content length")),
    }
    Ok(())
}

pub fn create_tool(conn: &mut Connection, owner: &str, input: ToolInput) -> Result<LibraryTool> {
    validate_tool(owner, &input)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM library_tools WHERE owner_id=?1",
        [owner],
        |r| r.get(0),
    )?;
    if count >= 50 {
        return Err(Error::Invalid("At most 50 tools can be saved"));
    }
    let tool = LibraryTool {
        id: Uuid::new_v4().to_string(),
        input,
        created_at: now(),
    };
    tx.execute(
        "INSERT INTO library_tools VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            tool.id,
            owner,
            tool.input.name,
            tool.input.kind,
            tool.input.content,
            tool.created_at
        ],
    )?;
    tx.commit()?;
    Ok(tool)
}

pub fn update_tool(
    conn: &Connection,
    owner: &str,
    id: &str,
    input: ToolInput,
) -> Result<LibraryTool> {
    let existing = conn
        .query_row(
            "SELECT id,name,kind,content,created_at FROM library_tools WHERE id=?1 AND owner_id=?2",
            params![id, owner],
            tool_row,
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    validate_tool(owner, &input)?;
    if input.kind != existing.input.kind {
        return Err(Error::Invalid("Tool kind cannot be changed"));
    }
    conn.execute(
        "UPDATE library_tools SET name=?1,content=?2 WHERE id=?3 AND owner_id=?4",
        params![input.name, input.content, id, owner],
    )?;
    Ok(LibraryTool {
        id: existing.id,
        input,
        created_at: existing.created_at,
    })
}

pub fn delete_tool(conn: &Connection, owner: &str, id: &str) -> Result<()> {
    if conn.execute(
        "DELETE FROM library_tools WHERE id=?1 AND owner_id=?2",
        params![id, owner],
    )? == 0
    {
        return Err(Error::NotFound);
    }
    Ok(())
}
