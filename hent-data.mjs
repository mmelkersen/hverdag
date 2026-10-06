// Henter ugens tilbud (Netto, Føtex, 365discount, Rema 1000), Rema 1000's faste sortiment
// og dagens benzinpriser, og skriver dem som JSON-dokumenter i ./out klar til artefaktens database.
// Kør: node hent-data.mjs
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { hasUnoxCredentials, fetchUnox, updateUnox, sendNotification, HOME, km } from "./unox.mjs";

const OUT = new URL("./out/", import.meta.url);
const UA = { "User-Agent": "Mozilla/5.0 (Hverdag indkoebsliste)" };

const CHAINS = [
  { key: "netto", name: "Netto", dealer: "9ba51" },
  { key: "foetex", name: "Føtex", dealer: "bdf5A" },
  { key: "365", name: "365discount", dealer: "DWZE1w" },
  { key: "rema", name: "Rema 1000", dealer: "11deC" },
];

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const round = (n) => Math.round(n * 100) / 100;
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

// Pris pr. kg/l/stk ud fra Tjek's mængdeangivelse.
function unitPrice(o) {
  const q = o.quantity || {};
  const si = q.unit?.si;
  const size = q.size || {};
  const pieces = q.pieces?.from || 1;
  const price = o.pricing?.price;
  if (!price) return null;
  if (si && size.from) {
    // Mindste vægt → højeste kg-pris, som butikkens egen "Pr. kg max."
    const amount = size.from * si.factor * pieces;
    if (amount > 0) return [round(price / amount), si.symbol];
  }
  if (pieces > 1) return [round(price / pieces), "stk"];
  return null;
}

async function fetchOffers(chain) {
  const all = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await getJson(
      `https://squid-api.tjek.com/v2/offers?dealer_ids=${chain.dealer}&limit=100&offset=${offset}`
    );
    all.push(...page);
    if (page.length < 100) break;
  }
  const now = Date.now();
  const seen = new Set();
  const items = [];
  for (const o of all) {
    if (new Date(o.run_till).getTime() < now) continue;
    const key = o.heading + "|" + o.pricing?.price;
    if (seen.has(key)) continue;
    seen.add(key);
    const up = unitPrice(o);
    items.push([
      clean(o.heading),
      clean(o.description).slice(0, 110),
      o.pricing?.price ?? null,
      o.pricing?.pre_price ?? null,
      up ? up[0] : null,
      up ? up[1] : null,
      o.run_from?.slice(0, 10) ?? null,
      o.run_till?.slice(0, 10) ?? null,
      o.id,
      o.catalog_id ?? null,
    ]);
  }
  return {
    chain: chain.name,
    updated: new Date().toISOString(),
    fields: ["navn", "beskrivelse", "pris", "foerpris", "enhedspris", "enhed", "fra", "til", "tilbudId", "avisId"],
    items,
  };
}

// Remas egne mærkninger, forkortet: oeko, noeglehul, fuldkorn, sukker (ikke tilsat sukker), svane.
const LABEL_MAP = { "Økologi": "oeko", "Nøglehul": "noeglehul", "Fuldkorn": "fuldkorn", "Ikke tilsat sukker": "sukker", "Svanemærket": "svane", "Rainforest Alliance": "rainforest" };
function remaLabels(labels) {
  const out = new Set();
  for (const l of labels || []) if (LABEL_MAP[l?.name]) out.add(LABEL_MAP[l.name]);
  return [...out].join(",");
}

async function fetchRemaAssortment() {
  const items = [];
  for (let page = 1; page < 100; page++) {
    const j = await getJson(`https://api.digital.rema1000.dk/api/v3/products?per_page=500&page=${page}`);
    for (const p of j.data) {
      const pr = p.prices?.[0];
      if (!pr?.price) continue;
      items.push([
        clean(p.name),
        clean(p.underline),
        pr.price,
        pr.compare_unit_price ?? null,
        pr.compare_unit ?? null,
        pr.is_campaign || pr.is_advertised ? 1 : 0,
        remaLabels(p.labels),
        p.id,
      ]);
    }
    if (page >= j.meta.pagination.last_page) break;
  }
  // Del op i dokumenter under ~200 KB.
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const it of items) {
    const s = JSON.stringify(it).length + 1;
    if (size + s > 190_000) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c, i) => ({
    chain: "Rema 1000",
    part: i + 1,
    parts: chunks.length,
    updated: new Date().toISOString(),
    fields: ["navn", "beskrivelse", "pris", "enhedspris", "enhed", "kampagne", "maerker", "id"],
    items: c,
  }));
}

const CHAIN_NAMES = { CircleK: "Circle K", Goon: "Go'on", OIL: "OIL!", UnoX: "Uno-X" };

// Henter detkoster.dk/benzin og trækker kædepriser + stationspriser for blyfri 95 ud af sidens indlejrede data.
// Tilføjer manglende kæder til `chains` og returnerer din station og de billigste stationer i nærheden.
async function fetchFuelStations(chains) {
  const res = await fetch("https://www.detkoster.dk/benzin", { headers: UA });
  if (!res.ok) throw new Error(`${res.status} detkoster.dk/benzin`);
  const html = (await res.text()).replace(/\\"/g, '"');
  for (const m of html.matchAll(/\{"chain":"(\w+)","price_type":"pumpepris","blyfri95":([\d.]+)/g)) {
    const name = CHAIN_NAMES[m[1]] || m[1];
    if (!chains[name]) chains[name] = Number(m[2]);
  }
  const stations = new Map();
  const re = /"chain":"(\w+)","region":"([^"]*)","address":"([^"]*)","product_name":"([^"]*)","price":([\d.]+),"lat":([\d.-]+),"lng":([\d.-]+)/g;
  for (const m of html.matchAll(re)) {
    const [, chain, , address, product, price, lat, lng] = m;
    if (!/95/.test(product) || /\+|plus|premium|extra|miles\+/i.test(product)) continue;
    const key = chain + "|" + address;
    const st = { chain: CHAIN_NAMES[chain] || chain, address, price: Number(price), lat: Number(lat), lng: Number(lng) };
    if (!stations.has(key) || st.price < stations.get(key).price) stations.set(key, st);
  }
  const all = [...stations.values()];
  const home = all.find((s) => s.address.toLowerCase().startsWith(HOME.address.toLowerCase()) && s.address.includes(HOME.postalCode));
  if (!home) return {};
  const nearby = all
    .filter((s) => s !== home)
    .map((s) => ({ chain: s.chain, address: s.address, km: Math.round(km(home, s) * 10) / 10, price: s.price }))
    .filter((s) => s.km <= 8)
    .sort((a, b) => a.price - b.price || a.km - b.km)
    .slice(0, 6);
  return { home: { chain: home.chain, address: home.address, price: home.price }, nearby };
}

async function fetchFuel() {
  const j = await getJson("https://www.detkoster.dk/benzin/data.json");
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
  const chains = {};
  for (const c of j.chains || []) {
    if (c.blyfri95) chains[CHAIN_NAMES[c.chain] || c.chain] = c.blyfri95;
  }
  // Websiden har flere kæder end data.json (bl.a. Uno-X) og priser pr. station.
  let local = {};
  try { local = await fetchFuelStations(chains); } catch (e) { console.error("Stationspriser:", e.message); }
  const p = j.products?.blyfri95 || {};
  const docs = [
    { date: today, avg: p.avg ?? null, min: p.min ?? null, max: p.max ?? null, chains, ...local, source: "detkoster.dk", fetched: new Date().toISOString() },
  ];
  const history = (j.history_30d || []).filter((h) => h.blyfri95 && h.date !== today).map((h) => ({ date: h.date, avg: h.blyfri95 }));
  // Historik (kun gennemsnit) skrives kun med --historik, så rigtige dagsdata ikke overskrives.
  if (process.argv.includes("--historik")) for (const h of history) docs.push({ ...h, history: true });
  return { docs, history, advice: advice([...history, { date: today, avg: docs[0].avg }], chains) };
}

// Samme logik som siden: tank når prisen er lav i forhold til de seneste dage.
function advice(days, chains) {
  days.sort((a, b) => a.date.localeCompare(b.date));
  const t = days[days.length - 1];
  if (!t?.avg) return "Ingen benzinpris i dag.";
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const avg30 = mean(days.slice(-30).map((d) => d.avg));
  const min7 = Math.min(...days.slice(-7).map((d) => d.avg));
  const diff = Math.round((t.avg - avg30) * 100);
  const cheapest = Object.entries(chains).sort((a, b) => a[1] - b[1])[0];
  const c = cheapest ? ` Billigst: ${cheapest[0]} ${cheapest[1].toFixed(2)} kr.` : "";
  if (t.avg <= min7 + 0.005 || diff <= -10) return `TANK I DAG: blyfri 95 ${t.avg.toFixed(2)} kr/l, ${-diff} øre under 30-dages snit.${c}`;
  if (diff >= 15) return `DYRT I DAG: blyfri 95 ${t.avg.toFixed(2)} kr/l, ${diff} øre over snit. Vent hvis du kan.${c}`;
  return `Normal pris: blyfri 95 ${t.avg.toFixed(2)} kr/l (${diff >= 0 ? "+" : ""}${diff} øre mod snit).${c}`;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(new URL("offers/", OUT), { recursive: true });
await mkdir(new URL("sortiment/", OUT), { recursive: true });
await mkdir(new URL("fuel/", OUT), { recursive: true });

const summary = { offers: {}, sortiment: 0, fuel: [], advice: null };
const only = process.argv.find((a) => a === "fuel" || a === "offers" || a === "unox"); // valgfrit

const site = { offers: [], sortiment: [], fuel: null };

if (!only || only === "offers") {
  for (const c of CHAINS) {
    const doc = await fetchOffers(c);
    await writeFile(new URL(`offers/${c.key}.json`, OUT), JSON.stringify(doc));
    summary.offers[c.key] = doc.items.length;
    site.offers.push({ ...doc, _id: c.key });
  }
  const parts = await fetchRemaAssortment();
  for (const d of parts) await writeFile(new URL(`sortiment/rema-${d.part}.json`, OUT), JSON.stringify(d));
  summary.sortiment = parts.length;
  site.sortiment = parts;
}
if (!only || only === "fuel") {
  const fuel = await fetchFuel();
  summary.advice = fuel.advice;
  site.fuel = fuel;
  for (const d of fuel.docs) {
    await writeFile(new URL(`fuel/${d.date}.json`, OUT), JSON.stringify(d));
    summary.fuel.push(d.date);
  }
}

// --site: skriv data og index.html til ./site til GitHub Pages.
if (process.argv.includes("--site")) {
  const SITE = new URL("./site/", import.meta.url);
  const DATA = new URL("data/", SITE);
  await mkdir(DATA, { recursive: true });
  if (site.offers.length) await writeFile(new URL("offers.json", DATA), JSON.stringify({ docs: site.offers }));
  if (site.sortiment.length) await writeFile(new URL("sortiment.json", DATA), JSON.stringify({ docs: site.sortiment }));
  if (site.fuel) {
    // Benzinhistorikken bor i repoet: flet dagens tal ind, og udfyld manglende dage fra kildens 30-dages historik.
    let days = [];
    try { days = JSON.parse(await readFile(new URL("fuel.json", DATA), "utf8")).days || []; } catch {}
    const byDate = new Map(days.map((d) => [d.date, d]));
    for (const d of site.fuel.docs) byDate.set(d.date, d);
    for (const h of site.fuel.history) if (!byDate.has(h.date)) byDate.set(h.date, { ...h, history: true });
    days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    await writeFile(new URL("fuel.json", DATA), JSON.stringify({ days }));
  }
  // Prishistorik til grafer: alle tilbud (én række pr. tilbud) og Remas faste priser (kun ændringer).
  const HIST = new URL("history/", DATA);
  await mkdir(HIST, { recursive: true });
  const readJson = async (u, fallback) => { try { return JSON.parse(await readFile(u, "utf8")); } catch { return fallback; } };
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
  if (site.offers.length) {
    const file = new URL(`tilbud-${today.slice(0, 4)}.json`, HIST);
    const h = await readJson(file, { chains: CHAINS.map((c) => c.name), names: [], recs: [] });
    const nameIdx = new Map(h.names.map((n, i) => [n, i]));
    // Samme tilbud = samme kæde, varenavn, pris og startdato (beskrivelsen varierer en smule mellem kørsler).
    const keyOf = (ci, label, price, from) => `${ci}|${label.split(" | ")[0]}|${price}|${from}`;
    const seen = new Set(h.recs.map((r) => keyOf(r[0], h.names[r[1]], r[2], r[5])));
    let added = 0;
    for (const doc of site.offers) {
      const ci = h.chains.indexOf(doc.chain);
      for (const [name, desc, price, , up, unit, from, till] of doc.items) {
        // Navn + start af beskrivelsen, så fx "400 g" kommer med i søgningen.
        const label = (name + " | " + desc).slice(0, 140);
        const key = keyOf(ci, label, price, from);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!nameIdx.has(label)) { nameIdx.set(label, h.names.length); h.names.push(label); }
        const ni = nameIdx.get(label);
        h.recs.push([ci, ni, price, up, unit, from, till]);
        added++;
      }
    }
    await writeFile(file, JSON.stringify(h));
    summary.historyAdded = added;
  }
  if (site.sortiment.length) {
    const file = new URL("rema-faste.json", HIST);
    const h = await readJson(file, { start: today, items: {} });
    let changed = 0;
    for (const part of site.sortiment) {
      for (const [name, desc, price, up, unit, camp, labels, id] of part.items) {
        const it = (h.items[id] ||= { n: name, d: desc, u: (unit || "").toLowerCase(), l: labels, h: [] });
        Object.assign(it, { n: name, d: desc, l: labels });
        const last = it.h[it.h.length - 1];
        // [dato, pris, enhedspris, kampagne]; kampagnepriser tæller ikke som fast pris på siden.
        if (!last || last[1] !== price || last[2] !== up || (last[3] || 0) !== camp) { it.h.push([today, price, up, camp]); changed++; }
      }
    }
    await writeFile(file, JSON.stringify(h));
    summary.remaChanged = changed;
  }

  // Uno-X: din station, timevis (kræver nøgle).
  if ((!only || only === "unox") && hasUnoxCredentials()) {
    try {
      const res = await updateUnox(DATA, await fetchUnox());
      summary.unox = { station: res.doc.station.name, price: res.doc.changes.at(-1)?.[1], changed: res.changed };
      if (res.notify) summary.unox.notified = await sendNotification(res.notify);
    } catch (e) {
      summary.unox = { error: e.message };
    }
  } else if (only === "unox") summary.unox = { error: "Mangler UNOX_CLIENT_ID og UNOX_CLIENT_SECRET" };

  const page = await readFile(new URL("./hverdag.html", import.meta.url), "utf8");
  const head = `<!doctype html><html lang="da"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Hverdag">
<meta name="theme-color" content="#0f6b4f">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" href="icon-192.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>`;
  await writeFile(new URL("index.html", SITE), head + page + "\n</body></html>\n");
}
console.log(JSON.stringify(summary));
