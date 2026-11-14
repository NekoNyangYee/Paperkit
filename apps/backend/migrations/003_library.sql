ALTER TABLE documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1));

CREATE TABLE library_tools (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL CHECK(length(owner_id) = 36),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    kind TEXT NOT NULL CHECK(kind IN ('image', 'text', 'watermark')),
    content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 1400000),
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX library_tools_owner ON library_tools(owner_id, created_at DESC, id);
