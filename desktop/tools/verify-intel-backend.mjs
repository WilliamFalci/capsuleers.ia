// Live check of the intel backend switch (capsuleers.app first, eve-kill fallback).
// Network required. Run twice: normally, and with the site unreachable:
//   node tools/verify-intel-backend.mjs
//   CAPSULEERS_SITE=http://127.0.0.1:9 node tools/verify-intel-backend.mjs --fallback
const FALLBACK = process.argv.includes("--fallback");
const { localIntel, intelFor, characterDetail } = await import("../src/intel.mjs");

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) fail++; };
const UA = { "User-Agent": "Capsuleers.IA verify (+https://capsuleers.app)" };

// A real Local: victims of the latest killmails on the site's archive, names via ESI.
const rows = (await (await fetch("https://capsuleers.app/api/killboard/search", {
  method: "POST", headers: { ...UA, "content-type": "application/json" }, body: JSON.stringify({ limit: 80 }),
})).json()).rows;
const ids = [...new Set(rows.map((r) => r.victim?.character_id).filter(Boolean))].slice(0, 60);
const names = (await (await fetch("https://esi.evetech.net/latest/universe/names/", {
  method: "POST", headers: { ...UA, "content-type": "application/json" }, body: JSON.stringify(ids),
})).json()).map((x) => x.name);
names.push("Nessuno Con Questo Nome Xq", names[0].toUpperCase());   // unknown + a case duplicate

const t0 = Date.now();
const res = await localIntel(names, { cap: 100 });
const ms = Date.now() - t0;
const found = res.rows.filter((r) => r.found);
ok(res.source === (FALLBACK ? "eve-kill" : "capsuleers"), `Local: sorgente ${res.source} (${ms} ms, ${names.length} nomi)`);
ok(res.total === names.length - 1, `Local: il duplicato per maiuscole conta una volta (${res.total})`);
ok(found.length >= names.length - 3, `Local: ${found.length} piloti risolti`);
ok(res.rows.some((r) => r.name === "Nessuno Con Questo Nome Xq" && !r.found), "Local: il nome inesistente resta non trovato");
ok(found.some((r) => r.corpTicker), "Local: ticker di corporazione presenti");
if (!FALLBACK) {
  ok(found.every((r) => r.window === 90 && r.eff == null), "Local: numeri a 90 giorni, nessuna efficienza ISK spacciata");
  ok(found.some((r) => r.kills > 0) && found.some((r) => r.flags.length), "Local: kill e flag dall'intel del sito");
}

const p = await intelFor("TremalJack", { kills: true, losses: true });
ok(p && p.card?.kind === "pilot", "chi è pilota: scheda pilota costruita");
ok(p && /capsuleers\.app/.test(p.source?.url || "") === !FALLBACK, `chi è pilota: fonte ${p?.source?.url}`);
ok(p && p.card.stats.kills > 1000, `chi è pilota: totali di sempre (${p?.card?.stats?.kills} kill)`);
ok(p && p.kills.length > 0 && p.kills.every((k) => k.shipName && k.system), `chi è pilota: ${p?.kills?.length} schede kill/perdite con nave e sistema`);

const a = await intelFor("Goonswarm Federation", { battles: true });
ok(a && /Alleanza/.test(a.text) && /Top membri/.test(a.text), "chi è alleanza: totali e membri");
ok(a && /Ultime battaglie/.test(a.text), "chi è alleanza: battaglie");

// "CONDI" is both a pilot's name (ESI finds it) and an alliance ticker (only eve-kill
// search finds that): both must reach the disambiguation, as before the switch.
const tk = await intelFor("CONDI");
const kinds = tk?.ambiguous ? tk.candidates.map((c) => c.type) : [];
ok(kinds.includes("character") && kinds.some((k) => k !== "character"), `ticker ambiguo: CONDI propone ${kinds.join(" + ") || JSON.stringify(tk?.text?.slice(0, 60))}`);

const d = await characterDetail({ name: "TremalJack" });
ok(d && d.kills > 1000 && d.play && d.partners.length, "dettaglio pilota: totali, stile e compagni");

process.exit(fail ? 1 : 0);
