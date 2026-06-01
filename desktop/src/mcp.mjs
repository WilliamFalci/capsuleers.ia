// Minimal client for the EVE-KILL MCP server (JSON-RPC over streamable HTTP).
// https://mcp.eve-kill.com/mcp — public, no auth, 20 req/s per IP.
//
// We do NOT use LLM tool-calling here: the local chat model is small and the app's
// architecture routes live data by intent regexes, not by the model. So we invoke the
// MCP tools DIRECTLY (like a REST API) and feed the JSON result into the RAG context,
// exactly as intel.mjs / esi.mjs / eve-scout.mjs already do. The MCP just gives us
// higher-level, pre-computed analytics (dossier, route danger, dogma stats, battle
// reports…) that would otherwise take many REST calls to assemble.
const ENDPOINT = "https://mcp.eve-kill.com/mcp";
const UA = "Capsuleers.IA/0.1 (dedodj@gmail.com)";
const PROTOCOL = "2025-06-18";
const TIMEOUT = 12000;  // a slow analytics tool must never hang a chat answer

let sessionId = null;     // Mcp-Session-Id handed back by initialize
let initPromise = null;   // de-dupes concurrent initialize handshakes
let nextId = 1;

// Single JSON-RPC round-trip. `notification: true` → fire-and-forget (no id, no result).
async function rpc(method, params, { notification = false } = {}) {
  const payload = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: nextId++, method, params };
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "User-Agent": UA,
    "MCP-Protocol-Version": PROTOCOL,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const r = await fetch(ENDPOINT, {
    method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT),
  });
  const sid = r.headers.get("Mcp-Session-Id") || r.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (notification) { if (!r.ok && r.status !== 202) throw new Error(`MCP ${method} HTTP ${r.status}`); return null; }
  if (!r.ok) throw new Error(`MCP ${method} HTTP ${r.status}`);
  const msg = await parseMessage(r);
  if (msg?.error) throw new Error(`MCP ${method}: ${msg.error.message || "error"}`);
  return msg?.result;
}

// Streamable HTTP: the server may answer as plain JSON OR as a single SSE event
// (text/event-stream with "data:" lines). Handle both and return the JSON-RPC message.
async function parseMessage(r) {
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  if (ct.includes("text/event-stream")) {
    let data = "";
    for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) data += line.slice(5).trim();
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

// Lazy handshake: initialize once, then send the "initialized" notification. Cached so
// every tool call reuses the same session; reset on failure so the next call retries.
async function ensureInit() {
  if (sessionId) return;
  if (!initPromise) {
    initPromise = (async () => {
      await rpc("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "Capsuleers.IA", version: "0.1" },
      });
      await rpc("notifications/initialized", {}, { notification: true });
    })().catch((e) => { initPromise = null; throw e; });
  }
  return initPromise;
}

// tools/call returns { content: [{type:"text", text}], structuredContent?, isError? }.
// Prefer structuredContent; otherwise parse the first text block as JSON, falling back
// to the raw text wrapped in { text }.
function extract(result) {
  if (!result || result.isError) return null;
  if (result.structuredContent != null) return result.structuredContent;
  const block = (result.content || []).find((c) => c.type === "text");
  if (!block) return null;
  try { return JSON.parse(block.text); } catch { return { text: block.text }; }
}

/**
 * Calls an MCP tool and returns the parsed result (object/array) or null. Never throws:
 * on any failure (offline, tool error, stale session) it resets the session and returns
 * null, so callers degrade gracefully (no live block → the RAG answer still goes out).
 * One transparent retry covers an expired session id.
 */
export async function callTool(name, args = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureInit();
      return extract(await rpc("tools/call", { name, arguments: args }));
    } catch {
      sessionId = null; initPromise = null;  // force a fresh handshake on the retry
    }
  }
  return null;
}
