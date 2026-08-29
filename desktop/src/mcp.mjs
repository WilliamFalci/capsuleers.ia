// Minimal client for the EVE-KILL analytics tools.
// https://eve-kill.com/api/mcp/tools/<tool> — public, no auth.
//
// We do NOT use LLM tool-calling here: the local chat model is small and the app's
// architecture routes live data by intent regexes, not by the model. So we invoke the
// tools DIRECTLY (like a REST API) and feed the JSON result into the RAG context,
// exactly as intel.mjs / esi.mjs / eve-scout.mjs already do. They give us higher-level,
// pre-computed analytics (dossier, route danger, dogma stats, battle reports…) that
// would otherwise take many REST calls to assemble.
//
// ── 2026-08-29: this stopped being MCP-over-JSON-RPC ─────────────────────────────
// eve-kill folded every subdomain into the main app. `mcp.eve-kill.com/mcp` no longer
// speaks JSON-RPC at all — it answers 200 `text/html` (the marketing page for their MCP
// server), so the old client's `JSON.parse` failed on every call and every live block
// silently disappeared from the answers. The tools now live in the main OpenAPI surface
// as plain `POST /api/mcp/tools/<name>`.
//
// What that removes: the `initialize` handshake, the `Mcp-Session-Id` bookkeeping, the
// `notifications/initialized` fire-and-forget, the dual JSON/SSE response parsing, and
// the retry-on-stale-session. What it does NOT change: the tool names and their argument
// names are identical, and the response body IS what `structuredContent` used to carry,
// so every call site in mcp-intel.mjs keeps working untouched.
//
// If eve-kill ever republishes a real MCP transport, this file is the only thing to
// swap back — nothing else in the app knows how the tools are reached.
import { USER_AGENT as UA } from "./user-agent.mjs";

const BASE = "https://eve-kill.com/api/mcp/tools";
const TIMEOUT = 12000;  // a slow analytics tool must never hang a chat answer

/**
 * Calls an analytics tool and returns the parsed result (object/array) or null. Never
 * throws: on any failure (offline, tool error, bad shape) it returns null, so callers
 * degrade gracefully — no live block, but the RAG answer still goes out.
 *
 * The shape check is not paranoia: the retired host answered 200 with an HTML page, and
 * a truthy string would have flowed into the formatters as if it were data.
 */
export async function callTool(name, args = {}) {
  try {
    const r = await fetch(`${BASE}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "User-Agent": UA },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}
