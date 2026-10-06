// Uno-X' officielle pumpepris-API (https://unoxmobility.dk/privat/braendstofpriser).
// Kræver en personlig nøgle: miljøvariablerne UNOX_CLIENT_ID og UNOX_CLIENT_SECRET.
// Gemmer hver prisændring på "din" station + et øjebliksbillede af nærliggende Uno-X-stationer i site/data/unox.json.
import { readFile, writeFile } from "node:fs/promises";

// Din station. Matches på adresse; ændr her, hvis du skifter fast tankstation.
export const HOME = { address: "Birkerød Kongevej 158", postalCode: "3460" };
const NEARBY_KM = 15;

const TOKEN_URL = "https://auth.unoxmobility.net/realms/production-apigateway/protocol/openid-connect/token";
const API_URL = "https://api.unoxmobility.net/gasstations/v1/getStationsAndPrices";

export const hasUnoxCredentials = () => !!(process.env.UNOX_CLIENT_ID && process.env.UNOX_CLIENT_SECRET);

async function token() {
  const basic = Buffer.from(`${process.env.UNOX_CLIENT_ID}:${process.env.UNOX_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Uno-X login fejlede: ${res.status}`);
  return (await res.json()).access_token;
}

const num = (s) => Number(String(s).replace(",", "."));
// "2025-11-26 11:21:13.210000" (UTC) → ISO
const isoUtc = (s) => (s ? new Date(String(s).replace(" ", "T").replace(/(\.\d{3})\d*$/, "$1") + "Z").toISOString() : null);
function km(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function price95(st) {
  const p = (st.products || []).find((x) => x.fuelType === "Benzin" && String(x.octane) === "95")
    || (st.products || []).find((x) => /95/.test(x.productName || ""));
  return p ? { price: p.price, updated: isoUtc(p.lastUpdated) } : null;
}

export async function fetchUnox() {
  const t = await token();
  const res = await fetch(API_URL, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`Uno-X priser fejlede: ${res.status}`);
  const j = await res.json();
  const list = j.Data || j.data || (Array.isArray(j) ? j : []);
  return list.map((st) => ({
    id: st.stationId,
    name: st.stationName,
    address: st.address?.addressHouseNumber,
    postalCode: st.address?.postalCode,
    city: st.address?.city,
    lat: num(st.address?.coordinates?.latitude),
    lng: num(st.address?.coordinates?.longitude),
    p95: price95(st),
  }));
}

// Opdaterer site/data/unox.json og fortæller, om der skal sendes en notifikation.
export async function updateUnox(dataDir, stations) {
  const file = new URL("unox.json", dataDir);
  let doc = {};
  try { doc = JSON.parse(await readFile(file, "utf8")); } catch {}
  const home = stations.find((s) => s.postalCode === HOME.postalCode && (s.address || "").toLowerCase().startsWith(HOME.address.toLowerCase()))
    || stations.find((s) => /birkerød/i.test(s.name || "") || /birkerød/i.test(s.city || ""));
  if (!home) throw new Error("Fandt ikke din Uno-X-station: " + HOME.address);

  const before = JSON.stringify({ ...doc, checked: undefined, lastNotified: undefined });
  doc.station = { id: home.id, name: home.name, address: `${home.address}, ${home.postalCode} ${home.city}`, lat: home.lat, lng: home.lng };
  const checked = new Date().toISOString();
  doc.changes ||= [];
  let changed = false;
  if (home.p95) {
    const last = doc.changes[doc.changes.length - 1];
    if (!last || last[1] !== home.p95.price) {
      doc.changes.push([home.p95.updated || checked, home.p95.price]);
      changed = true;
    }
  }
  doc.nearby = stations
    .filter((s) => s.p95 && s.id !== home.id && Number.isFinite(s.lat))
    .map((s) => ({ name: s.name, address: `${s.address}, ${s.city}`, km: Math.round(km(home, s) * 10) / 10, price: s.p95.price, updated: s.p95.updated }))
    .filter((s) => s.km <= NEARBY_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 8);
  // Landsgennemsnit for Uno-X, én værdi pr. dag (seneste måling vinder).
  const all = stations.map((s) => s.p95?.price).filter(Boolean);
  if (all.length) {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
    doc.daily ||= [];
    const avg = Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100) / 100;
    const i = doc.daily.findIndex((d) => d[0] === today);
    if (i >= 0) doc.daily[i] = [today, avg, Math.min(...all)]; else doc.daily.push([today, avg, Math.min(...all)]);
  }

  // Notifikation: når prisen netop er faldet til et godt niveau, højst én gang pr. 12 timer.
  const notify = changed ? goodMoment(doc) : null;
  if (notify) {
    const lastSent = doc.lastNotified ? Date.parse(doc.lastNotified) : 0;
    if (Date.now() - lastSent < 12 * 3600e3) return { doc, file, changed, notify: null };
    doc.lastNotified = new Date().toISOString();
  }
  // Skriv kun når noget er ændret, så repoet ikke får en commit hver time.
  if (JSON.stringify({ ...doc, checked: undefined, lastNotified: undefined }) !== before || notify) {
    doc.checked = checked;
    await writeFile(file, JSON.stringify(doc));
  }
  return { doc, file, changed, notify };
}

// Tidsvægtet pris for et tidsrum ud fra ændringsloggen.
function priceAt(changes, t) {
  let p = null;
  for (const [ts, price] of changes) { if (Date.parse(ts) <= t) p = price; else break; }
  return p;
}
function goodMoment(doc) {
  const ch = doc.changes;
  if (ch.length < 2) return null;
  const now = Date.now();
  const cur = ch[ch.length - 1][1];
  const samples = [];
  for (let t = now - 7 * 864e5; t < now; t += 3600e3) { const p = priceAt(ch, t); if (p != null) samples.push(p); }
  if (samples.length < 48) return null; // mindst 2 døgns data
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min14 = Math.min(...(() => { const s = []; for (let t = now - 14 * 864e5; t < now; t += 3600e3) { const p = priceAt(ch, t); if (p != null) s.push(p); } return s; })());
  const below = Math.round((mean - cur) * 100);
  if (cur <= min14 + 0.005 || below >= 20) {
    return `Uno-X ${doc.station.name}: blyfri 95 nu ${cur.toFixed(2)} kr/l, ${below} øre under ugens snit${cur <= min14 + 0.005 ? " (laveste i 14 dage)" : ""}. Godt tidspunkt at tanke.`;
  }
  return null;
}

// Push via ntfy.sh (gratis app til iPhone). Emnet sættes som NTFY_TOPIC.
export async function sendNotification(text) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: { Title: "Tank nu", Tags: "fuelpump", Click: "https://mmelkersen.github.io/hverdag/#benzin" },
    body: text,
  });
  return res.ok;
}
