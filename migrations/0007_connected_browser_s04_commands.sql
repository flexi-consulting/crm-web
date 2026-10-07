-- Add a dedicated CP write-scope handoff mode for S-04 browser confirmation.
-- Rebuild the pending table to expand its CHECK without changing live sessions.
CREATE TABLE connected_browser_pending_s04 (
  handle_hash TEXT PRIMARY KEY CHECK(length(handle_hash) = 64),
  state TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_path TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  mode TEXT CHECK(mode IN ('catalog', 'deals', 'dealCreate'))
);
INSERT INTO connected_browser_pending_s04
  (handle_hash, state, verifier, return_path, created_at_ms, expires_at_ms, mode)
SELECT handle_hash, state, verifier, return_path, created_at_ms, expires_at_ms, mode
FROM connected_browser_pending;
DROP TABLE connected_browser_pending;
ALTER TABLE connected_browser_pending_s04 RENAME TO connected_browser_pending;
CREATE INDEX connected_browser_pending_expiry ON connected_browser_pending(expires_at_ms);
