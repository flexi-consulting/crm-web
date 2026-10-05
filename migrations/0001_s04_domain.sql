-- Additive, app-owned S-04 schema for an isolated CRM Web D1 binding.
-- This migration must never be applied to the legacy deal-bot database.
CREATE TABLE IF NOT EXISTS s04_preleads (
  prelead_id TEXT PRIMARY KEY,
  profile_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (profile_ref, event_id, company_id)
);

CREATE TABLE IF NOT EXISTS s04_prelead_events (
  event_id TEXT PRIMARY KEY,
  prelead_id TEXT NOT NULL REFERENCES s04_preleads(prelead_id),
  profile_ref TEXT NOT NULL,
  operation_id TEXT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL CHECK (kind IN ('note_added', 'rejection_added', 'rejection_undone', 'deal_linked')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (prelead_id, sequence),
  UNIQUE (prelead_id, operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS s04_one_deal_link_per_prelead
  ON s04_prelead_events(prelead_id) WHERE kind = 'deal_linked';

CREATE TABLE IF NOT EXISTS s04_deal_reviews (
  review_id TEXT PRIMARY KEY,
  profile_ref TEXT NOT NULL,
  prelead_id TEXT NOT NULL REFERENCES s04_preleads(prelead_id),
  prelead_revision INTEGER NOT NULL,
  revision TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS s04_reviews_profile_prelead ON s04_deal_reviews(profile_ref, prelead_id);

CREATE TABLE IF NOT EXISTS s04_review_receipts (
  receipt_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES s04_deal_reviews(review_id),
  profile_ref TEXT NOT NULL,
  revision TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  issuer_ref TEXT NOT NULL,
  approved INTEGER NOT NULL CHECK (approved = 1),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS s04_receipts_review ON s04_review_receipts(review_id);

CREATE TABLE IF NOT EXISTS s04_deal_operations (
  operation_id TEXT PRIMARY KEY,
  profile_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  prelead_id TEXT NOT NULL REFERENCES s04_preleads(prelead_id),
  review_id TEXT NOT NULL UNIQUE REFERENCES s04_deal_reviews(review_id),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES s04_review_receipts(receipt_id),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unknown', 'created', 'rejected')),
  deal_id TEXT,
  provider_ref TEXT,
  link_status TEXT NOT NULL DEFAULT 'pending' CHECK (link_status IN ('pending', 'linked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'created' OR (deal_id IS NOT NULL AND deal_id <> '')),
  CHECK (link_status <> 'linked' OR status = 'created')
);
CREATE UNIQUE INDEX IF NOT EXISTS s04_one_active_deal_per_participant
  ON s04_deal_operations(profile_ref, event_id, company_id)
  WHERE status IN ('unknown', 'created');
CREATE INDEX IF NOT EXISTS s04_operations_profile_status ON s04_deal_operations(profile_ref, status);
