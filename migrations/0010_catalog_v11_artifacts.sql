-- Durable profile-owned S-01 v1.1 exhibition catalog artifacts.
CREATE TABLE IF NOT EXISTS crm_catalog_v11_artifacts (
  profile_ref TEXT NOT NULL,
  exhibition_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_ref, exhibition_id)
);
