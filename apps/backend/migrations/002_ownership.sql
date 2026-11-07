-- Legacy records retain NULL ownership and are invisible to authenticated users.
-- They must be explicitly assigned by an operator, never claimed by first login.
CREATE TABLE documents_v2 (
    id TEXT PRIMARY KEY NOT NULL,
    source_path TEXT NOT NULL CHECK(length(source_path) BETWEEN 1 AND 4096),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 255),
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    source_modified_at INTEGER,
    source_hash TEXT CHECK(source_hash IS NULL OR
        (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*')),
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL,
    owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) = 36),
    UNIQUE(owner_id, source_path)
) STRICT;
INSERT INTO documents_v2
    SELECT id, source_path, display_name, size_bytes, source_modified_at,
        source_hash, created_at, last_opened_at, NULL FROM documents;
DROP TABLE documents;
ALTER TABLE documents_v2 RENAME TO documents;
CREATE INDEX documents_owner_recent ON documents(owner_id, last_opened_at DESC, id);

ALTER TABLE workspaces ADD COLUMN owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) = 36);
CREATE INDEX workspaces_owner ON workspaces(owner_id);

CREATE TRIGGER workspace_tab_owner_insert BEFORE INSERT ON workspace_tabs
WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d JOIN workspaces w ON w.id = NEW.workspace_id
    WHERE d.id = NEW.document_id AND d.owner_id IS w.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Document and workspace owners must match'); END;

CREATE TRIGGER workspace_tab_owner_update BEFORE UPDATE ON workspace_tabs
WHEN NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM documents d JOIN workspaces w ON w.id = NEW.workspace_id
    WHERE d.id = NEW.document_id AND d.owner_id IS w.owner_id
)
BEGIN SELECT RAISE(ABORT, 'Document and workspace owners must match'); END;
