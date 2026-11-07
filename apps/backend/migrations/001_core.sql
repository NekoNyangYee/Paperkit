-- Millisecond UTC timestamps. One trusted operator namespace, not multi-user accounts.
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE documents (
    id TEXT PRIMARY KEY NOT NULL,
    source_path TEXT NOT NULL UNIQUE CHECK(length(source_path) BETWEEN 1 AND 4096),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255),
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    source_modified_at INTEGER,
    source_hash TEXT CHECK(source_hash IS NULL OR
        (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*')),
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    active_tab_id TEXT,
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (id, active_tab_id) REFERENCES workspace_tabs(workspace_id, id)
        DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE workspace_tabs (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    page_index INTEGER NOT NULL CHECK(page_index >= 0),
    zoom REAL NOT NULL CHECK(zoom BETWEEN 25 AND 400),
    sidebar_open INTEGER NOT NULL CHECK(sidebar_open IN (0, 1)),
    PRIMARY KEY (workspace_id, id),
    UNIQUE (workspace_id, position),
    UNIQUE (workspace_id, document_id)
) STRICT;
CREATE INDEX workspace_tabs_document ON workspace_tabs(document_id);

-- A single latest PDF per document. BLOB + metadata commit and back up together.
-- The input is a recovery snapshot, not a server-side PDF editing service.
CREATE TABLE document_recovery (
    document_id TEXT PRIMARY KEY NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    snapshot_pdf BLOB NOT NULL CHECK(length(snapshot_pdf) BETWEEN 9 AND 33554432),
    snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    source_hash TEXT NOT NULL CHECK(length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL CHECK(revision > 0),
    format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version = 1),
    updated_at INTEGER NOT NULL,
    UNIQUE (document_id, snapshot_hash)
) STRICT;

CREATE TABLE editor_drafts (
    document_id TEXT PRIMARY KEY NOT NULL,
    snapshot_hash TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK(page_index >= 0),
    target_locator TEXT NOT NULL CHECK(json_valid(target_locator)),
    original_text TEXT NOT NULL,
    draft_text TEXT NOT NULL,
    font_options TEXT NOT NULL CHECK(json_valid(font_options)),
    alignment TEXT CHECK(alignment IN ('left', 'center', 'right', 'justify')),
    width REAL CHECK(width > 0),
    height REAL CHECK(height > 0),
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (document_id, snapshot_hash)
        REFERENCES document_recovery(document_id, snapshot_hash) ON DELETE CASCADE
) STRICT;
