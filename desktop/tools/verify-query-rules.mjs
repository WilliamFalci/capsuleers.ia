// Query-rewriting rules of the RAG engine that have each cost a wrong answer.
//   node tools/verify-query-rules.mjs
import { expandQuery, intelQuery } from "../src/engine.mjs";

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) fail++; };

// 1. "stat" needs a word end: "STATus di sicurezza" was read as a killboard stats
//    request and the rest of the sentence searched on eve-kill as a pilot name.
for (const [q, want] of [
  ["Come viene arrotondato lo status di sicurezza di un sistema?", ""],
  ["What is the security status of Jita?", ""],
  ["statistiche di TremalJack", "TremalJack"],
  ["stats for Goonswarm Federation", "Goonswarm Federation"],
  ["dammi le statistics di Pandemic Horde", "Pandemic Horde"],
  ["kills di Vily", "Vily"],
  // The name ends at "?": what follows is a follow-up request, not part of the name.
  ["Chi è Goonswarm Federation? battaglie recenti", "Goonswarm Federation"],
  ["chi è TremalJack?", "TremalJack"],
]) ok(intelQuery(q) === want, `intelQuery(${JSON.stringify(q)}) = ${JSON.stringify(intelQuery(q))}`);

// 2. Italian "ore" = hours; EVE "ore" = what you mine. Replaced only in an Italian
//    sentence about mining, and never after a count ("quante ore", "3 ore").
for (const [q, mine] of [
  ["Quando CCP ha raddoppiato le quantità di ore nelle asteroid belt?", true],
  ["Dove trovo ore di Mercoxit in nullsec?", true],
  ["Quante ore dura una sessione di mining?", false],
  ["Ci vogliono 3 ore di mining per riempire la stiva", false],
  ["Quante ore mancano al downtime?", false],
  ["How much ore is in an asteroid belt?", false],
]) ok(expandQuery(q).includes("minerale (ore)") === mine, `expandQuery(${JSON.stringify(q)}) → ${JSON.stringify(expandQuery(q))}`);

// 3. Global "recent battles" (eve-kill find_battles) only when NO entity is named —
//    otherwise the question is about that entity's battles (intel.mjs, site data).
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/mcp-intel.mjs", import.meta.url), "utf8");
const namesEntity = new Function("q", "return " + src.match(/const namesEntity = ([\s\S]*?);\n/)[1]);
for (const [q, want] of [
  ["Chi è Goonswarm Federation? battaglie recenti", true],   // "è" is not a \b word char in JS
  ["ultime battaglie di Goonswarm", true],
  ["who is Pandemic Horde, recent battles", true],
  ["quali sono le battaglie recenti più grandi?", false],
  ["recent battles", false],
]) ok(namesEntity(q) === want, `battaglie: ${JSON.stringify(q)} nomina un'entità = ${namesEntity(q)}`);

// 4. The slang expansion still works.
ok(expandQuery("cosa è il sov").includes("sovereignty"), "sov → sovereignty");

process.exit(fail ? 1 : 0);
