CREATE TABLE IF NOT EXISTS weeek_fixture_deals (
  id TEXT PRIMARY KEY,
  status_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weeek_fixture_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  path TEXT NOT NULL
);
