-- App-owned browser credentials. Apply only to the separate CRM Web D1 database.
CREATE TABLE IF NOT EXISTS connected_browser_pending (
  handle_hash TEXT PRIMARY KEY CHECK(length(handle_hash) = 64),
  state TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connected_browser_pending_expiry
  ON connected_browser_pending(expires_at_ms);

CREATE TABLE IF NOT EXISTS connected_browser_sessions (
  handle_hash TEXT PRIMARY KEY CHECK(length(handle_hash) = 64),
  token TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connected_browser_sessions_expiry
  ON connected_browser_sessions(expires_at_ms);
