-- Additive identity rule for the app-owned CRM Web D1 candidate only.
-- Do not apply to the legacy deal-bot database.
CREATE UNIQUE INDEX IF NOT EXISTS s04_one_operation_per_profile_deal_id
  ON s04_deal_operations(profile_ref, deal_id) WHERE deal_id IS NOT NULL;
