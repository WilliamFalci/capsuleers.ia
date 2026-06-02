// Live features built on the EVE-KILL MCP server (see mcp.mjs). Each helper returns
// { text, entities, source, sourceTitle } — the same shape intel.mjs/esi.mjs use — so
// the engine drops the block straight into the RAG context and the local model narrates
// it in the user's language. Headers are in Italian (like the other live modules); the
// LANG_DIRECTIVE in engine.mjs re-languages the final answer to IT or EN as needed.
//
// What is NOT here on purpose:
//  • me_* tools — they target "your" character; the app has no login/pilot context.
//  • item_info/ship_info/system_info — ships/items/systems are answered offline from the
//    RAG index + local SDE; routing them online would break the offline-first stance.
//  • Fit math stays fully local + offline (fit.mjs → eve-fit-engine, pyfa parity);
//    no dogma_eval / fit_compare / ship_compare (server-side fit/ship evaluation) is wired.
//  • kills_with — redundant with flies_with (same "who appears on X's killmails" signal).
//  • compare — head-to-head A-vs-B is already served (more richly) by war_report.
// Everything else the server exposes that is read-only analytics IS wired below: the
// pulse tools (global/system), the entity_* family (kills/overview/timeline/top) and
// ships_used, on top of the original killmail/route/war/doctrine/intel-graph set.
import { callTool } from "./mcp.mjs";

// ── Formatting helpers ───────────────────────────────────────────────────────

// Readable, indented serialization of an arbitrary JSON result (MCP tool shapes vary;
// this stays tolerant). The model rewrites it anyway, so we just need it labeled and present.
function pretty(v, ind = "") {
  if (v == null || v === "") return "";
  if (typeof v !== "object") return `${ind}${v}`;
  if (Array.isArray(v)) {
    return v.map((x) => (x != null && typeof x === "object")
      ? `${ind}-\n${pretty(x, ind + "  ")}`
      : `${ind}- ${x}`).join("\n");
  }
  return Object.entries(v)
    // Drop noise the local model would choke on: opaque hashes and bare urls.
    .filter(([k, val]) => val != null && val !== "" && !(Array.isArray(val) && !val.length) && !/hash/i.test(k) && k !== "url")
    .map(([k, val]) => (typeof val === "object")
      ? `${ind}${k}:\n${pretty(val, ind + "  ")}`
      : `${ind}${k}: ${val}`)
    .join("\n");
}
function render(data, cap = 2400) {
  const s = pretty(data);
  return s.length > cap ? s.slice(0, cap) + "\n…(troncato)" : s;
}

function iskShort(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return (n / 1e12).toFixed(1) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n));
}

// doctrine_detect / meta_pulse return `clusters` of fit families (ship + signature +
// losses + ISK). The generic dump buries the useful "signature" under family_hash and
// module lists, so we render a clean numbered list instead. `withFit` appends the top
// cluster's example modules (the concrete fit). Returns null if there are no clusters.
function fmtClusters(d, { withFit = false } = {}) {
  const cl = d?.clusters || [];
  if (!cl.length) return null;
  const lines = cl.slice(0, 12).map((c, i) => {
    const ship = c.ship?.name || `nave ${c.ship?.type_id ?? "?"}`;
    const label = c.signature || `${ship}${c.ship?.group ? ` [${c.ship.group}]` : ""}`;
    const meta = [
      c.losses != null && `${c.losses} perdite`,
      c.avg_isk_per_loss && `~${iskShort(c.avg_isk_per_loss)} ISK ciascuna`,
    ].filter(Boolean).join(", ");
    return `${i + 1}. ${label}${meta ? ` (${meta})` : ""}`;
  });
  if (withFit) {
    const mods = cl[0]?.example_killmail?.modules;
    if (Array.isArray(mods) && mods.length) lines.push(`Fit d'esempio (${cl[0].ship?.name || "top"}): ${mods.join("; ")}`);
  }
  return lines.join("\n");
}

function pushEnt(out, seen, name, type, id) {
  if (!name || id == null) return;
  const key = `${type}:${id}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ name: String(name), type, id: Number(id) });
}
// Walks the result for {name, *_id} pairs so linkify() can link character/corp/alliance
// names to capsuleers.app. Best-effort: missing ids just mean no link.
function collectEntities(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== "object" || depth > 5 || out.length >= 20) return out;
  if (Array.isArray(node)) { for (const x of node) collectEntities(x, out, seen, depth + 1); return out; }
  const nm = node.name || node.character_name || node.corporation_name || node.alliance_name;
  if (node.character_id != null) pushEnt(out, seen, node.character_name || nm, "character", node.character_id);
  if (node.corporation_id != null) pushEnt(out, seen, node.corporation_name || (node.character_id == null ? nm : null), "corporation", node.corporation_id);
  if (node.alliance_id != null) pushEnt(out, seen, node.alliance_name || (node.character_id == null && node.corporation_id == null ? nm : null), "alliance", node.alliance_id);
  for (const v of Object.values(node)) if (v && typeof v === "object") collectEntities(v, out, seen, depth + 1);
  return out;
}

function block(header, data, { source = "https://eve-kill.com/", sourceTitle = "eve-kill · analisi MCP (dati live)" } = {}) {
  return blockBody(header, render(data), data, { source, sourceTitle });
}
// Same as block() but with a pre-rendered body (for tools that need a dedicated, cleaner
// formatter than the generic dump). Entities are still collected from the raw data.
function blockBody(header, body, data, { source = "https://eve-kill.com/", sourceTitle = "eve-kill · analisi MCP (dati live)" } = {}) {
  return {
    text: `INTEL eve-kill (MCP, dati live) — ${header}:\n${body}\nFonte: ${source}`,
    entities: collectEntities(data),
    source, sourceTitle,
  };
}

// ── Text extraction helpers ──────────────────────────────────────────────────

const clean = (s) => (s || "")
  .replace(/["'?.!,;:]+$/g, "").replace(/^["'\s]+/, "").trim()
  .replace(/\s+(?:adesso|ora|attualmente|al\s+momento|right\s+now|now|currently|please|per\s+favore)$/i, "").trim();

function stripLead(s) {
  let p;
  do {
    p = s;
    s = s.replace(/^[\s,:.'’"]+/, "")
      .replace(/^(?:il|lo|la|i|gli|le|l['’]|the|un|una|uno|a|an)\s+/i, "")
      .replace(/^(?:pilota|personaggio|player|character|corp(?:orazione|oration)?|alleanza|alliance|giocatore|capsuleer)\s+/i, "");
  } while (s !== p);
  return s;
}
// Cleans an entity name captured from a two-side ("X vs Y") match: drops the leading
// question framing ("chi vince…", "war report…") before the actual name.
function cleanEntity(s) {
  return stripLead(clean(s).replace(/^.*?\b(?:chi\s+vince|chi\s+è\s+più\s+forte|who\s+wins|war\s*report|report|confronto|guerra|war|battaglia|battle)\b\s*/i, ""));
}
const ok = (s) => s && s.length >= 2 && s.length <= 60;

// ── Dispatcher ───────────────────────────────────────────────────────────────

const EMPTY = { text: "", entities: [], source: null, sourceTitle: null };

/**
 * Detects an MCP-backed intent from the question (IT/EN triggers) and, if one matches,
 * calls the relevant tool and returns a formatted live block. Returns EMPTY when nothing
 * matches (cheap: just regex tests, no network). Never throws.
 */
export async function maybeMcp(question, standalone = question) {
  const q = question;
  try {
    // 1) KILLMAIL by id / zKillboard|eve-kill URL → detail · story · forensics · fitting.
    {
      const url = q.match(/(?:zkillboard\.com\/kill|eve-?kill\.com\/kill)\/(\d{4,})/i);
      const idm = url || q.match(/\bkill\s?mail\s+#?(\d{4,})/i) || q.match(/\bkm\s+#?(\d{4,})/i)
        || (/\bkill\s?mail\b/i.test(q) ? q.match(/\b(\d{6,})\b/) : null);
      if (idm) {
        const killmail_id = Number(idm[1]);
        if (/\b(racconta|storia|story|narr\w*)\b/i.test(q)) {
          const d = await callTool("killmail_story", { killmail_id });
          return d ? block(`racconto del killmail ${killmail_id}`, d) : EMPTY;
        }
        if (/\b(forensi\w*|autops\w*|post[\s-]?mortem|analizz\w*|com['’e]?\s*è\s+mort\w*|why\s+did\b|how\s+did\b.*die)\b/i.test(q)) {
          const d = await callTool("killmail_forensics", { killmail_id });
          return d ? block(`analisi forense del killmail ${killmail_id} (cap stability, outnumbering, resist deboli, doctrine match)`, d) : EMPTY;
        }
        if (/\b(fit|loadout|equipaggiament\w*|moduli)\b/i.test(q)) {
          const d = await callTool("killmail_fitting", { killmail_id, format: "eft" });
          return d ? block(`fit del killmail ${killmail_id}`, d) : EMPTY;
        }
        const d = await callTool("killmail", { killmail_id });
        return d ? block(`dettaglio killmail ${killmail_id}`, d) : EMPTY;
      }
    }

    // 2) ROUTE DANGER — stargate route with per-hop danger. Needs a route intent + from/to.
    if (/\b(rotta|percors\w*|route|come\s+(?:ci\s+)?(?:arriv\w*|vad\w*|si\s+arriv\w*)|how\s+(?:do\s+i\s+|to\s+)?get|quanti\s+salti|jumps?\s+from|how\s+many\s+jumps)\b/i.test(q)) {
      const m = q.match(/\b(?:da|from)\s+(.+?)\s+(?:a(?:d|l|llo|lla)?|to|verso|fino\s+a)\s+(.+)/i);
      if (m) {
        const from = clean(m[1]), to = stripLead(clean(m[2]));
        if (ok(from) && ok(to)) {
          const prefer = /\b(sicur\w*|safe\w*)\b/i.test(q) ? "safest" : /\blowsec/i.test(q) ? "lowsec_ok" : "shortest";
          const d = await callTool("route_danger", { from, to, prefer, round_trip: /\b(andata\s+e\s+ritorno|round[\s-]?trip|ritorno)\b/i.test(q) });
          return d ? block(`rotta ${from} → ${to} (${prefer}) con pericolosità per salto`, d, { source: "https://eve-kill.com/" }) : EMPTY;
        }
      }
    }

    // 3) WAR / HEAD-TO-HEAD — "X vs Y", "guerra tra X e Y", "confronta X e Y".
    {
      const m = q.match(/(.+?)\s+(?:vs\.?|versus|contro)\s+(.+)/i)
        || q.match(/\b(?:tra|fra|between)\s+(.+?)\s+(?:e|ed|and)\s+(.+)/i)
        || q.match(/\b(?:confronta|compara|compare)\s+(.+?)\s+(?:e|ed|con|and|with|to)\s+(.+)/i)
        || q.match(/\b(?:guerra|war)\b.*?\b(?:tra|fra|between|of)\s+(.+?)\s+(?:e|ed|and|vs)\s+(.+)/i);
      if (m) {
        const a = cleanEntity(m[1]), b = cleanEntity(m[2]);
        if (ok(a) && ok(b)) {
          const d = await callTool("war_report", { a, b });
          return d ? block(`scontro testa a testa ${a} vs ${b} (kill per direzione, timeline ISK, sistemi contesi, battaglie)`, d) : EMPTY;
        }
      }
    }

    // 4) COALITION GRAPH — alliance allied/enemy edges from battles.
    if (/\b(coalizion\w*|blocch\w*\s+di\s+potere|coalition\w*|power\s+bloc\w*)\b/i.test(q)
      || /\bchi\s+è\s+alleat\w+\s+(?:con|di)\b/i.test(q) || /\bwho\s+is\s+allied\s+(?:with|to)\b/i.test(q)) {
      const fm = q.match(/\b(?:con|di|with|to)\s+(.+)$/i);
      const focus = fm ? stripLead(clean(fm[1])) : null;
      const d = await callTool("coalition_graph", focus && ok(focus) ? { focus_alliance: focus } : {});
      return d ? block(focus ? `grafo coalizioni attorno a ${focus}` : "grafo coalizioni (alleati/nemici dalle battaglie)", d) : EMPTY;
    }

    // 5) DOCTRINE DETECT — dominant fit doctrines of an entity.
    {
      const m = q.match(/\bdottrin\w*\s+(?:di|del|della|dei|usate?\s+d[ai])\s+(.+)/i)
        || q.match(/\bdoctrines?\s+(?:of|used\s+by)\s+(.+)/i)
        || q.match(/\bche\s+fit\s+(?:usa|vola|porta)\s+(.+)/i)
        || q.match(/\bfit\s+(?:usati?|preferiti?|tipici?)\s+(?:da|di|of)\s+(.+)/i)
        || q.match(/\bwhat\s+(?:fits?|doctrines?)\s+does\s+(.+?)\s+(?:use|fly)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("doctrine_detect", { entity });
          if (!d) return EMPTY;
          const body = fmtClusters(d, { withFit: true });
          const header = `dottrine/fit dominanti di ${entity} (ultimi 30 giorni)`;
          return body ? blockBody(header, body, d) : block(`${header} (nessuna dottrina ricorrente rilevata)`, d);
        }
      }
    }

    // 6) META PULSE — global doctrine/meta scan.
    if (/\bmeta\b/i.test(q) && /(attual\w*|del\s+momento|in\s+gioco|adesso|ora|gener\w*|popolar\w*|current|popular|now|right\s+now|c['’]è|going\s+on)/i.test(q)
      || /\b(dottrine|fit)\s+(pi[ùu]\s+)?(usat\w*|popolar\w*|comuni)\b/i.test(q) || /\bwhat['’]?s\s+the\s+meta\b/i.test(q)) {
      const d = await callTool("meta_pulse", {});
      if (!d) return EMPTY;
      const body = fmtClusters(d);
      const header = "meta del momento — fit/dottrine più diffusi (ultimi 7 giorni, per perdite)";
      return body ? blockBody(header, body, d) : block(header, d);
    }

    // 7) BATTLES — battle_report by id, otherwise recent battles.
    {
      const bid = q.match(/\b(?:battle\s*report|report\s+battagli\w*|battagli\w*|battle)\b[^.\d]*?#?(\d{3,})/i);
      if (bid && /\b(report|battle|battagli)/i.test(q)) {
        const d = await callTool("battle_report", { battle_id: Number(bid[1]) });
        if (d) return block(`battle report #${bid[1]}`, d);
      }
      if (/\b(ultime?\s+battagli\w*|battagli\w*\s+(?:recenti|più\s+grandi|grosse)|recent\s+battles?|biggest\s+battles?|latest\s+battles?|grandi\s+battagli\w*)\b/i.test(q)) {
        const d = await callTool("find_battles", { sort: /\b(recenti|recent|latest|ultime)\b/i.test(q) ? "recent" : "isk" });
        return d ? block("battaglie recenti (per ISK distrutti)", d) : EMPTY;
      }
    }

    // 8) EXPENSIVE LOSSES — most valuable killmails.
    if (/\b(kill\w*\s+(pi[ùu]\s+)?costos\w*|perdit\w*\s+(pi[ùu]\s+)?costos\w*|navi\s+(pi[ùu]\s+)?costos\w*\s+pers\w*|most\s+expensive\s+(kills?|losses?|ships?)|biggest\s+(kills?|losses?)|priciest)\b/i.test(q)) {
      const d = await callTool("expensive_losses", {});
      return d ? block("kill più costosi (ultimi 30 giorni)", d) : EMPTY;
    }

    // 9) CHARACTER/CORP HISTORY — inferred membership timeline.
    {
      const m = q.match(/\bstoria\s+(?:di|del|della|dell['’])\s+(.+)/i)
        || q.match(/\bcorp\w*\s+passat\w+\s+(?:di|of|del)\s+(.+)/i)
        || q.match(/\bdove\s+ha\s+milit\w+\s+(.+)/i)
        || q.match(/\b(?:history|past\s+corp\w*|track\s+record)\s+of\s+(.+)/i)
        || q.match(/\b(.+?)['’]s\s+(?:history|past\s+corps?)\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("character_history", { entity });
          return d ? block(`storia di appartenenza (corp/alleanza) di ${entity}`, d) : EMPTY;
        }
      }
    }

    // 10) PREYS_ON — who X kills most ("le prede di X", "who does X kill/prey on").
    {
      const m = q.match(/\b(?:prede|vittime(?:\s+preferite)?)\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\bwho\s+does\s+(.+?)\s+(?:prey|kill|hunt)\b/i)
        || q.match(/\b(.+?)['’]s\s+(?:prey|favou?rite\s+(?:victims?|targets?))\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("preys_on", { entity });
          return d ? block(`prede preferite di ${entity} (chi uccide più spesso, 90gg)`, d) : EMPTY;
        }
      }
    }

    // 11) HUNTS_IN — preferred hunting systems ("dove caccia X", "where does X hunt").
    {
      const m = q.match(/\bdove\s+(?:caccia|uccide|killa|opera)\s+(.+)/i)
        || q.match(/\b(?:sistemi?|zone?)\s+di\s+caccia\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\bwhere\s+does\s+(.+?)\s+(?:hunt|kill|operate)\b/i)
        || q.match(/\b(.+?)['’]s\s+hunting\s+(?:grounds?|systems?)\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("hunts_in", { entity });
          return d ? block(`sistemi di caccia preferiti di ${entity}`, d) : EMPTY;
        }
      }
    }

    // 12) HUNTED_BY — who kills X most ("chi uccide X", "who hunts X").
    {
      const m = q.match(/\bchi\s+(?:uccide|killa|caccia|ammazza|fa\s+fuori)\s+(.+)/i)
        || q.match(/\bda\s+chi\s+(?:viene\s+ucciso|è\s+ucciso|è\s+cacciato)\s+(.+)/i)
        || q.match(/\b(?:nemici|cacciatori)\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\bwho\s+(?:hunts|kills|killed)\s+(.+)/i)
        || q.match(/\b(.+?)['’]s\s+(?:hunters?|nemes[ie]s|killers?)\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("hunted_by", { entity });
          return d ? block(`chi uccide più spesso ${entity} (90gg)`, d) : EMPTY;
        }
      }
    }

    // 13) FLIES_WITH — frequent wingmates ("con chi vola X", "wingmates of X").
    {
      const m = q.match(/\bcon\s+chi\s+vola\s+(.+)/i)
        || q.match(/\bchi\s+vola\s+(?:con|insieme\s+a)\s+(.+)/i)
        || q.match(/\b(?:wingmate[s]?|compagni(?:\s+di\s+volo)?|gregari)\s+(?:di|of)\s+(.+)/i)
        || q.match(/\bwho\s+(?:does\s+(.+?)\s+fl(?:y|ies)\s+with|flies\s+with\s+(.+))/i)
        || q.match(/\b(.+?)['’]s\s+wingmates?\b/i);
      if (m) {
        const entity = stripLead(clean(m[1] || m[2]));
        if (ok(entity)) {
          const d = await callTool("flies_with", { entity });
          return d ? block(`compagni di volo abituali di ${entity} (ultimi 90gg)`, d) : EMPTY;
        }
      }
    }

    // 14) PILOT EFFICIENCY — K:D, ISK ratio, solo rate, activity heatmaps.
    {
      const m = q.match(/\befficien\w*\s+(?:di|del|della)\s+(.+)/i)
        || q.match(/\b(?:k\/?d|kd|rapporto\s+kill[\s/]+mort\w*)\s+(?:di|del|of)\s+(.+)/i)
        || q.match(/\bquanto\s+(?:è\s+)?(?:brav\w*|forte)\s+(.+)/i)
        || q.match(/\b(?:efficiency|k[:/]?d(?:\s+ratio)?|kill[\s/]+death\s+ratio|performance)\s+(?:of|for)\s+(.+)/i)
        || q.match(/\bhow\s+good\s+is\s+(.+)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("pilot_efficiency", { entity });
          return d ? block(`efficienza di ${entity} (K:D, ISK ratio, solo rate, fasce orarie)`, d) : EMPTY;
        }
      }
    }

    // 15) ENTITY OVERVIEW — killboard summary of a character/corp/alliance.
    {
      const m = q.match(/\b(?:panoramica|overview|riepilog\w*|scheda)\s+(?:killboard\s+)?(?:di|del|della|dell['’]|of)\s+(.+)/i)
        || q.match(/\bkillboard\s+(?:di|of)\s+(.+)/i)
        || q.match(/\b(.+?)['’]s\s+(?:killboard\s+)?overview\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_overview", { entity });
          return d ? block(`panoramica killboard di ${entity} (kill/perdite, ISK, efficienza, top navi/sistemi)`, d) : EMPTY;
        }
      }
    }

    // 16) ENTITY TIMELINE — activity over time (kills/losses), not membership history.
    {
      const m = q.match(/\b(?:timeline|cronologia|andamento)(?:\s+(?:di\s+|dell['’])?attivit\S*)?\s+(?:di|del|della|dell['’]|of|for)\s+(.+)/i)
        || q.match(/\battivit\S*\s+nel\s+tempo\s+(?:di|del|della|of|for)\s+(.+)/i)
        || q.match(/\b(?:activity\s+)?timeline\s+(?:of|for)\s+(.+)/i)
        || q.match(/\b(.+?)['’]s\s+(?:activity\s+)?timeline\b/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_timeline", { entity });
          return d ? block(`timeline di attività di ${entity} (kill/perdite nel tempo)`, d) : EMPTY;
        }
      }
    }

    // 17) ENTITY KILLS — recent killmails of an entity ("ultimi kill di X").
    {
      const m = q.match(/\b(?:ultim\w*|recent\w*)\s+kill\w*\s+(?:di|del|della|dell['’]|of|by)\s+(.+)/i)
        || q.match(/\bkill\w*\s+recent\w*\s+(?:di|del|della|of|by)\s+(.+)/i)
        || q.match(/\brecent\s+kills?\s+(?:of|by)\s+(.+)/i)
        || q.match(/\b(?:cosa|chi)\s+ha\s+(?:killat\w*|ucciso)\s+(.+?)\s+(?:di\s+recente|ultimamente|recentemente)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_kills", { entity });
          return d ? block(`ultimi kill di ${entity}`, d) : EMPTY;
        }
      }
    }

    // 18) SHIPS USED — hulls an entity flies most (complements doctrine_detect, which is fits).
    {
      const m = q.match(/\b(?:che|quali)\s+navi\s+(?:usa|vola|porta|piloti?a|preferisce)\s+(.+)/i)
        || q.match(/\bnavi\s+(?:usate|volate|preferite|tipiche)\s+(?:da|di)\s+(.+)/i)
        || q.match(/\b(?:what|which)\s+ships?\s+does\s+(.+?)\s+(?:use|fly|pilot)/i)
        || q.match(/\bships?\s+(?:used|flown)\s+(?:by|of)\s+(.+)/i);
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("ships_used", { entity });
          return d ? block(`navi più usate da ${entity} (ultimi 90gg)`, d) : EMPTY;
        }
      }
    }

    // 19) ENTITY TOP — ranking by a dimension. Works for characters AND alliances/corps
    //     (unlike the char-only intel-graph tools). The dimension is inferred from the
    //     question's keyword; bail (fall through) if no dimension is recognised.
    {
      const DIM_LABEL = {
        ship_flown: "navi più volate", ship_lost: "navi più perse",
        system: "sistemi più attivi", constellation: "costellazioni più attive",
        region: "regioni più attive", killed_alliance: "alleanze più uccise",
        dies_to_alliance: "alleanze che lo uccidono di più",
        killed_corporation: "corp più uccise", dies_to_corporation: "corp che lo uccidono di più",
      };
      let dimension = null;
      if (/\bnavi\b[^.]*\b(?:pers\w*|perdut\w*)|\bship\w*\s+lost|\blost\s+ship/i.test(q)) dimension = "ship_lost";
      else if (/\bnavi\b|\bship\w*\s+(?:flown|used)|\bhull/i.test(q)) dimension = "ship_flown";
      else if (/\bcostellazion\w*|constellation/i.test(q)) dimension = "constellation";
      else if (/\bregion\w*/i.test(q)) dimension = "region";
      else if (/\bsistem\w*|\bsystem/i.test(q)) dimension = "system";
      else if (/(?:uccid\w*|kill\w*)[^.]*\balleanz|killed?\s+allianc/i.test(q)) dimension = "killed_alliance";
      else if (/(?:muore|ucciso|dies?)[^.]*\balleanz|dies?\s+to\s+allianc/i.test(q)) dimension = "dies_to_alliance";
      const m = dimension && (
        q.match(/\b(?:top|classific\w*|migliori|preferit\w*|pi[ùu]\s+\w+)\b[^.]*?\b(?:di|del|della|dell['’]|dei|degli|delle|da|of|for|by)\s+(.+)/i)
        || q.match(/\b(?:top|favou?rite|most)\b[^.]*?\b(?:of|for|by)\s+(.+)/i)
      );
      if (m) {
        const entity = stripLead(clean(m[1]));
        if (ok(entity)) {
          const d = await callTool("entity_top", { entity, dimension });
          return d ? block(`classifica ${DIM_LABEL[dimension]} di ${entity}`, d) : EMPTY;
        }
      }
    }

    // 20) SYSTEM PULSE — recent activity / danger of a single solar system.
    {
      const m = q.match(/\b(?:quanto\s+è\s+|com['’]?è\s+|quant['’]?è\s+)?(?:pericolos\w*|attiv\w*|movimentat\w*|cald\w*|tranquill\w*|sicur\w*)\s+(?:il\s+sistema\s+)?([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\b(?:attivit\S*|situazione|polso)\s+(?:in|nel\s+sistema|di|del\s+sistema)\s+([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\bhow\s+(?:dangerous|active|hot|busy|quiet)\s+is\s+([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\b(?:activity|what['’]?s\s+(?:happening|going\s+on))\s+(?:in|at)\s+([A-Za-z0-9][\w\- ]{1,30})/i)
        || q.match(/\bsystem\s+pulse\s+([A-Za-z0-9][\w\- ]{1,30})/i);
      if (m) {
        const system = stripLead(clean(m[1]));
        if (ok(system)) {
          const d = await callTool("system_pulse", { system });
          return d ? block(`polso del sistema ${system} (kill recenti, pericolosità, attività)`, d) : EMPTY;
        }
      }
    }

    // 21) GLOBAL PULSE — cluster-wide activity snapshot (no entity).
    if (/\b(?:cosa|che\s+cosa|che)\s+(?:succede|sta\s+succedendo|c['’]è)\b[^.]*\b(?:in\s+game|in\s+eve|nel\s+cluster|nello\s+spazio|adesso|ora|ovunque)\b/i.test(q)
      || /\bpolso\s+(?:globale|del\s+cluster|di\s+eve|di\s+new\s+eden)\b/i.test(q)
      || /\battivit\S*\s+(?:globale|del\s+cluster|generale)\b/i.test(q)
      || /\b(?:global\s+pulse|global\s+activity|what['’]?s\s+(?:happening|going\s+on)\s+(?:in\s+eve|globally|right\s+now|across\s+(?:new\s+eden|the\s+cluster)))\b/i.test(q)) {
      const d = await callTool("global_pulse", {});
      return d ? block("polso globale di New Eden (attività/kill recenti nel cluster)", d) : EMPTY;
    }
  } catch { /* never break a chat answer over a live-data failure */ }
  return EMPTY;
}

// ── Used by intel.mjs (character intel enrichment) ───────────────────────────

/**
 * Concise extra intel for a CHARACTER from capsuleer_dossier: archetype tags
 * (FC/CAPITAL/SUPER/BLOPS/LOGI/CYNO/GANKER/NEWBIE), playstyle and top wingmates —
 * data the plain killboard stats don't surface. Returns an Italian text block, or "".
 * Tolerant to the exact JSON shape; never throws.
 */
export async function dossierExtra(entity, type = "character") {
  try {
    const d = await callTool("capsuleer_dossier", { entity, type, format: "json" });
    if (!d || typeof d !== "object") return "";
    const tags = d.archetype_tags || d.archetypes || d.tags || d.archetype || null;
    const wing = d.top_wingmates || d.wingmates || d.flies_with || d.fleet_partners || null;
    const style = d.playstyle_90d || d.playstyle || d.dominant_style || d.play_style || null;
    const lines = [];
    if (tags) {
      const list = Array.isArray(tags) ? tags : Object.keys(tags);
      if (list.length) lines.push(`Archetipi (eve-kill): ${list.slice(0, 8).join(", ")}.`);
    }
    if (style) {
      const solo = style.solo_pct ?? style.solo;
      const s = typeof style === "string" ? style
        : [style.dominant && `stile dominante: ${style.dominant}`,
           solo != null && `solo ${solo}%`,
           style.avg_fleet_size && `flotta media ${style.avg_fleet_size}`].filter(Boolean).join(", ");
      if (s) lines.push(`Playstyle: ${s}.`);
    }
    if (Array.isArray(wing) && wing.length) {
      const names = wing.map((w) => w.name || w.character_name || w.character?.name).filter(Boolean).slice(0, 5);
      if (names.length) lines.push(`Vola spesso con: ${names.join(", ")}.`);
    }
    return lines.length ? `Dossier eve-kill (MCP):\n${lines.join("\n")}` : "";
  } catch { return ""; }
}
