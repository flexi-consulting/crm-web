-- Invalidate any pre-release sessions and pending PKCE handoffs, then store
-- their sensitive fields only as Worker-sealed AES-GCM payloads.
DROP TABLE connected_browser_pending;
CREATE TABLE connected_browser_pending (
  handle_hash TEXT PRIMARY KEY CHECK(length(handle_hash) = 64),
  sealed_payload TEXT NOT NULL,
  return_path TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  mode TEXT CHECK(mode IN ('catalog', 'deals', 'dealCreate'))
);
CREATE INDEX connected_browser_pending_expiry ON connected_browser_pending(expires_at_ms);

DROP TABLE connected_browser_sessions;
CREATE TABLE connected_browser_sessions (
  handle_hash TEXT PRIMARY KEY CHECK(length(handle_hash) = 64),
  sealed_payload TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX connected_browser_sessions_expiry ON connected_browser_sessions(expires_at_ms);
