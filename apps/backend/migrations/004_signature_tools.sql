CREATE TABLE library_tools_next (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL CHECK(length(owner_id) = 36),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    kind TEXT NOT NULL CHECK(kind IN ('image', 'text', 'watermark', 'signature')),
    content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 1400000),
    created_at INTEGER NOT NULL
) STRICT;

INSERT INTO library_tools_next SELECT id, owner_id, name, kind, content, created_at FROM library_tools;
DROP TABLE library_tools;
ALTER TABLE library_tools_next RENAME TO library_tools;
CREATE INDEX library_tools_owner ON library_tools(owner_id, created_at DESC, id);
