// Builds the hub payload from the screenings bot's state and encrypts it into data.enc.
// The passphrase lives only in macOS Keychain (service "mitchell-hub"); nothing plaintext is written to the repo.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
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
  const entries = state.entries.filter((e) => e.status !== "cancelled").map((e) => {
    // The bot sometimes writes "2026-11-23 or 2026-11-24" or "unknown": keep the first real date, the rest as an alternative.
    const dates = String(e.date || "").match(/\d{4}-\d{2}-\d{2}/g) || [];
    return {
      ...e,
      date: dates[0] || null,
      dateAlt: dates[1] || null,
      category: category(e),
      guests: e.guests || names.slice(0, e.party || 1),
      past: Boolean(dates[0] && (dates[1] || dates[0]) < today),
    };
  });

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

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
}

// Ticket files (screenshot, full pages, PDF, QR) saved by the bot's bin/save-tickets.mjs, encrypted one file each into t/<id>.enc.
// The id hashes the salt + content, so unchanged files keep their name and nothing is re-committed.
const safeKey = (k) => k.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
async function addAssets(entries, key, salt) {
  mkdirSync(`${ROOT}t`, { recursive: true });
  const keep = new Set();
  for (const e of entries.filter((x) => x.status === "won")) {
    const dir = `${BOT}/data/tickets/${safeKey(e.key)}`;
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    const put = async (name, type) => {
      const buf = readFileSync(`${dir}/${name}`);
      const id = createHash("sha256").update(salt).update(name).update(buf).digest("hex").slice(0, 24);
      keep.add(`${id}.enc`);
      if (!existsSync(`${ROOT}t/${id}.enc`)) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf));
        writeFileSync(`${ROOT}t/${id}.enc`, Buffer.concat([iv, ct]));
      }
      return { id, type };
    };
    const pages = files.filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
    e.assets = {
      ticket: files.includes("ticket.png") ? await put("ticket.png", "image/png") : null,
      qr: files.includes("qr.png") ? await put("qr.png", "image/png") : null,
      pages: await Promise.all(pages.map((f) => put(f, "image/png"))),
      pdf: files.includes("ticket.pdf") ? await put("ticket.pdf", "application/pdf") : null,
    };
  }
  for (const f of readdirSync(`${ROOT}t`)) if (!keep.has(f)) unlinkSync(`${ROOT}t/${f}`);
}

async function encrypt(data, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

const data = payload();
const encFile = `${ROOT}data.enc`;
// Keep the salt stable so a phone that already unlocked stays unlocked; --rotate starts fresh (new passphrase).
const salt = existsSync(encFile) && !process.argv.includes("--rotate")
  ? new Uint8Array(Buffer.from(JSON.parse(readFileSync(encFile, "utf8")).salt, "base64"))
  : crypto.getRandomValues(new Uint8Array(16));
const key = await deriveKey(passphrase(), salt);
await addAssets(data.entries, key, salt);
// Hash without the run timestamp so a no-change run doesn't produce a new commit.
const { lastRun, updatedAt, ...stable } = data;
const hash = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
mkdirSync(`${ROOT}.cache`, { recursive: true });
const hashFile = `${ROOT}.cache/last.sha`;
const prev = existsSync(hashFile) ? readFileSync(hashFile, "utf8").trim() : "";
const stale = existsSync(encFile) && Date.now() - JSON.parse(readFileSync(encFile, "utf8")).at > 12 * 36e5;
if (prev === hash && !stale && !process.argv.includes("--force") && !process.argv.includes("--rotate")) {
  console.log("unchanged");
  process.exit(0);
}
const out = await encrypt(data, key, salt);
out.at = Date.now();
writeFileSync(encFile, JSON.stringify(out) + "\n");
writeFileSync(hashFile, hash + "\n");
console.log(`built: ${data.entries.length} entries, ${data.entries.filter((e) => e.status === "won").length} won, ${data.needs.length} needs`);
