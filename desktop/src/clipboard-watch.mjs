// Clipboard watching to detect an EVE Local list.
// ──────────────────────────────────────────────────────────────────────────
// In EVE you can select the pilots in the Local window (Ctrl+A) and copy them
// (Ctrl+C): the client puts one name per line on the clipboard, exact text.
// Here we do lightweight polling of the clipboard (Electron doesn't expose a
// "change" event), and with a heuristic based on EVE name rules we decide
// whether the copied text is plausibly a Local. If so, we notify via
// callback (the main process shows a system notification asking for confirmation).
// OPT-IN feature: watching only starts when the user enables it.
import { clipboard } from "electron";

let timer = null;
let lastText = "";          // last content seen (avoids reprocessing)
let lastHandledHash = "";   // last Local already reported (avoids duplicates)
let enabled = false;
let onDetect = null;        // callback(names[])

// Is a line a plausible EVE name? Names: 3–37 chars, start with a letter,
// only letters/digits/space/apostrophe/dot/hyphen, max 3 words (2 spaces).
const NAME_RE = /^[\p{L}][\p{L}\p{N}'’.\- ]{2,36}$/u;
function isNameLine(l) {
  if (!NAME_RE.test(l)) return false;
  if ((l.match(/ /g) || []).length > 2) return false;   // max 3 words
  if (/https?:|@|\/|[{}\[\]<>|=;:,]/.test(l)) return false;  // discard URLs/syntax
  return true;
}

/**
 * Returns the array of names if `text` looks like a Local, otherwise null.
 * Robust to the real EVE client copy: any line-ending (\r\n / \r / \n), and a
 * line that carries extra columns (tab- or multi-space-separated, e.g. a status)
 * → we take the first field as the name. Tolerates up to 2 stray lines (a header/
 * footer) so the whole Local isn't discarded for one odd row.
 */
export function isLocalList(text) {
  if (!text || text.length > 20000) return null;
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const names = [];
  let bad = 0;
  for (const l of lines) {
    const cand = l.split(/\t| {2,}/)[0].trim();   // first column (drop trailing status/extra)
    if (isNameLine(cand)) names.push(cand); else bad++;
  }
  const uniq = [...new Set(names)];
  return (uniq.length >= 3 && bad <= 2) ? uniq : null;
}

function tick() {
  let t = "";
  try { t = clipboard.readText(); } catch { return; }
  if (t === lastText) return;
  lastText = t;
  const names = isLocalList(t);
  if (!names) return;
  const hash = names.join("|");
  if (hash === lastHandledHash) return;   // same Local already handled
  lastHandledHash = hash;
  onDetect?.(names);
}

export function startWatch(cb) {
  onDetect = cb;
  lastText = (() => { try { return clipboard.readText(); } catch { return ""; } })();  // don't trigger on content already present
  if (!timer) timer = setInterval(tick, 800);
  enabled = true;
}

export function stopWatch() {
  if (timer) { clearInterval(timer); timer = null; }
  enabled = false;
}

export function isEnabled() { return enabled; }

// Immediate manual scan of the clipboard (for the "scan now" button).
export function scanNow() {
  try { return isLocalList(clipboard.readText()); } catch { return null; }
}
