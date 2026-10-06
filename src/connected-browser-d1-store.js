const HANDLE = /^[a-f0-9]{64}$/;
const CATALOG_PATH = /^\/catalogs\/build-[a-f0-9]{24}(?:\/participants\/co-[a-f0-9]{20})?$/;
const DEAL_CREATE_PATH = /^\/catalogs\/build-[a-f0-9]{24}\/participants\/co-[a-f0-9]{20}\/deal$/;
const DEAL_PATH = /^\/api\/v1\/(?:deal-reviews\/review-|deal-operations\/op-)[0-9a-f-]{36}$/;
const validReturn = (mode, path) => mode === "catalog" ? CATALOG_PATH.test(path) : mode === "dealCreate"
  ? DEAL_CREATE_PATH.test(path) : mode === "deals" && (path === "/deals" || DEAL_PATH.test(path));
const validTime = (value) => Number.isSafeInteger(value) && value > 0;

/** D1 DELETE RETURNING makes callback consumption atomic across Worker instances. */
export function createCrmBrowserD1Store(db, { now = () => Date.now() } = {}) {
  if (!db?.prepare) throw new TypeError("browser_d1_binding_required");
  const key = (value) => {
    if (!HANDLE.test(value)) throw new TypeError("invalid_browser_handle_hash");
    return value;
  };
  return {
    async pruneExpired() {
      const cutoff = now();
      await db.prepare("DELETE FROM connected_browser_pending WHERE expires_at_ms <= ?").bind(cutoff).run();
      await db.prepare("DELETE FROM connected_browser_sessions WHERE expires_at_ms <= ?").bind(cutoff).run();
    },
    async putPending(handleHash, value) {
      if (!HANDLE.test(value?.state) || !HANDLE.test(value?.verifier) ||
          !validReturn(value?.mode, value?.returnPath) || !validTime(value?.createdAt))
        throw new TypeError("invalid_pending_transaction");
      await this.pruneExpired();
      await db.prepare(`INSERT INTO connected_browser_pending
        (handle_hash, state, verifier, return_path, mode, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(key(handleHash), value.state, value.verifier, value.returnPath, value.mode,
          value.createdAt, value.createdAt + 300_000).run();
    },
    async takePending(handleHash) {
      const row = await db.prepare(`DELETE FROM connected_browser_pending WHERE handle_hash = ?
        RETURNING state, verifier, return_path, mode, created_at_ms, expires_at_ms`).bind(key(handleHash)).first();
      return row && row.expires_at_ms > now()
        ? { state: row.state, verifier: row.verifier, returnPath: row.return_path, mode: row.mode,
          createdAt: row.created_at_ms } : null;
    },
    async putSession(handleHash, value) {
      const expiry = value?.expiresAt * 1000;
      if (!HANDLE.test(value?.token) || !HANDLE.test(value?.csrf) ||
          !validTime(value?.createdAt) || !validTime(expiry) || expiry <= now())
        throw new TypeError("invalid_browser_session");
      await db.prepare(`INSERT INTO connected_browser_sessions
        (handle_hash, token, csrf, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)`)
        .bind(key(handleHash), value.token, value.csrf, value.createdAt, expiry).run();
    },
    async getSession(handleHash) {
      const row = await db.prepare(`SELECT token, csrf, created_at_ms, expires_at_ms
        FROM connected_browser_sessions WHERE handle_hash = ? AND expires_at_ms > ?`)
        .bind(key(handleHash), now()).first();
      return row ? { token: row.token, csrf: row.csrf, createdAt: row.created_at_ms,
        expiresAt: Math.floor(row.expires_at_ms / 1000) } : null;
    },
    async deleteSession(handleHash) {
      await db.prepare("DELETE FROM connected_browser_sessions WHERE handle_hash = ?")
        .bind(key(handleHash)).run();
    }
  };
}
