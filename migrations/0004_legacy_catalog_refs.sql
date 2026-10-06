-- CRM Web owned link map for imported legacy EX snapshots. Never apply to the
-- legacy notes/Telegram Worker database.
CREATE TABLE IF NOT EXISTS s02_legacy_participant_refs (
  profile_ref TEXT NOT NULL,
  event_key TEXT NOT NULL,
  legacy_company_id TEXT NOT NULL,
  build_id TEXT NOT NULL REFERENCES s02_catalog_builds(build_id),
  company_id TEXT NOT NULL,
  PRIMARY KEY (profile_ref, event_key, legacy_company_id, build_id),
  FOREIGN KEY (build_id, company_id) REFERENCES s02_catalog_participants(build_id, company_id)
);
CREATE INDEX IF NOT EXISTS s02_legacy_refs_lookup
  ON s02_legacy_participant_refs(profile_ref, event_key, legacy_company_id);
