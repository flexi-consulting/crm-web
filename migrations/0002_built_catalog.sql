-- Additive tables for an isolated CRM Web D1 binding; never apply to the legacy bot DB.
CREATE TABLE IF NOT EXISTS s02_catalog_builds (
  build_id TEXT PRIMARY KEY,
  profile_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (profile_ref, idempotency_key)
);
CREATE INDEX IF NOT EXISTS s02_builds_profile_event ON s02_catalog_builds(profile_ref, event_id);

CREATE TABLE IF NOT EXISTS s02_catalog_participants (
  build_id TEXT NOT NULL REFERENCES s02_catalog_builds(build_id),
  company_id TEXT NOT NULL,
  participant_json TEXT NOT NULL,
  PRIMARY KEY (build_id, company_id)
);

CREATE TABLE IF NOT EXISTS s02_prelead_build_refs (
  prelead_id TEXT NOT NULL REFERENCES s04_preleads(prelead_id),
  build_id TEXT NOT NULL REFERENCES s02_catalog_builds(build_id),
  company_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (prelead_id, build_id),
  FOREIGN KEY (build_id, company_id) REFERENCES s02_catalog_participants(build_id, company_id)
);
