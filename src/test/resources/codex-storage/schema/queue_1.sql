-- Schema-only fixture; no user records.
CREATE TABLE _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
);

CREATE TABLE queued_items (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    queue_order INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE queued_thread_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL UNIQUE
);

CREATE UNIQUE INDEX queued_items_thread_order_idx
    ON queued_items(thread_id, queue_order);

CREATE TRIGGER queued_items_revision_after_delete
AFTER DELETE ON queued_items
BEGIN
    INSERT INTO queued_thread_revisions (thread_id)
    VALUES (OLD.thread_id)
    ON CONFLICT(thread_id) DO UPDATE
    SET revision = (SELECT COALESCE(MAX(revision), 0) + 1 FROM queued_thread_revisions);
END;

CREATE TRIGGER queued_items_revision_after_insert
AFTER INSERT ON queued_items
BEGIN
    INSERT INTO queued_thread_revisions (thread_id)
    VALUES (NEW.thread_id)
    ON CONFLICT(thread_id) DO UPDATE
    SET revision = (SELECT COALESCE(MAX(revision), 0) + 1 FROM queued_thread_revisions);
END;

CREATE TRIGGER queued_items_revision_after_update
AFTER UPDATE ON queued_items
BEGIN
    INSERT INTO queued_thread_revisions (thread_id)
    VALUES (NEW.thread_id)
    ON CONFLICT(thread_id) DO UPDATE
    SET revision = (SELECT COALESCE(MAX(revision), 0) + 1 FROM queued_thread_revisions);
END;
