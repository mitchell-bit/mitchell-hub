// Builds the hub payload from the screenings bot's state and encrypts it into data.enc.
// The passphrase lives only in macOS Keychain (service "mitchell-hub"); nothing plaintext is written to the repo.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { webcrypto as crypto, createHash } from "node:crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const BOT = process.env.SCREENINGS_DIR || "/Users/mitchell/nyc-screenings";
const ITER = 600000;

const passphrase = () =>
  process.env.HUB_PASSPHRASE ||
  execFileSync("security", ["find-generic-password", "-s", "mitchell-hub", "-a", "passphrase", "-w"]).toString().trim();

const MOVIE_SITES = new Set(["lionsgate", "searchlight", "wb", "wbtickets", "gofobo", "universal", "apple", "previewfreemovies"]);
const TAPING_SITES = new Set(["1iota", "last-week-tonight", "oncameraaudiences", "nbc", "tvtix"]);
const category = (e) => {
  if (e.category) return e.category;
  const text = `${e.event} ${e.note || ""}`.toLowerCase();
  if (MOVIE_SITES.has(e.site)) return "movies";
  if (/screening|premiere/.test(text) && !/cast arrivals/.test(text)) return "movies";
  if (TAPING_SITES.has(e.site) || /show|taping|live|snl/.test(text) && e.site === "1iota") return "tapings";
  return "events";
};

// Party names come from the bot's preferences so they never sit in plaintext here.
const partyNames = () => {
  const prefs = readFileSync(`${BOT}/config/preferences.md`, "utf8");
  const m = prefs.match(/Default \d+ seats?: ([^.\n]+)/);
  return m ? m[1].split(",").map((s) => s.trim()) : ["Mitchell"];
};

function payload() {
  const state = JSON.parse(readFileSync(`${BOT}/data/state.json`, "utf8"));
  const names = partyNames();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const entries = state.entries.map((e) => ({
    ...e,
    category: category(e),
    guests: e.guests || names.slice(0, e.party || 1),
    past: e.date < today,
  }));

  const needs = [];
  const humanKey = (k) => {
    const [site, slug, date] = String(k).split(":");
    const name = (slug || site).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return date ? `${name}, ${new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : name;
  };
  for (const n of state.needsMitchell || []) {
    const [kind, ...rest] = String(n.reason || "needs you").split(":");
    const site = String(n.key).split(":")[0];
    needs.push({ kind: "bot", title: humanKey(n.key), detail: `${kind.replace(/-/g, " ")}: ${rest.join(":").trim()}`, key: n.key, url: n.url || (site === "advancescreenings" ? "https://www.advancescreenings.com/city/us/ny/new_york" : undefined) });
  }
  for (const e of entries)
    if (e.needsMitchell && !e.past) needs.push({ kind: "entry", title: e.event, detail: e.needsMitchell, url: e.url, key: e.key });
  const recent = (state.runs || []).filter((r) => Date.now() - Date.parse(r.at) < 864e5);
  const seen = new Set();
  for (const r of recent)
    for (const p of r.problems || [])
      if (/^(login-expired|captcha|needs-account)/.test(p) && !seen.has(p)) {
        seen.add(p);
        needs.push({ kind: "bot", title: p.split(":")[0].replace(/-/g, " "), detail: p.split(":").slice(1).join(":") });
      }
  const setup = existsSync(`${BOT}/config/hub-needs.json`) ? JSON.parse(readFileSync(`${BOT}/config/hub-needs.json`, "utf8")) : [];
  needs.push(...setup.map((s) => ({ kind: "setup", ...s })));

  const discover = existsSync(`${BOT}/config/discover.json`) ? JSON.parse(readFileSync(`${BOT}/config/discover.json`, "utf8")) : { sources: [] };
  const last = (state.runs || []).at(-1) || null;
  return { entries, needs, discover, attended: state.attended || [], lastRun: last, updatedAt: state.updated || new Date().toISOString() };
}

const b64 = (buf) => Buffer.from(buf).toString("base64");

async function encrypt(data, pass, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

const data = payload();
// Hash without the run timestamp so a no-change run doesn't produce a new commit.
const { lastRun, updatedAt, ...stable } = data;
const hash = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
mkdirSync(`${ROOT}.cache`, { recursive: true });
const hashFile = `${ROOT}.cache/last.sha`;
const prev = existsSync(hashFile) ? readFileSync(hashFile, "utf8").trim() : "";
const encFile = `${ROOT}data.enc`;
const stale = existsSync(encFile) && Date.now() - JSON.parse(readFileSync(encFile, "utf8")).at > 12 * 36e5;
if (prev === hash && !stale && !process.argv.includes("--force") && !process.argv.includes("--rotate")) {
  console.log("unchanged");
  process.exit(0);
}
// Keep the salt stable so a phone that already unlocked stays unlocked; --rotate starts fresh (new passphrase).
const salt = existsSync(encFile) && !process.argv.includes("--rotate")
  ? new Uint8Array(Buffer.from(JSON.parse(readFileSync(encFile, "utf8")).salt, "base64"))
  : crypto.getRandomValues(new Uint8Array(16));
const out = await encrypt(data, passphrase(), salt);
out.at = Date.now();
writeFileSync(encFile, JSON.stringify(out) + "\n");
writeFileSync(hashFile, hash + "\n");
console.log(`built: ${data.entries.length} entries, ${data.entries.filter((e) => e.status === "won").length} won, ${data.needs.length} needs`);
