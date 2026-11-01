// Mitchell Hub: decrypts data.enc in the browser and renders tickets, entries, discover and needs.
// Nothing readable ships with the site; the key is derived from the password and kept (non-extractable) in IndexedDB.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

let DATA = null;
let ENC = null;

/* ---------- crypto + key cache ---------- */
async function deriveKey(pass, enc) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(enc.salt), iterations: enc.iter },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
async function decrypt(key, enc) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(enc.iv) }, key, fromB64(enc.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("hub", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveKey = (key, salt) => idb("readwrite", (s) => s.put({ key, salt }, "key")).catch(() => {});
const loadKey = () => idb("readonly", (s) => s.get("key")).catch(() => null);
const clearKey = () => idb("readwrite", (s) => s.delete("key")).catch(() => {});

async function fetchEnc() {
  const r = await fetch(`data.enc?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error("data");
  return r.json();
}

/* ---------- dates ---------- */
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const asDate = (d) => new Date(`${d}T12:00:00`);
const fmt = (d, o) => asDate(d).toLocaleDateString("en-US", o);
const daysUntil = (d) => Math.round((asDate(d) - asDate(TODAY)) / 864e5);
const relDay = (d) => {
  const n = daysUntil(d);
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n > 1 && n < 7 ? fmt(d, { weekday: "long" }) : "";
};
const timeOf = (e) => (e.checkIn || "").replace(/\s*(ET|EST|EDT)\b.*$/i, "").replace(/\s*show$/i, "").trim();
const CAT = { movies: "Movie", tapings: "Taping", events: "Event" };
const SITE = { "1iota": "1iota", iheart: "iHeartRadio", wb: "Warner Bros", wbtickets: "Warner Bros", gofobo: "Gofobo", lionsgate: "Lionsgate", searchlight: "Searchlight", "last-week-tonight": "Last Week Tonight" };
const siteName = (s) => SITE[s] || s;
const shortVenue = (v) => (v || "").split(",")[0];

/* ---------- views ---------- */
const views = { tickets, entries, discover, needs };
const TITLES = { tickets: "Tickets", entries: "Entries", discover: "Discover", needs: "Needs you" };
let segState = { entries: "all", discover: "movies" };

function route() {
  const tab = (location.hash.slice(1) || "tickets").split("/")[0];
  const name = views[tab] ? tab : "tickets";
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === name));
  $("#title").textContent = TITLES[name];
  $("#view").innerHTML = "";
  views[name]($("#view"));
  window.scrollTo(0, 0);
}

function passCard(e, i) {
  const t = timeOf(e);
  const soon = relDay(e.date);
  return `<button class="pass cat-${esc(e.category)}" data-key="${esc(e.key)}" data-i="${i}">
    <div class="pass-top">
      <div><div class="pass-kicker">${esc(CAT[e.category] || "Event")} · ${esc(siteName(e.site))}${soon ? `<span class="soon">${esc(soon)}</span>` : ""}</div>
      <div class="pass-name">${esc(e.event)}</div></div>
      <div class="pass-date"><span>${esc(fmt(e.date, { weekday: "short" }))}</span><b>${esc(fmt(e.date, { month: "short", day: "numeric" }))}</b></div>
    </div>
    <div class="pass-fields">
      <div class="field"><span>Check-in</span><b>${esc(t || "TBA")}</b></div>
      <div class="field"><span>Party</span><b>${esc(e.party || 1)}</b></div>
      <div class="field"><span>Venue</span><b>${esc(shortVenue(e.venue) || "TBA")}</b></div>
    </div>
  </button>`;
}

function tickets(el) {
  const won = DATA.entries.filter((e) => e.status === "won");
  const up = won.filter((e) => !e.past).sort((a, b) => a.date.localeCompare(b.date));
  const past = won.filter((e) => e.past).sort((a, b) => b.date.localeCompare(a.date));
  $("#subtitle").textContent = up.length ? `${up.length} upcoming` : "No upcoming tickets";
  let html = installTip();
  if (!up.length) {
    const pending = DATA.entries.filter((e) => !e.past && /requested|entered|waitlist|queued/.test(e.status)).length;
    html += `<div class="empty"><b>No tickets yet</b>${pending} entr${pending === 1 ? "y is" : "ies are"} waiting to hear back. Wins land here.</div>`;
  } else {
    html += `<div class="section-h">Next up</div>${passCard(up[0], 0)}`;
    if (up.length > 1) html += `<div class="section-h">Later <small>${up.length - 1}</small></div><div class="wallet">${up.slice(1).map((e, i) => passCard(e, i + 1)).join("")}</div>`;
  }
  if (past.length) html += `<div class="section-h">Past <small>${past.length}</small></div><div class="list">${past.map(row).join("")}</div>`;
  el.innerHTML = html;
  bindOpen(el);
  bindTip(el);
}

function row(e) {
  return `<button class="row" data-key="${esc(e.key)}">
    <div class="datebox"><span>${esc(fmt(e.date, { month: "short" }))}</span><b>${esc(fmt(e.date, { day: "numeric" }))}</b><i>${esc(fmt(e.date, { weekday: "short" }))}</i></div>
    <div class="row-main"><b>${esc(e.event)}</b><span>${esc([timeOf(e), shortVenue(e.venue), siteName(e.site)].filter(Boolean).join(" · "))}</span></div>
    <span class="pill ${esc(e.status.split("-")[0])}">${esc(statusLabel(e.status))}</span>
  </button>`;
}
const statusLabel = (s) => ({ won: "Won", requested: "Requested", entered: "Entered", waitlist: "Waitlist", queued: "Queued", failed: "Failed" })[s] || (s.startsWith("over-limit") ? "Max entries" : s);

function seg(name, opts) {
  return `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${segState[name] === v ? "on" : ""}">${esc(l)}</button>`).join("")}</div>`;
}
function bindSeg(el, name) {
  el.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.addEventListener("click", () => { segState[name] = b.dataset.v; route(); }));
}

function entries(el) {
  const all = DATA.entries;
  const pending = all.filter((e) => !e.past && /requested|entered|waitlist|queued/.test(e.status));
  const submitted = all.filter((e) => e.status !== "failed");
  $("#subtitle").textContent = lastRunText();
  const f = segState.entries;
  const list = all.filter((e) => f === "all" || e.category === f);
  const up = list.filter((e) => !e.past).sort((a, b) => a.date.localeCompare(b.date));
  const past = list.filter((e) => e.past).sort((a, b) => b.date.localeCompare(a.date));
  el.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${submitted.length}</b><span>Submitted</span></div>
      <div class="stat g"><b>${all.filter((e) => e.status === "won").length}</b><span>Won</span></div>
      <div class="stat a"><b>${pending.length}</b><span>Waiting</span></div>
    </div>
    ${seg("entries", [["all", "All"], ["movies", "Movies"], ["tapings", "Tapings"], ["events", "Events"]])}
    ${up.length ? `<div class="section-h">Upcoming <small>${up.length}</small></div><div class="list">${up.map(row).join("")}</div>` : `<div class="empty"><b>Nothing upcoming here</b>The bot checks every 2 hours.</div>`}
    ${past.length ? `<div class="section-h">Past <small>${past.length}</small></div><div class="list">${past.map(row).join("")}</div>` : ""}`;
  bindSeg(el, "entries");
  bindOpen(el);
}

function discover(el) {
  const src = (DATA.discover && DATA.discover.sources) || [];
  const f = segState.discover;
  const list = src.filter((s) => s.category === f);
  $("#subtitle").textContent = src.length ? `${src.length} free NYC sources${DATA.discover.checkedAt ? `, checked ${fmt(DATA.discover.checkedAt, { month: "short", day: "numeric" })}` : ""}` : "";
  const order = (s) => (s.autoEnterable && !s.needsAccount ? 0 : s.autoEnterable ? 1 : 2);
  list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  el.innerHTML = `${seg("discover", [["movies", "Movies"], ["tapings", "Tapings"], ["events", "Events"]])}
    ${list.length ? list.map((s) => {
      const u = safeUrl(s.url);
      const tags = [
        s.bot ? `<span class="tag bot">Bot enters</span>` : s.autoEnterable && s.needsAccount ? `<span class="tag acct">Needs account</span>` : !s.autoEnterable ? `<span class="tag">Do it yourself</span>` : "",
        s.kind ? `<span class="tag">${esc(s.kind.replace(/-/g, " "))}</span>` : "",
      ].join("");
      return `<a class="card" ${u ? `href="${esc(u)}" target="_blank" rel="noopener noreferrer"` : ""}>
        <h3>${esc(s.name)}</h3><p>${esc(s.how)}</p>${s.when ? `<p>${esc(s.when)}</p>` : ""}${s.notes ? `<p>${esc(s.notes)}</p>` : ""}
        <div class="tags">${tags}</div></a>`;
    }).join("") : `<div class="empty"><b>Nothing here yet</b>Sources show up after the next research sweep.</div>`}`;
  bindSeg(el, "discover");
}

function needs(el) {
  const n = DATA.needs || [];
  $("#subtitle").textContent = n.length ? `${n.length} thing${n.length === 1 ? "" : "s"} only you can do` : "All clear";
  el.innerHTML = n.length ? n.map((x) => {
    const u = safeUrl(x.url);
    return `<div class="card need ${esc(x.kind)}"><h3>${esc(cap(x.title))}</h3><p>${esc(x.detail)}</p>${u ? `<a class="go" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(x.action || "Open")} ›</a>` : ""}</div>`;
  }).join("") : `<div class="empty"><b>Nothing needs you</b>The bot will flag anything it can't finish on its own.</div>`;
}
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

function lastRunText() {
  const r = DATA.lastRun;
  if (!r) return "";
  const at = new Date(r.at);
  const when = at.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  return `Bot last checked ${when}${r.checked && r.checked.length ? ` · ${r.checked.length} site${r.checked.length === 1 ? "" : "s"}` : ""}`;
}

/* ---------- sheets ---------- */
function bindOpen(el) {
  el.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", () => openEntry(b.dataset.key)));
}
function openSheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}

function openEntry(key) {
  const e = DATA.entries.find((x) => x.key === key);
  if (!e) return;
  if (e.status === "won") return openTicket(e);
  const u = safeUrl(e.ticketUrl || e.url);
  openSheet(`<div class="detail-list">
    <span class="pill ${esc(e.status.split("-")[0])}">${esc(statusLabel(e.status))}</span>
    <h3>${esc(e.event)}</h3>
    <div class="kv"><span>Date</span><b>${esc(fmt(e.date, { weekday: "long", month: "long", day: "numeric" }))}</b></div>
    ${e.checkIn ? `<div class="kv"><span>Check-in</span><b>${esc(e.checkIn)}</b></div>` : ""}
    ${e.venue ? `<div class="kv"><span>Venue</span><b>${esc(e.venue)}</b></div>` : ""}
    <div class="kv"><span>Party</span><b>${esc((e.guests || []).join(", ") || e.party)}</b></div>
    <div class="kv"><span>Type</span><b>${esc(CAT[e.category])} · ${esc(siteName(e.site))}</b></div>
    ${e.enteredAt && !/before/.test(e.enteredAt) ? `<div class="kv"><span>Entered</span><b>${esc(new Date(e.enteredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</b></div>` : ""}
    ${e.note ? `<div class="info">${esc(e.note)}</div>` : ""}
    ${u ? `<div class="actions"><a class="btn" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Open on ${esc(siteName(e.site))}</a></div>` : ""}
  </div>`);
}

const WALLET_SVG = `<svg viewBox="0 0 30 22" aria-hidden="true"><rect x="1" y="1" width="28" height="20" rx="4" fill="#fff"/><rect x="1" y="3" width="28" height="5" fill="#ff3b30"/><rect x="1" y="7" width="28" height="5" fill="#ffcc00"/><rect x="1" y="11" width="28" height="5" fill="#34c759"/><path d="M1 14h9a5 5 0 0 0 10 0h9v3a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4z" fill="#d1d1d6"/></svg>`;

function openTicket(e) {
  const t = timeOf(e);
  const ticketUrl = safeUrl(e.ticketUrl || e.url);
  const venue = e.venue && !/tba|not disclosed|^new york(,| city)/i.test(e.venue) ? e.venue : "";
  openSheet(`<div class="ticket">
    <div class="ticket-head cat-${esc(e.category)}">
      <div class="pass-kicker">${esc(CAT[e.category])} · ${esc(siteName(e.site))}${relDay(e.date) ? `<span class="soon">${esc(relDay(e.date))}</span>` : ""}</div>
      <div class="pass-name">${esc(e.event)}</div>
      <div class="ticket-when">
        <div class="field"><span>Date</span><b>${esc(fmt(e.date, { weekday: "short", month: "short", day: "numeric" }))}</b></div>
        <div class="field"><span>Check-in</span><b>${esc(t || "TBA")}</b></div>
        <div class="field"><span>Party</span><b>${esc(e.party || 1)}</b></div>
      </div>
    </div>
    <div class="perf"><i></i></div>
    <div class="ticket-body">
      <div class="ticket-grid">
        <div class="field"><span>Venue</span><b>${esc(e.venue || "TBA")}</b></div>
        <div class="field"><span>Ticket from</span><b>${esc(siteName(e.site))}</b></div>
      </div>
      <div class="guests"><ul>${(e.guests || []).map((g, i) => `<li>${esc(g)}<span>${i === 0 ? "Holder" : `Guest ${i}`}</span></li>`).join("")}</ul></div>
      ${e.instructions ? `<div class="ticket-note">${esc(e.instructions)}</div>` : ""}
      ${e.note ? `<details class="ticket-note"><summary>Bot notes</summary>${esc(e.note)}</details>` : ""}
    </div>
  </div>
  <div class="actions">
    ${ticketUrl ? `<a class="btn primary" href="${esc(ticketUrl)}" target="_blank" rel="noopener noreferrer">View ticket on ${esc(siteName(e.site))}</a>` : ""}
    <button class="wallet-btn" id="wallet">${WALLET_SVG}Add to Apple Wallet</button>
    <button class="btn" id="ics">Add to Calendar</button>
    ${venue ? `<a class="btn" href="https://maps.apple.com/?q=${encodeURIComponent(venue)}" target="_blank" rel="noopener noreferrer">Directions</a>` : ""}
  </div>`);
  $("#ics").addEventListener("click", () => downloadIcs(e));
  $("#wallet").addEventListener("click", () => walletInfo(e));
}

function walletInfo(e) {
  const pass = safeUrl(e.passUrl);
  if (pass) { location.href = pass; return; }
  openSheet(`<div class="detail-list"><h3>Apple Wallet</h3>
    <div class="info"><b>Wallet passes need a one-time Apple setup.</b> Apple only accepts passes signed with a Pass Type certificate from an Apple Developer account ($99 a year). Once that certificate is added, every ticket here gets a real Wallet pass and this button adds it straight in.</div>
    <div class="info">Until then: save this site to your Home Screen (Share, then Add to Home Screen). It opens straight to Tickets and works with no signal at the venue.</div>
    <div class="actions"><button class="btn" id="back">Back to ticket</button></div></div>`);
  $("#back").addEventListener("click", () => openTicket(e));
}

function parseTime(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(s || "");
  if (!m) return null;
  let h = +m[1] % 12;
  if (/pm/i.test(m[3])) h += 12;
  return [h, +(m[2] || 0)];
}
function downloadIcs(e) {
  const d = e.date.replace(/-/g, "");
  const tm = parseTime(e.checkIn);
  const pad = (n) => String(n).padStart(2, "0");
  const icsEsc = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const start = tm ? `DTSTART;TZID=America/New_York:${d}T${pad(tm[0])}${pad(tm[1])}00` : `DTSTART;VALUE=DATE:${d}`;
  const end = tm ? `DTEND;TZID=America/New_York:${d}T${pad(Math.min(tm[0] + 3, 23))}${pad(tm[1])}00` : "";
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mitchell Hub//EN", "BEGIN:VEVENT",
    `UID:${e.key.replace(/[^a-z0-9]/gi, "-")}@mitchell-hub`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    start, end, `SUMMARY:${icsEsc(e.event)}`, `LOCATION:${icsEsc(e.venue)}`,
    `DESCRIPTION:${icsEsc(`Check-in ${e.checkIn || "TBA"}. Party: ${(e.guests || []).join(", ")}. ${e.note || ""}`)}`,
    safeUrl(e.url) ? `URL:${e.url}` : "", "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Leave for check-in", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `${e.event.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- home screen tip ---------- */
function installTip() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  if (!ios || standalone || localStorage.getItem("tip-a2hs")) return "";
  return `<div class="tip">Tap Share, then Add to Home Screen, to open tickets like an app.<button id="tip-x" aria-label="Dismiss">OK</button></div>`;
}
function bindTip(el) {
  const b = $("#tip-x", el);
  if (b) b.addEventListener("click", () => { localStorage.setItem("tip-a2hs", "1"); b.parentElement.remove(); });
}

/* ---------- boot ---------- */
function show(data) {
  DATA = data;
  $("#lock").hidden = true;
  $("#app").hidden = false;
  const n = (data.needs || []).length;
  const badge = $("#needs-badge");
  badge.hidden = !n;
  badge.textContent = n;
  route();
}

async function unlock(ev) {
  ev.preventDefault();
  const btn = $("#unlock-btn");
  btn.disabled = true;
  btn.textContent = "Unlocking…";
  $("#lock-err").textContent = "";
  try {
    ENC = ENC || await fetchEnc();
    const key = await deriveKey($("#pass").value, ENC);
    const data = await decrypt(key, ENC);
    await saveKey(key, ENC.salt);
    $("#pass").value = "";
    show(data);
  } catch (err) {
    $("#lock-err").textContent = err.message === "data" ? "Can't reach the hub. Check your connection." : "That's not it.";
    const card = $(".lock-card");
    card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
  } finally {
    btn.disabled = false;
    btn.textContent = "Unlock";
  }
}

async function boot() {
  $("#lock-form").addEventListener("submit", unlock);
  $("#lock-btn").addEventListener("click", async () => { await clearKey(); DATA = null; $("#app").hidden = true; $("#lock").hidden = false; $("#view").innerHTML = ""; });
  $("#sheet").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  window.addEventListener("hashchange", () => { closeSheet(); if (DATA) route(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try {
    const [cached, enc] = await Promise.all([loadKey(), fetchEnc()]);
    ENC = enc;
    if (cached && cached.salt === enc.salt) return show(await decrypt(cached.key, enc));
  } catch { /* fall through to the lock screen */ }
  $("#lock").hidden = false;
}
boot();
