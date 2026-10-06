export function parseLegacyExHtml(bytes) {
  const html = Buffer.from(bytes).toString("utf8");
  const eventMatch = html.match(/\bconst EVENT_KEY\s*=\s*['"]([a-z0-9][a-z0-9-]{0,79})['"]\s*;/);
  const marker = /\bconst EX\s*=\s*/g.exec(html);
  if (!eventMatch || !marker) throw new Error("legacy_html_header_invalid");
  const start = html.indexOf("[", marker.index + marker[0].length);
  if (start < 0 || html.slice(marker.index + marker[0].length, start).trim())
    throw new Error("legacy_ex_array_missing");
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let index = start; index < html.length; index++) {
    const ch = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) { end = index + 1; break; }
  }
  if (end < 0 || html.slice(end).trimStart()[0] !== ";") throw new Error("legacy_ex_array_invalid");
  let entries;
  try { entries = JSON.parse(html.slice(start, end)); } catch { throw new Error("legacy_ex_array_invalid"); }
  if (!Array.isArray(entries)) throw new Error("legacy_ex_array_invalid");
  return { eventKey: eventMatch[1], entries };
}
