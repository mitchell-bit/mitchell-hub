// Mitchell Hub: decrypts data.enc in the browser and renders tickets, entries, discover and needs.
// Nothing readable ships with the site; the key is derived from the password and kept (non-extractable) in IndexedDB.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

let DATA = null;
let ENC = null;
let KEY = null;

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
// Undated entries (date null) render as TBA instead of "Invalid Date".
const fmt = (d, o) => (d ? asDate(d).toLocaleDateString("en-US", o) : "TBA");
const daysUntil = (d) => Math.round((asDate(d) - asDate(TODAY)) / 864e5);
const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999");
const relDay = (d) => {
  if (!d) return "";
  const n = daysUntil(d);
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n > 1 && n < 7 ? fmt(d, { weekday: "long" }) : "";
};
// Contest titles read "Win Tickets To See X (sweepstakes)"; show just X.
const cleanName = (n) => String(n || "").replace(/^win (advance(d)? )?(screening )?(passes|tickets)( and [^\s]+)? to (see )?/i, "").replace(/\s*\((?:[^)]*sweepstakes[^)]*)\)\s*$/i, "").trim() || n;
const timeOf = (e) => /unknown|tba/i.test(e.checkIn || "") ? "" : (e.checkIn || "").replace(/\s*(ET|EST|EDT)\b.*$/i, "").replace(/\s*show$/i, "").trim();
const CAT = { movies: "Movie", tapings: "Taping", events: "Event" };
const SITE = { "1iota": "1iota", iheart: "iHeartRadio", wb: "Warner Bros", wbtickets: "Warner Bros", gofobo: "Gofobo", lionsgate: "Lionsgate", searchlight: "Searchlight", "last-week-tonight": "Last Week Tonight" };
const siteName = (s) => SITE[s] || s;
const shortVenue = (v) => (/^unknown/i.test(v || "") ? "" : (v || "").split(",")[0]);

/* ---------- views ---------- */
const views = { tickets, entries, discover, needs };
const TITLES = { tickets: "Tickets", entries: "Entries", discover: "Discover", needs: "Needs you" };
let segState = { entries: "all", discover: "movies" };

let currentTab = null;
function route() {
  const tab = (location.hash.slice(1) || "tickets").split("/")[0];
  const name = views[tab] ? tab : "tickets";
  const render = () => {
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === name));
    $("#title").textContent = $("#mini-title").textContent = TITLES[name];
    const v = $("#view");
    v.innerHTML = "";
    v.style.animation = "none"; void v.offsetWidth; v.style.animation = "";
    views[name](v);
    if (currentTab !== name) { window.scrollTo(0, 0); document.body.classList.remove("scrolled"); }
    currentTab = name;
  };
  render();
}

function passCard(e, i) {
  const t = timeOf(e);
  const soon = relDay(e.date);
  return `<button class="pass cat-${esc(e.category)}" data-key="${esc(e.key)}" data-i="${i}">
    <div class="pass-top">
      <div><div class="pass-kicker">${esc(CAT[e.category] || "Event")} · ${esc(siteName(e.site))}${soon ? `<span class="soon">${esc(soon)}</span>` : ""}</div>
      <div class="pass-name">${esc(cleanName(e.event))}</div></div>
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
  const up = won.filter((e) => !e.past).sort(byDate);
  const past = won.filter((e) => e.past).sort((a, b) => byDate(b, a));
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
    <div class="datebox">${e.date ? `<span>${esc(fmt(e.date, { month: "short" }))}</span><b>${esc(fmt(e.date, { day: "numeric" }))}</b><i>${esc(fmt(e.date, { weekday: "short" }))}</i>` : `<span>Date</span><b class="tba">TBA</b>`}</div>
    <div class="row-main"><b>${esc(cleanName(e.event))}</b><span>${esc([timeOf(e), shortVenue(e.venue), siteName(e.site)].filter(Boolean).join(" · "))}</span></div>
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
  const up = list.filter((e) => !e.past).sort(byDate);
  const past = list.filter((e) => e.past).sort((a, b) => byDate(b, a));
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
  const order = (s) => (s.bot ? 0 : s.autoEnterable && !s.needsAccount ? 1 : s.autoEnterable ? 2 : 3);
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

/* ---------- layers: stacked popups ---------- */
// Every popup is its own layer on top of the page (a bottom sheet or a centered card), so a QR code opens over the
// ticket instead of replacing it. Back gesture, Esc, tapping outside, or swiping down closes the top layer only.
const X_SVG = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const stack = [];
function present(html, { card = false } = {}) {
  const layer = document.createElement("div");
  layer.className = `layer${card ? " card" : ""}`;
  layer.innerHTML = `<div class="layer-bg"></div><div class="layer-panel" role="dialog" aria-modal="true"><div class="layer-grab"></div><button class="layer-x" aria-label="Close">${X_SVG}</button><div class="layer-body">${html}</div></div>`;
  $("#layers").appendChild(layer);
  stack.push(layer);
  document.body.style.overflow = "hidden";
  history.pushState({ layer: stack.length }, "");
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("in")));
  layer.querySelector(".layer-bg").addEventListener("click", () => history.back());
  layer.querySelector(".layer-x").addEventListener("click", () => history.back());
  dragToClose(layer);
  return layer.querySelector(".layer-body");
}
function dismissTop() {
  const layer = stack.pop();
  if (!layer) return;
  layer.classList.remove("in");
  setTimeout(() => layer.remove(), 380);
  if (!stack.length) document.body.style.overflow = "";
}
function dismissAll() { while (stack.length) dismissTop(); }
window.addEventListener("popstate", (ev) => {
  const depth = (ev.state && ev.state.layer) || 0;
  while (stack.length > depth) dismissTop();
});
function dragToClose(layer) {
  const panel = layer.querySelector(".layer-panel");
  let y0 = null, dy = 0;
  panel.addEventListener("touchstart", (e) => { if (panel.scrollTop <= 0) { y0 = e.touches[0].clientY; dy = 0; } }, { passive: true });
  panel.addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { panel.style.transform = ""; layer.classList.remove("dragging"); return; }
    layer.classList.add("dragging");
    panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener("touchend", () => {
    if (y0 === null) return;
    y0 = null;
    layer.classList.remove("dragging");
    panel.style.transform = "";
    if (dy > 110) history.back();
  });
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 1800);
}
function bindOpen(el) {
  el.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", () => openEntry(b.dataset.key)));
}
const openSheet = (html) => present(html);

function openEntry(key) {
  const e = DATA.entries.find((x) => x.key === key);
  if (!e) return;
  if (e.status === "won") return openTicket(e);
  const u = safeUrl(e.ticketUrl || e.url);
  openSheet(`<div class="detail-list">
    <span class="pill ${esc(e.status.split("-")[0])}">${esc(statusLabel(e.status))}</span>
    <h3>${esc(cleanName(e.event))}</h3>
    <div class="kv"><span>Date</span><b>${esc(fmt(e.date, { weekday: "long", month: "long", day: "numeric" }))}${e.dateAlt ? ` or ${esc(fmt(e.dateAlt, { month: "short", day: "numeric" }))}` : ""}</b></div>
    ${e.checkIn ? `<div class="kv"><span>Check-in</span><b>${esc(e.checkIn)}</b></div>` : ""}
    ${e.venue ? `<div class="kv"><span>Venue</span><b>${esc(e.venue)}</b></div>` : ""}
    <div class="kv"><span>Party</span><b>${esc((e.guests || []).join(", ") || e.party)}</b></div>
    <div class="kv"><span>Type</span><b>${esc(CAT[e.category])} · ${esc(siteName(e.site))}</b></div>
    ${e.enteredAt && !/before/.test(e.enteredAt) ? `<div class="kv"><span>Entered</span><b>${esc(new Date(e.enteredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</b></div>` : ""}
    ${e.note ? `<div class="info">${esc(e.note)}</div>` : ""}
    ${u ? `<div class="actions"><a class="btn" href="${esc(u)}" target="_blank" rel="noopener noreferrer">Open on ${esc(siteName(e.site))}</a></div>` : ""}
  </div>`);
}

const ICON = {
  qr: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>`,
  ticket: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v12" stroke-dasharray="2 2"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>`,
  cal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  map: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  chev: `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>`,
};

function openTicket(e) {
  const t = timeOf(e);
  const a = e.assets || {};
  const hasPages = a.pages && a.pages.length;
  const ticketUrl = safeUrl(e.ticketUrl || e.url);
  const venue = e.venue && !/tba|not disclosed|^new york(,| city)/i.test(e.venue) ? e.venue : "";
  const noCode = e.emailId || /list|name/i.test(e.instructions || "") ? "Your name is on the list. Bring photo ID." : "The ticket is saved automatically after the bot's next run.";
  const body = present(`<div class="ticket">
    <div class="ticket-head cat-${esc(e.category)}">
      <div class="pass-kicker">${esc(CAT[e.category])} · ${esc(siteName(e.site))}${relDay(e.date) ? `<span class="soon">${esc(relDay(e.date))}</span>` : ""}</div>
      <div class="pass-name">${esc(cleanName(e.event))}</div>
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
      ${a.qr ? `<div class="stub"><button class="stub-qr" id="stub-qr" aria-label="Enlarge QR code"><div class="spinner"></div></button><div class="stub-text"><b>Tap to scan</b>Show this at check-in. It opens big and bright.</div></div>` : `<div class="stub"><div class="stub-text"><b>No code to scan</b>${esc(noCode)}</div></div>`}
      ${e.note ? `<details class="ticket-note"><summary>Bot notes</summary>${esc(e.note)}</details>` : ""}
    </div>
  </div>
  <div class="tiles">
    <button class="tile" id="t-qr" ${a.qr ? "" : "disabled"}>${ICON.qr}QR Code</button>
    <button class="tile" id="t-ticket" ${a.ticket ? "" : "disabled"}>${ICON.ticket}Ticket</button>
    <button class="tile" id="t-pdf" ${hasPages ? "" : "disabled"}>${ICON.pdf}Full PDF</button>
  </div>
  <div class="ilist">
    ${ticketUrl ? `<a href="${esc(ticketUrl)}" target="_blank" rel="noopener noreferrer">${ICON.link}Open on ${esc(siteName(e.site))}${ICON.chev}</a>` : ""}
    <button id="ics">${ICON.cal}Add to Calendar${ICON.chev}</button>
    ${venue ? `<a href="https://maps.apple.com/?q=${encodeURIComponent(venue)}" target="_blank" rel="noopener noreferrer">${ICON.map}Directions${ICON.chev}</a>` : ""}
  </div>`);
  $("#ics", body).addEventListener("click", () => { downloadIcs(e); toast("Calendar event ready"); });
  if (a.qr) {
    assetUrl(a.qr).then((u) => { const b = $("#stub-qr", body); if (b) b.innerHTML = `<img src="${u}" alt="QR code">`; }).catch(() => {});
    const openQr = () => showQr(e, a.qr);
    $("#stub-qr", body).addEventListener("click", openQr);
    $("#t-qr", body).addEventListener("click", openQr);
  }
  if (a.ticket) $("#t-ticket", body).addEventListener("click", () => showImages(e, [a.ticket], "Ticket"));
  if (hasPages) $("#t-pdf", body).addEventListener("click", () => showImages(e, a.pages, "Full ticket", a.pdf));
}

/* ---------- ticket files ---------- */
const blobs = {};
async function assetUrl(asset) {
  if (blobs[asset.id]) return blobs[asset.id];
  const r = await fetch(`t/${asset.id}.enc`);
  if (!r.ok) throw new Error("asset");
  const buf = new Uint8Array(await r.arrayBuffer());
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, KEY, buf.slice(12));
  return (blobs[asset.id] = URL.createObjectURL(new Blob([pt], { type: asset.type })));
}
const popHead = (e, label) => `<div class="pop-title">${esc(label)}</div><p class="pop-sub">${esc(e.event)} · ${esc(fmt(e.date, { weekday: "short", month: "short", day: "numeric" }))}</p>`;
async function showQr(e, qr) {
  const body = present(`${popHead(e, "Scan at check-in")}<div class="pop-load"><div class="spinner"></div></div>`, { card: true });
  try {
    const u = await assetUrl(qr);
    $(".pop-load", body).outerHTML = `<img class="pop-qr" src="${u}" alt="QR code"><p class="pop-hint">${esc((e.guests || [])[0] || "")} · Admit ${esc(e.party || 1)} · Turn your brightness up</p>`;
  } catch { $(".pop-load", body).textContent = "Couldn't open the code. Check your connection."; }
}
async function showImages(e, assets, label, pdf = null) {
  const body = present(`${popHead(e, label)}<div class="pop-load"><div class="spinner"></div></div>`, { card: true });
  try {
    const urls = await Promise.all(assets.map(assetUrl));
    $(".pop-load", body).outerHTML = `<div class="pop-scroll">${urls.map((u, i) => `<img class="pop-img" src="${u}" alt="${esc(label)}${urls.length > 1 ? ` page ${i + 1}` : ""}">`).join("")}</div>` +
      (pdf ? `<button class="btn" id="open-pdf">Open original PDF</button>` : "");
    if (pdf) $("#open-pdf", body).addEventListener("click", async () => window.open(await assetUrl(pdf), "_blank"));
  } catch { $(".pop-load", body).textContent = "Couldn't open it. Check your connection."; }
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

/* ---------- pull to refresh ---------- */
function pullToRefresh() {
  let y0 = null, pulled = false;
  addEventListener("touchstart", (e) => { y0 = scrollY <= 0 && !stack.length && DATA ? e.touches[0].clientY : null; pulled = false; }, { passive: true });
  addEventListener("touchmove", (e) => { if (y0 !== null && e.touches[0].clientY - y0 > 80) { pulled = true; $("#ptr").classList.add("show"); } }, { passive: true });
  addEventListener("touchend", async () => {
    if (!pulled) return;
    y0 = null; pulled = false;
    try {
      const enc = await fetchEnc();
      if (enc.salt === ENC.salt) { ENC = enc; DATA = await decrypt(KEY, enc); updateBadge(); route(); toast("Up to date"); }
    } catch { toast("Couldn't refresh"); }
    $("#ptr").classList.remove("show");
  });
}

/* ---------- boot ---------- */
function updateBadge() {
  const n = (DATA.needs || []).length;
  const badge = $("#needs-badge");
  badge.hidden = !n;
  badge.textContent = n;
}
function show(data) {
  DATA = data;
  $("#lock").hidden = true;
  $("#app").hidden = false;
  updateBadge();
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
    KEY = key;
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

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stack.length) history.back(); });
  addEventListener("scroll", () => document.body.classList.toggle("scrolled", scrollY > 36), { passive: true });
  pullToRefresh();
  window.addEventListener("hashchange", () => { dismissAll(); if (DATA) route(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try {
    const [cached, enc] = await Promise.all([loadKey(), fetchEnc()]);
    ENC = enc;
    if (cached && cached.salt === enc.salt) { const data = await decrypt(cached.key, enc); KEY = cached.key; return show(data); }
  } catch { /* fall through to the lock screen */ }
  $("#lock").hidden = false;
}
boot();
