use paperkit_api::{
    db::{self, Database, Error},
    models::*,
};
use serde_json::json;
use tempfile::TempDir;
use uuid::Uuid;

const OWNER: &str = "11111111-1111-4111-8111-111111111111";

fn fixture() -> (TempDir, Database) {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("test.sqlite3")).unwrap();
    (directory, database)
}

#[tokio::test]
async fn signature_migration_preserves_existing_tools_and_documents() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("test.sqlite3");
    let mut old = rusqlite::Connection::open(&path).unwrap();
    for (index, sql) in [
        include_str!("../migrations/001_core.sql"),
        include_str!("../migrations/002_ownership.sql"),
        include_str!("../migrations/003_library.sql"),
    ]
    .iter()
    .enumerate()
    {
        let tx = old.transaction().unwrap();
        tx.execute_batch(sql).unwrap();
        tx.execute(
            "INSERT INTO schema_migrations VALUES (?1,?2,0)",
            rusqlite::params![index as i64 + 1, db::sha256(sql.as_bytes())],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    old.pragma_update(None, "application_id", 0x504b4954)
        .unwrap();
    old.pragma_update(None, "user_version", 3).unwrap();
    let document = db::create_document(&old, OWNER, document()).unwrap();
    old.execute(
        "INSERT INTO library_tools VALUES (?1,?2,'기존 문구','text','보존할 내용',123)",
        rusqlite::params!["old-tool", OWNER],
    )
    .unwrap();
    drop(old);
    let migrated = Database::open(&path).unwrap();
    migrated
        .run(move |conn| {
            let tools = paperkit_api::library::tools(conn, OWNER)?;
            assert_eq!(tools.len(), 1);
            assert_eq!(tools[0].id, "old-tool");
            assert_eq!(tools[0].input.content, "보존할 내용");
            assert_eq!(tools[0].created_at, 123);
            assert_eq!(
                db::get_document(conn, OWNER, &document.id)?
                    .input
                    .display_name,
                "원본.pdf"
            );
            assert_eq!(
                conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))?,
                "ok"
            );
            Ok(())
        })
        .await
        .unwrap();
    drop(migrated);
    Database::open(&path).unwrap();
}
fn document() -> DocumentInput {
    DocumentInput {
        source_path: "C:\\문서\\원본.pdf".into(),
        display_name: "원본.pdf".into(),
        size_bytes: 100,
        source_modified_at: Some(123),
        source_hash: Some("a".repeat(64)),
    }
}
fn workspace(document_id: &str, expected_revision: i64) -> WorkspaceInput {
    let tab_id = Uuid::new_v4().to_string();
    WorkspaceInput {
        expected_revision,
        active_tab_id: Some(tab_id.clone()),
        tabs: vec![Tab {
            id: tab_id,
            document_id: Some(document_id.into()),
            page_index: 3,
            zoom: 125.0,
            sidebar_open: false,
        }],
    }
}
fn recovery(expected_revision: i64) -> RecoveryQuery {
    RecoveryQuery {
        expected_revision,
        source_hash: "a".repeat(64),
    }
}
fn draft(hash: String, expected_revision: i64) -> DraftInput {
    DraftInput {
        expected_revision,
        snapshot_hash: hash,
        page_index: 0,
        target_locator: json!({"object":2}),
        original_text: "원문".into(),
        draft_text: "입력 중".into(),
        font_options: json!({}),
        alignment: Some("left".into()),
        width: Some(120.0),
        height: None,
    }
}

#[tokio::test]
async fn migration_is_repeatable_and_backup_preserves_committed_state() {
    let (directory, database) = fixture();
    let created = database
        .run(|conn| db::create_document(conn, OWNER, document()))
        .await
        .unwrap();
    drop(database);
    let database = Database::open(&directory.path().join("test.sqlite3")).unwrap();
    let id = created.id;
    database
        .run(move |conn| {
            assert_eq!(
                db::get_document(conn, OWNER, &id)?.input.display_name,
                "원본.pdf"
            );
            assert_eq!(
                conn.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                conn.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))?,
                2
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM schema_migrations", [], |r| r
                    .get::<_, i64>(0))?,
                db::SCHEMA_VERSION as i64
            );
            Ok(())
        })
        .await
        .unwrap();
    let backup = directory.path().join("backup.sqlite3");
    database.backup(&backup).unwrap();
    assert!(database.backup(&backup).is_err());
    let restored = Database::open(&backup).unwrap();
    assert_eq!(
        restored
            .run(|c| db::list_documents(c, OWNER, 10, 0))
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn workspace_cas_and_foreign_key_failure_roll_back_the_entire_update() {
    let (_directory, database) = fixture();
    database
        .run(|conn| {
            let doc = db::create_document(conn, OWNER, document())?;
            let id = Uuid::new_v4().to_string();
            let first = db::put_workspace(conn, OWNER, &id, workspace(&doc.id, 0))?;
            assert!(matches!(
                db::put_workspace(conn, OWNER, &id, workspace(&doc.id, 0)),
                Err(Error::Conflict)
            ));
            let missing = Uuid::new_v4().to_string();
            assert!(matches!(
                db::put_workspace(conn, OWNER, &id, workspace(&missing, 1)),
                Err(Error::NotFound)
            ));
            let loaded = db::get_workspace(conn, OWNER, &id)?;
            assert_eq!(loaded.revision, 1);
            assert_eq!(loaded.tabs[0].id, first.tabs[0].id);
            let second = db::put_workspace(conn, OWNER, &id, workspace(&doc.id, 1))?;
            assert_eq!(second.revision, 2);
            assert_eq!(db::get_workspace(conn, OWNER, &id)?.tabs[0].zoom, 125.0);
            db::delete_document(conn, OWNER, &doc.id)?;
            assert!(db::get_workspace(conn, OWNER, &id)?.tabs[0]
                .document_id
                .is_none());
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn recovery_cas_invalidates_drafts_and_document_delete_cascades() {
    let (_directory, database) = fixture();
    database
        .run(|conn| {
            let doc = db::create_document(conn, OWNER, document())?;
            let original = b"%PDF-1.7\noriginal".to_vec();
            let first = db::put_recovery(conn, OWNER, &doc.id, recovery(0), original.clone())?;
            assert_eq!(db::snapshot(conn, OWNER, &doc.id)?, original);
            assert!(matches!(
                db::put_draft(conn, OWNER, &doc.id, draft("b".repeat(64), 0)),
                Err(Error::Conflict)
            ));
            let saved_draft =
                db::put_draft(conn, OWNER, &doc.id, draft(first.snapshot_hash.clone(), 0))?;
            assert_eq!(saved_draft.revision, 1);
            assert_eq!(db::draft(conn, OWNER, &doc.id)?.draft_text, "입력 중");
            assert!(matches!(
                db::put_draft(conn, OWNER, &doc.id, draft(first.snapshot_hash.clone(), 0)),
                Err(Error::Conflict)
            ));
            assert!(matches!(
                db::put_recovery(conn, OWNER, &doc.id, recovery(0), original),
                Err(Error::Conflict)
            ));
            assert!(db::draft(conn, OWNER, &doc.id).is_ok());
            db::put_recovery(
                conn,
                OWNER,
                &doc.id,
                recovery(1),
                b"%PDF-1.7\nchanged".to_vec(),
            )?;
            assert!(matches!(
                db::draft(conn, OWNER, &doc.id),
                Err(Error::NotFound)
            ));
            db::delete_document(conn, OWNER, &doc.id)?;
            assert!(matches!(
                db::recovery(conn, OWNER, &doc.id),
                Err(Error::NotFound)
            ));
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn rejects_invalid_metadata_snapshot_and_active_tab() {
    let (_directory, database) = fixture();
    database
        .run(|conn| {
            let mut invalid = document();
            invalid.source_path = "\n".into();
            assert!(matches!(
                db::create_document(conn, OWNER, invalid),
                Err(Error::Invalid(_))
            ));
            let doc = db::create_document(conn, OWNER, document())?;
            assert!(matches!(
                db::create_document(conn, OWNER, document()),
                Err(Error::Conflict)
            ));
            assert!(matches!(
                db::put_recovery(conn, OWNER, &doc.id, recovery(0), b"not a pdf".to_vec()),
                Err(Error::Invalid(_))
            ));
            let mut input = workspace(&doc.id, 0);
            input.active_tab_id = Some(Uuid::new_v4().to_string());
            assert!(matches!(
                db::put_workspace(conn, OWNER, &Uuid::new_v4().to_string(), input),
                Err(Error::Invalid(_))
            ));
            Ok(())
        })
        .await
        .unwrap();
}

#[test]
fn refuses_unrecognized_database_and_modified_applied_migration() {
    let directory = tempfile::tempdir().unwrap();
    let foreign = directory.path().join("foreign.sqlite3");
    let conn = rusqlite::Connection::open(&foreign).unwrap();
    conn.execute_batch("CREATE TABLE other_service(secret TEXT)")
        .unwrap();
    drop(conn);
    assert!(Database::open(&foreign).is_err());
    let path = directory.path().join("paperkit.sqlite3");
    drop(Database::open(&path).unwrap());
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE schema_migrations SET checksum='invalid'", [])
        .unwrap();
    drop(conn);
    assert!(Database::open(&path).is_err());
}

#[tokio::test]
async fn ownership_protects_every_resource_and_allows_identical_paths_for_different_users() {
    let (_directory, database) = fixture();
    database
        .run(|conn| {
            let other = "22222222-2222-4222-8222-222222222222";
            let a = db::create_document(conn, OWNER, document())?;
            let b = db::create_document(conn, other, document())?;
            assert_ne!(a.id, b.id);
            assert_eq!(db::list_documents(conn, OWNER, 100, 0)?.len(), 1);
            assert_eq!(db::list_documents(conn, other, 100, 0)?.len(), 1);
            assert!(matches!(
                db::get_document(conn, other, &a.id),
                Err(Error::NotFound)
            ));
            assert!(matches!(
                db::delete_document(conn, other, &a.id),
                Err(Error::NotFound)
            ));
            let workspace_id = Uuid::new_v4().to_string();
            db::put_workspace(conn, OWNER, &workspace_id, workspace(&a.id, 0))?;
            assert!(matches!(
                db::get_workspace(conn, other, &workspace_id),
                Err(Error::NotFound)
            ));
            assert!(matches!(
                db::put_workspace(conn, other, &workspace_id, workspace(&b.id, 1)),
                Err(Error::NotFound)
            ));
            assert!(matches!(
                db::put_workspace(
                    conn,
                    other,
                    &Uuid::new_v4().to_string(),
                    workspace(&a.id, 0)
                ),
                Err(Error::NotFound)
            ));
            let saved = db::put_recovery(
                conn,
                OWNER,
                &a.id,
                recovery(0),
                b"%PDF-1.7\nprivate".to_vec(),
            )?;
            db::put_draft(conn, OWNER, &a.id, draft(saved.snapshot_hash.clone(), 0))?;
            assert!(matches!(
                db::recovery(conn, other, &a.id),
                Err(Error::NotFound)
            ));
            assert!(matches!(
                db::snapshot(conn, other, &a.id),
                Err(Error::NotFound)
            ));
            assert!(matches!(
                db::draft(conn, other, &a.id),
                Err(Error::NotFound)
            ));
            assert!(matches!(
                db::put_recovery(
                    conn,
                    other,
                    &a.id,
                    recovery(1),
                    b"%PDF-1.7\nattack".to_vec()
                ),
                Err(Error::NotFound)
            ));
            assert!(matches!(
                db::put_draft(conn, other, &a.id, draft(saved.snapshot_hash, 1)),
                Err(Error::NotFound)
            ));
            assert_eq!(db::draft(conn, OWNER, &a.id)?.draft_text, "입력 중");
            Ok(())
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn legacy_migration_preserves_documents_tabs_recovery_and_drafts_without_assigning_an_owner()
{
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.sqlite3");
    let old = rusqlite::Connection::open(&path).unwrap();
    let migration = include_str!("../migrations/001_core.sql");
    old.execute_batch(migration).unwrap();
    old.execute(
        "INSERT INTO schema_migrations VALUES (1,?1,0)",
        [db::sha256(migration.as_bytes())],
    )
    .unwrap();
    old.pragma_update(None, "application_id", 0x504b4954)
        .unwrap();
    old.pragma_update(None, "user_version", 1).unwrap();
    let id = Uuid::new_v4().to_string();
    old.execute(
        "INSERT INTO documents VALUES (?1,'legacy.pdf','legacy.pdf',9,NULL,NULL,0,0)",
        [&id],
    )
    .unwrap();
    old.execute_batch("BEGIN").unwrap();
    old.execute(
        "INSERT INTO workspaces VALUES ('old-workspace','old-tab',1,0)",
        [],
    )
    .unwrap();
    old.execute(
        "INSERT INTO workspace_tabs VALUES ('old-workspace','old-tab',?1,0,0,100,1)",
        [&id],
    )
    .unwrap();
    let hash = "a".repeat(64);
    old.execute(
        "INSERT INTO document_recovery VALUES (?1,?2,?3,?3,1,1,0)",
        rusqlite::params![id, b"%PDF-1.7\n".as_slice(), hash],
    )
    .unwrap();
    old.execute(
        "INSERT INTO editor_drafts VALUES (?1,?2,0,'{}','before','after','{}',NULL,NULL,NULL,1,0)",
        rusqlite::params![id, hash],
    )
    .unwrap();
    old.execute_batch("COMMIT").unwrap();
    drop(old);
    let database = Database::open(&path).unwrap();
    database
        .run(move |conn| {
            assert!(matches!(
                db::get_document(conn, OWNER, &id),
                Err(Error::NotFound)
            ));
            for table in [
                "documents",
                "workspaces",
                "workspace_tabs",
                "document_recovery",
                "editor_drafts",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))?,
                    1
                );
            }
            assert_eq!(
                conn.query_row("SELECT draft_text FROM editor_drafts", [], |r| r
                    .get::<_, String>(0))?,
                "after"
            );
            Ok(())
        })
        .await
        .unwrap();
}
