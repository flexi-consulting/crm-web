const HANDLE = /^[a-f0-9]{64}$/;
const CATALOG_PATH = /^\/catalogs\/build-[a-f0-9]{24}(?:\/participants\/co-[a-f0-9]{20})?$/;
const DEAL_CREATE_PATH = /^\/catalogs\/build-[a-f0-9]{24}\/participants\/co-[a-f0-9]{20}\/deal$/;
const DEAL_PATH = /^\/api\/v1\/(?:deal-reviews\/review-|deal-operations\/op-)[0-9a-f-]{36}$/;
const validReturn = (mode, path) => mode === "catalog" ? CATALOG_PATH.test(path) : mode === "dealCreate"
  ? DEAL_CREATE_PATH.test(path) : mode === "deals" && (path === "/deals" || DEAL_PATH.test(path));
const validTime = (value) => Number.isSafeInteger(value) && value > 0;
const HEX_32 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid_sealed_payload");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), (char) => char.charCodeAt(0));
}

/** D1 DELETE RETURNING makes callback consumption atomic across Worker instances. */
export function createCrmBrowserD1Store(db, { encryptionKey, now = () => Date.now() } = {}) {
  if (!db?.prepare) throw new TypeError("browser_d1_binding_required");
  if (!HEX_32.test(encryptionKey ?? "")) throw new TypeError("browser_encryption_key_required");
  const rawKey = Uint8Array.from(encryptionKey.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
  const importedKey = crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const seal = async (purpose, handleHash, value) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
      additionalData: encoder.encode(`crm-browser-${purpose}-v1:${handleHash}`) }, await importedKey,
    encoder.encode(JSON.stringify(value)));
    return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  };
  const open = async (purpose, handleHash, value) => {
    try {
      const parts = value.split(".");
      if (parts.length !== 2) throw new Error("bad_sealed_payload");
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(parts[0]),
        additionalData: encoder.encode(`crm-browser-${purpose}-v1:${handleHash}`) }, await importedKey, decode(parts[1]));
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch { throw new Error("browser_store_unavailable"); }
  };
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
      const handle = key(handleHash);
      const sealed = await seal("pending", handle, { state: value.state, verifier: value.verifier });
      await db.prepare(`INSERT INTO connected_browser_pending
        (handle_hash, sealed_payload, return_path, mode, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(handle, sealed, value.returnPath, value.mode,
          value.createdAt, value.createdAt + 300_000).run();
    },
    async takePending(handleHash) {
      const handle = key(handleHash);
      const row = await db.prepare(`DELETE FROM connected_browser_pending WHERE handle_hash = ?
        RETURNING sealed_payload, return_path, mode, created_at_ms, expires_at_ms`).bind(handle).first();
      if (!row || row.expires_at_ms <= now()) return null;
      const secrets = await open("pending", handle, row.sealed_payload);
      return { ...secrets, returnPath: row.return_path, mode: row.mode, createdAt: row.created_at_ms };
    },
    async putSession(handleHash, value) {
      const expiry = value?.expiresAt * 1000;
      if (!HANDLE.test(value?.token) || !HANDLE.test(value?.csrf) ||
          !validTime(value?.createdAt) || !validTime(expiry) || expiry <= now())
        throw new TypeError("invalid_browser_session");
      const handle = key(handleHash);
      const sealed = await seal("session", handle, { token: value.token, csrf: value.csrf });
      await db.prepare(`INSERT INTO connected_browser_sessions
        (handle_hash, sealed_payload, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)`)
        .bind(handle, sealed, value.createdAt, expiry).run();
    },
    async getSession(handleHash) {
      const handle = key(handleHash);
      const row = await db.prepare(`SELECT sealed_payload, created_at_ms, expires_at_ms
        FROM connected_browser_sessions WHERE handle_hash = ? AND expires_at_ms > ?`)
        .bind(handle, now()).first();
      return row ? { ...await open("session", handle, row.sealed_payload), createdAt: row.created_at_ms,
        expiresAt: Math.floor(row.expires_at_ms / 1000) } : null;
    },
    async deleteSession(handleHash) {
      await db.prepare("DELETE FROM connected_browser_sessions WHERE handle_hash = ?")
        .bind(key(handleHash)).run();
    }
  };
}
