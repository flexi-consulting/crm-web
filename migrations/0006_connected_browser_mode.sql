-- Existing one-use pending handoffs have no explicit requested capability and fail closed.
ALTER TABLE connected_browser_pending ADD COLUMN mode TEXT CHECK(mode IN ('catalog', 'deals'));
