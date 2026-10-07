-- CRM's durable pointer to a CP-owned human approval intent. The CP remains
-- the sole approval authority; this table only prevents CRM from losing the
-- intent between the approval page and the later create command.
CREATE TABLE crm_cp_approval_intents (
  profile_ref TEXT NOT NULL,
  review_id TEXT NOT NULL,
  revision TEXT NOT NULL CHECK (length(revision) = 64),
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  intent_id TEXT NOT NULL UNIQUE CHECK (length(intent_id) = 64),
  approval_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_ref, review_id)
);
CREATE INDEX idx_crm_cp_approval_intents_expiry ON crm_cp_approval_intents(expires_at);
