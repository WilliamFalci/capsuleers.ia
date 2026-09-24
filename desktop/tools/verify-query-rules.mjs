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

// 3. The slang expansion still works.
ok(expandQuery("cosa è il sov").includes("sovereignty"), "sov → sovereignty");

process.exit(fail ? 1 : 0);
