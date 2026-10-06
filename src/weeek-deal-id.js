// Weeek documents a string ID unique within the deal resource of a workspace,
// but does not publish a UUID or numeric pattern. Keep the exact opaque value.
// Bound it for storage/URLs and reject path dot segments and invisible controls.
export function isWeeekDealId(value) {
  if (typeof value !== "string" || !/^(?!\.{1,2}$)[^\s\x00-\x1f\x7f]{1,256}$/u.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}
