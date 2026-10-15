// Coverage Index: the reader. Plain JavaScript, no build step. Reads the JSON the collector (every 15 minutes)
// writes to data/. The front page is laid out like a newspaper; j/k move through it in reading order.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = n => n.toLocaleString("en-US");
const TZ = "America/New_York";

// ---------------------------------------------------------------- state (mirrored in the URL)
const S = {
  view: "day",        // day | week | month | year
  id: null,           // 2026-10-14 | 2026-W42 | 2026-10 | 2026
  rank: "coverage",   // coverage | picks | newest
  cat: null,          // section (category) id, or null for all
  region: [],         // place path: [] = World, ["Europe"], ["Europe", "United Kingdom"], ...
  type: null,         // media type, or null for all
  off: new Set(),     // outlets switched off
  reps: false,        // count reprints as their own outlet
  q: "",
  open: null,         // id of the story (event) opened for reading
};
let META, INDEX, STATUS, OUT = {}, CATS = [], DATA = null, ITEMS = [], sel = 0, limit = 120, termOn = null, panel = null, showSingles = false;
const cache = new Map();
const KEYS_CATS = "1234567890";  // number keys pick the first ten sections

// ---------------------------------------------------------------- URL and saved preferences
function toHash() {
  const p = new URLSearchParams();
  if (S.view !== "day") p.set("v", S.view);
  if (S.id && S.id !== latest(S.view)) p.set("d", S.id);
  if (S.rank !== "coverage") p.set("rank", S.rank);
  if (S.cat) p.set("cat", S.cat);
  if (S.region.length) p.set("region", S.region.join("/"));
  if (S.type) p.set("type", S.type);
  if (S.off.size) p.set("off", [...S.off].sort().join(","));
  if (S.reps) p.set("reps", "1");
  if (S.q) p.set("q", S.q);
  if (S.open) p.set("c", S.open);
  const h = p.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname);
}
function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  S.view = ["week", "month", "year"].includes(p.get("v")) ? p.get("v") : "day";
  S.id = p.get("d") || null;
  S.rank = ["picks", "newest"].includes(p.get("rank")) ? p.get("rank") : "coverage";
  S.cat = p.get("cat") || null;
  S.region = p.get("region") ? p.get("region").split("/") : [];
  S.type = p.get("type") || null;
  if (p.has("off")) S.off = new Set(p.get("off").split(",").filter(Boolean));
  S.reps = p.get("reps") === "1";
  S.q = p.get("q") || "";
  S.open = p.get("c") || null;
}
function saveLocal() { try { localStorage.setItem("ci-off", [...S.off].join(",")); localStorage.setItem("ci-reps", S.reps ? "1" : ""); } catch (e) {} }
function loadLocal() {
  try {
    const off = localStorage.getItem("ci-off") ?? localStorage.getItem("spread-off");
    if (off) S.off = new Set(off.split(",").filter(Boolean));
    S.reps = (localStorage.getItem("ci-reps") ?? localStorage.getItem("spread-reps")) === "1";
  } catch (e) {}
}

// ---------------------------------------------------------------- data
async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const fresh = path.startsWith("days/") || path === "index.json" || path === "status.json";
  const r = await fetch("data/" + path, { cache: fresh ? "no-cache" : "default" });
  if (!r.ok) throw new Error(path + ": " + r.status);
  const j = await r.json();
  cache.set(path, j);
  return j;
}
const periods = view => view === "day" ? INDEX.days : INDEX.roundups[view] || [];
function latest(view) { if (!INDEX) return null; const l = periods(view); return l[l.length - 1] || null; }

async function loadPeriod() {
  S.id = S.id && periods(S.view).includes(S.id) ? S.id : latest(S.view);
  if (!S.id) { DATA = { groups: [], stories: [] }; return; }
  if (S.view === "day") {
    const d = await getJSON("days/" + S.id + ".json");
    const by = new Map();
    for (const s of d.stories) { const k = s.c || s.id; if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
    DATA = { stories: d.stories, groups: [...by.entries()].map(([id, ss]) => ({ id, s: ss })) };
  } else {
    const r = await getJSON("roundups/" + S.view + "/" + S.id + ".json");
    DATA = { stories: r.groups.flatMap(g => g.s.map(s => ({ ...s, cat: g.cat, c: g.id }))),
             groups: r.groups.map(g => ({ id: g.id, s: g.s.map(s => ({ ...s, cat: g.cat })) })) };
  }
}

// ---------------------------------------------------------------- filters and counting
const regionOf = o => o.place || [];
const inRegion = o => { const r = regionOf(o); return S.region.every((p, i) => r[i] === p); };
const inType = o => !S.type || (o.media || []).includes(S.type);
const inScope = o => o && inRegion(o) && inType(o);
const isOn = o => inScope(o) && o.available !== false && !S.off.has(o.id);
const catOk = s => !S.cat || (s.cat || []).includes(S.cat);
const qOk = s => { if (!S.q) return true; const q = S.q.toLowerCase(); return s.t.toLowerCase().includes(q) || (OUT[s.o]?.name || "").toLowerCase().includes(q); };
const WIRE = o => (o?.media || []).includes("Wire");
const CAT_NAME = id => (CATS.find(c => c.id === id) || {}).name || id;

// A story (event) as currently filtered: only stories from outlets that are on, each outlet counted once, and a
// reprint counted as the outlet it repeats unless "count reprints" is on.
function view(g) {
  const on = g.s.filter(s => isOn(OUT[s.o]));
  if (!on.length) return null;
  if (S.cat && on.filter(s => (s.cat || []).includes(S.cat)).length * 3 < on.length) return null;
  if (S.q && !on.some(qOk)) return null;
  const keys = new Set(on.map(s => (!S.reps && s.rep) ? "rep:" + s.rep : s.o));
  const sorted = [...on].sort((a, b) => a.at.localeCompare(b.at));
  const lead = sorted.find(s => WIRE(OUT[s.o])) || sorted[0];
  const cats = {};
  on.forEach(s => (s.cat || []).forEach(c => cats[c] = (cats[c] || 0) + 1));
  const catIds = Object.entries(cats).filter(([, k]) => k * 3 >= on.length).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return { id: g.id, on: sorted, n: keys.size, lead, first: sorted[0].at, last: sorted[sorted.length - 1].at,
           img: (sorted.find(s => s.img) || {}).img, cats: catIds, section: sectionOf(catIds) };
}
const publishing = () => new Set(DATA.stories.filter(s => isOn(OUT[s.o])).map(s => s.o));

// The one section label a story shows: its most specific category. Broad ones (Politics, World, U.S.) come last.
const SECTION_ORDER = ["conflict", "economy", "business", "tech", "science", "health", "environment", "culture", "sports", "politics", "world", "us"];
const BLOCK_OF = { conflict: null, economy: "Business & Economy", business: "Business & Economy", tech: "Tech & Science", science: "Tech & Science",
                   health: "Health & Environment", environment: "Health & Environment", culture: "Culture & Sports", sports: "Culture & Sports" };
const BLOCK_ORDER = ["World", "conflict", "Politics", "U.S.", "Business & Economy", "Tech & Science", "Health & Environment", "Culture & Sports", "Other"];
function sectionOf(catIds) {
  const id = SECTION_ORDER.find(c => catIds.includes(c));
  return { id: id || null, label: id ? CAT_NAME(id) : "News", block: id ? (BLOCK_OF[id] === undefined ? CAT_NAME(id) : BLOCK_OF[id] || CAT_NAME(id)) : "Other" };
}

// ---------------------------------------------------------------- formatting
const hm = iso => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }).replace("AM", "a.m.").replace("PM", "p.m.");
const dayStr = (iso, opts) => new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, ...opts });
const end = s => s.endsWith(".") ? s : s + ".";
function periodLabel(long) {
  if (!S.id) return "";
  if (S.view === "day") return dayStr(S.id + "T16:00:00Z", long ? { weekday: "long", month: "long", day: "numeric", year: "numeric" } : { weekday: "short", month: "short", day: "numeric" });
  if (S.view === "week") {
    const [y, w] = S.id.split("-W").map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4)), mon = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5 + (w - 1) * 7 * 864e5);
    return "Week of " + mon.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  }
  if (S.view === "month") return new Date(S.id + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return "The year " + S.id;
}
function whyText(code) {
  if (!code) return "";
  const [k, ...rest] = code.split(":"), v = rest.join(":");
  return { t: `the outlet filed it under "${v}"`, p: `its web address contains /${v}/`, k: `the headline says "${v}"`, w: `the headline names ${v}`,
           f: "the outlet is based outside the U.S. and names no U.S. place", u: "a U.S. outlet that names no other country" }[k] || code;
}
const STOP = new Set(("a an and are as at be by for from has have he her his in is it its of on or says said say she that the their they this to was were will with " +
  "after amid over new into than but not more about who what why how us two one other last month week day today report reports live latest").split(" "));
const terms = t => [...new Set((t.toLowerCase().replace(/[’']s\b/g, "").match(/[a-z][a-z0-9-]+/g) || []).filter(w => !STOP.has(w) && w.length > 3))];
function regionsText(v, k = 4) {
  const c = {}; v.on.forEach(s => { const r = regionOf(OUT[s.o])[0]; c[r] = (c[r] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, k).map(([r, n]) => `${n} in ${r}`).join(", ");
}
function someSaid(v, k = 3) {
  const df = new Map();
  v.on.forEach(s => terms(s.t).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  return [...df.entries()].filter(([, n]) => n > 1 && n < v.on.length * 0.5).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k);
}
function picks(v, k) {  // other outlets' headlines, from different regions where possible, no reprints, not the lead
  const out = [], seen = new Set([regionOf(OUT[v.lead.o])[0]]);
  for (const pass of [0, 1]) for (const s of v.on) {
    if (out.length >= k) break;
    if (s === v.lead || s.rep || out.includes(s)) continue;
    const r = regionOf(OUT[s.o])[0];
    if (pass === 0 && seen.has(r)) continue;
    out.push(s); seen.add(r);
  }
  return out;
}

// ---------------------------------------------------------------- render
function render() {
  toHash();
  renderMast();
  renderFilters();
  if (panel) renderPanel();
  if (S.open) renderEvent(); else renderFront();
}

function renderMast() {
  $("#when").textContent = periodLabel(true);
  const list = periods(S.view), i = list.indexOf(S.id);
  $("#prev").disabled = i <= 0;
  $("#next").disabled = i < 0 || i >= list.length - 1;
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === S.view));
  let line = "";
  if (STATUS) {
    const live = META.outlets.filter(o => o.available !== false);
    const ok = live.filter(o => STATUS.outlets?.[o.id]?.ok !== false).length;
    line = (NEWER ? `<button type="button" class="fresh" data-refresh>New stories: load them (u)</button>` : countdown(new Date(STATUS.updated))) +
      `. ${ok} of ${live.length} feeds answered.`;
  }
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("#runline").innerHTML = line + `<button type="button" class="chip" data-theme-toggle>${dark ? "Light" : "Dark"}</button><button type="button" class="chip" data-guide>Keys</button>`;
  document.title = S.open ? "Coverage Index" : "Coverage Index: " + periodLabel();
}
const RUN_MIN = 15;
function nextRun(last) {  // the workflow runs every 15 minutes, at :07, :22, :37 and :52
  const n = new Date(last); n.setUTCMinutes(7, 0, 0);
  while (n <= last || n < Date.now() - 20 * 60000) n.setUTCMinutes(n.getUTCMinutes() + 15);
  return n;
}
function countdown(last) {  // a text bar that fills over the 15 minutes between updates
  const next = nextRun(last), now = Date.now(), left = Math.round((next - now) / 60000);
  if (now > next.getTime() + 20 * 60000) return `Update due at ${hm(next)} is late`;
  if (now >= next.getTime()) return "Updating now";
  const done = Math.max(0, Math.min(8, Math.round(8 * (1 - (next - now) / (RUN_MIN * 60000)))));
  return `<span class="bar" aria-hidden="true">${"■".repeat(done)}${"□".repeat(8 - done)}</span> Next update ${left <= 1 ? "in about a minute" : `in ${left} min`}`;
}
let NEWER = false;
async function checkForNewer() {  // new stories are only loaded when asked (u), so the page doesn't move while reading
  if (!STATUS || NEWER) return;
  try { const s = await (await fetch("data/status.json?t=" + Date.now(), { cache: "no-store" })).json(); if (s.updated && s.updated > STATUS.updated) { NEWER = true; renderMast(); } } catch (e) {}
}
async function refresh() {
  for (const k of [...cache.keys()]) if (k === "index.json" || k === "status.json" || k.startsWith("days/") || k.startsWith("roundups/")) cache.delete(k);
  INDEX = await getJSON("index.json"); STATUS = await getJSON("status.json"); NEWER = false;
  await loadPeriod(); render(); renderStatus();
}

function renderFilters() {
  $("#cats").innerHTML = `<button type="button" data-cat="" aria-pressed="${!S.cat}">All</button>` +
    CATS.map((c, i) => `<button type="button" data-cat="${c.id}" aria-pressed="${S.cat === c.id}">${i < 10 ? `<span class="key">${KEYS_CATS[i]}</span>` : ""}${esc(c.name)}</button>`).join("");
  const scope = META.outlets.filter(o => inScope(o) && o.available !== false), on = scope.filter(o => !S.off.has(o.id));
  const set = (id, text, isSet) => { const b = $(id); b.textContent = text; b.classList.toggle("set", isSet); b.setAttribute("aria-expanded", panel === b.dataset.panel); };
  set("#f-region", "Region: " + (S.region.length ? S.region[S.region.length - 1] : "all"), S.region.length > 0);
  set("#f-type", "Media: " + (S.type || "all"), !!S.type);
  set("#f-outlets", `Outlets: ${on.length === scope.length ? "all " + scope.length : on.length + " of " + scope.length}`, on.length !== scope.length);
  set("#f-rank", "Rank: " + { coverage: "most covered", picks: "outlets' own picks", newest: "newest" }[S.rank], S.rank !== "coverage");
  if (document.activeElement !== $("#q")) $("#q").value = S.q;
  const bits = [];
  if (S.cat) bits.push(`<b>${esc(CAT_NAME(S.cat))}</b>`);
  if (S.region.length) bits.push(`from outlets in <b>${esc(S.region.join(", "))}</b>`);
  if (S.type) bits.push(`<b>${esc(S.type)}</b> outlets only`);
  if (on.length !== scope.length) bits.push(`<b>${on.length} of ${scope.length}</b> outlets`);
  if (S.q) bits.push(`matching <b>&ldquo;${esc(S.q)}&rdquo;</b>`);
  $("#crumbs").innerHTML = bits.length ? `Showing ${bits.join(", ")}. <button type="button" data-clear-all>Show everything</button> or press Esc to remove one at a time.` : "";
}

// ---------------------------------------------------------------- the front page
function kicker(v, i) { return `<p class="kick"><span class="num">${i}</span><span class="sec">${esc(v.section.label)}</span></p>`; }
function lede(v) { return `${v.n} outlet${v.n > 1 ? "s" : ""} ran this, starting with ${esc(OUT[v.on[0].o].name)} at ${end(hm(v.on[0].at))}`; }
function emptyText() {
  if (!DATA.stories.length) return "<b>No stories saved for this period yet.</b>New stories arrive every 15 minutes.";
  if (!publishing().size) return "<b>None of the selected outlets published in this period.</b>Widen the region or media type, or switch more outlets on.";
  if (S.q) return `<b>No headlines match &ldquo;${esc(S.q)}&rdquo;.</b>Esc clears the search.`;
  return `<b>No ${S.cat ? esc(CAT_NAME(S.cat)) + " " : ""}stories with these filters.</b>Esc removes the narrowest filter.`;
}

function renderFront() {
  $("#event").hidden = true;
  const f = $("#front");
  f.hidden = false;
  ITEMS = [];
  const item = id => { ITEMS.push(id); return ITEMS.length - 1; };
  let h = "";
  if (S.rank === "picks" && S.view === "day") h = frontPicks(item);
  else if (S.rank === "newest") h = frontNewest(item);
  else h = frontCoverage(item);
  f.innerHTML = h || `<p class="empty">${emptyText()}</p>`;
  sel = Math.min(sel, Math.max(0, ITEMS.length - 1));
  markSel(false);
}

function frontCoverage(item) {
  const all = DATA.groups.map(view).filter(Boolean).sort((a, b) => b.n - a.n || b.last.localeCompare(a.last));
  const gs = all.filter(v => v.n > 1), singles = all.filter(v => v.n === 1);
  if (!all.length) return "";
  let h = "", i = 0;
  const L = gs[0] || singles[0];
  if (L) {
    const k = item(L.id), some = someSaid(L);
    h += `<section class="lead sel-able" data-k="${k}" data-g="${esc(L.id)}"><div class="story"><div>${kicker(L, ++i)}` +
      `<h2><a href="#" data-open="${esc(L.id)}">${esc(L.lead.t)}</a></h2>` +
      `<p class="dek">${lede(L)} Coverage came from ${regionsText(L)}.</p>` +
      (some.length ? `<p class="note">Only some headlines said ${some.map(([w, n]) => `&ldquo;${esc(w)}&rdquo; (${n})`).join(", ")}.</p>` : "") + `</div>` +
      (L.img ? `<figure><img src="${esc(L.img)}" alt="" referrerpolicy="no-referrer" onerror="this.closest('figure').remove()"><figcaption>Preview image from one of the outlets.</figcaption></figure>` : "<div></div>") +
      `</div><aside><h3>How others put it</h3><ol>${picks(L, 5).map(s => `<li><span class="sc">${esc(OUT[s.o].name)}</span>${esc(s.t)}</li>`).join("")}</ol>` +
      `<button type="button" class="all" data-open="${esc(L.id)}">All ${L.on.length} headlines, and who didn&rsquo;t run it &rarr;</button></aside></section>`;
  }
  const row3 = gs.slice(1, 4);
  if (row3.length) h += `<section class="row3">` + row3.map(v => {
    const k = item(v.id), some = someSaid(v);
    return `<article class="sel-able" data-k="${k}" data-g="${esc(v.id)}">${kicker(v, ++i)}<h2><a href="#" data-open="${esc(v.id)}">${esc(v.lead.t)}</a></h2>` +
      `<p>${lede(v)} Coverage: ${regionsText(v, 3)}.</p><ul class="takes">${picks(v, 2).map(s => `<li><span class="sc">${esc(OUT[s.o].name)}</span><i>${esc(s.t)}</i></li>`).join("")}</ul>` +
      (some.length ? `<p class="note">Only some said ${some.map(([w, n]) => `&ldquo;${esc(w)}&rdquo; (${n})`).join(", ")}.</p>` : "") + `</article>`;
  }).join("") + `</section>`;
  const row4 = gs.slice(4, 8);
  if (row4.length) h += `<section class="row4">` + row4.map(v => {
    const k = item(v.id), p = picks(v, 1)[0];
    return `<article class="sel-able" data-k="${k}" data-g="${esc(v.id)}">${kicker(v, ++i)}<h3><a href="#" data-open="${esc(v.id)}">${esc(v.lead.t)}</a></h3>` +
      `<p>${v.n} outlets, first ${esc(OUT[v.on[0].o].name)}.</p>` + (p ? `<p class="note"><span class="sc">${esc(OUT[p.o].name)}</span> <i>${esc(p.t)}</i></p>` : "") + `</article>`;
  }).join("") + `</section>`;
  const rest = gs.slice(8, 8 + limit);
  if (rest.length || singles.length) {
    const blocks = new Map();
    rest.forEach(v => { const b = v.section.block; if (!blocks.has(b)) blocks.set(b, []); blocks.get(b).push(v); });
    const order = BLOCK_ORDER.map(b => b === "conflict" ? CAT_NAME("conflict") : b);
    const names = [...blocks.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
    h += `<section class="also"><h2>Also covered ${S.view === "day" ? "today" : "in this period"}</h2><p class="sub">By section. The number is how many outlets ran each story.</p><div class="blocks">` +
      names.map(b => `<div class="block"><h3>${esc(b)}<span>${blocks.get(b).length}</span></h3><ol>` +
        blocks.get(b).map(v => `<li class="sel-able" data-k="${item(v.id)}" data-g="${esc(v.id)}" data-open="${esc(v.id)}"><span class="cnt">${v.n}</span><span>${esc(v.lead.t)}</span></li>`).join("") + `</ol></div>`).join("") +
      (showSingles && singles.length ? `<div class="block"><h3>Covered by one outlet<span>${singles.length}</span></h3><ol>` +
        singles.slice(0, 300).map(v => `<li class="sel-able" data-k="${item(v.id)}" data-g="${esc(v.id)}" data-open="${esc(v.id)}"><span class="cnt">1</span><span>${esc(v.lead.t)} <span class="dim">(${esc(OUT[v.lead.o].name)})</span></span></li>`).join("") + `</ol></div>` : "") +
      `</div>` +
      (gs.length > 8 + limit ? `<button type="button" class="more" data-more>Show more stories</button>` : "") +
      (singles.length && !showSingles ? `<button type="button" class="more" data-singles>Show the ${fmtInt(singles.length)} stories only one outlet ran</button>` : "") + `</section>`;
  }
  return h;
}

function frontPicks(item) {
  const by = new Map();
  for (const s of DATA.stories) { if (!isOn(OUT[s.o]) || !catOk(s) || !qOk(s)) continue; if (!by.has(s.o)) by.set(s.o, []); by.get(s.o).push(s); }
  if (!by.size) return "";
  const order = [...by.keys()].sort((a, b) => regionOf(OUT[a]).join("/").localeCompare(regionOf(OUT[b]).join("/")) || OUT[a].name.localeCompare(OUT[b].name));
  return `<div class="listing">` + order.map(o => {
    const g = OUT[o].via === "google";
    const ss = by.get(o).sort((a, b) => g ? b.at.localeCompare(a.at) : ((a.r || 99) - (b.r || 99)) || b.at.localeCompare(a.at)).slice(0, 3);
    return `<div class="outlet"><h3>${esc(OUT[o].name)}</h3><p class="nb">${esc(regionOf(OUT[o]).slice(1, 3).join(", "))}${g ? ". Collected through Google News, so these are its newest, not its own order" : ". Its top stories, in its own feed's order"}</p><ol>` +
      ss.map(s => `<li class="sel-able" data-k="${item(s.c || s.id)}" data-g="${esc(s.c || s.id)}" data-open="${esc(s.c || s.id)}">${esc(s.t)}</li>`).join("") + `</ol></div>`;
  }).join("") + `</div>`;
}

function frontNewest(item) {
  const gs = DATA.groups.map(view).filter(Boolean).sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit + 200);
  if (!gs.length) return "";
  return `<div class="listing">` + gs.map(v => `<div class="item sel-able" data-k="${item(v.id)}" data-g="${esc(v.id)}" data-open="${esc(v.id)}">` +
    `<time>${S.view === "day" ? hm(v.last) : dayStr(v.last, { month: "short", day: "numeric" })}</time><span><span class="sc">${esc(v.section.label)}, ${v.n} outlet${v.n > 1 ? "s" : ""}</span>${esc(v.lead.t)}</span></div>`).join("") + `</div>`;
}

function markSel(scroll = true) {
  document.querySelectorAll("#front .sel-able").forEach(el => el.classList.toggle("sel", +el.dataset.k === sel));
  const el = $(`#front .sel-able[data-k="${sel}"]`);
  if (el && scroll) el.scrollIntoView({ block: "nearest", behavior: "auto" });
}
function select(i) { if (!ITEMS.length) return; sel = Math.max(0, Math.min(ITEMS.length - 1, i)); markSel(); }

// ---------------------------------------------------------------- one story, opened
function renderEvent() {
  const g = DATA.groups.find(x => x.id === S.open), v = g && view(g);
  $("#front").hidden = true;
  const d = $("#event");
  d.hidden = false;
  if (!v) { d.innerHTML = `<div class="main"><button type="button" class="back" data-back>&larr; Back to the edition (Esc)</button><p class="empty"><b>This story isn&rsquo;t in the current view.</b>A filter may hide it, or it belongs to another day.</p></div>`; return; }
  const live = publishing(), covered = new Set(v.on.map(s => s.o));
  const missing = [...live].filter(o => !covered.has(o)).map(o => OUT[o]).sort((a, b) => a.name.localeCompare(b.name));
  const missRegions = {}; missing.forEach(o => { const r = regionOf(o)[0]; missRegions[r] = (missRegions[r] || 0) + 1; });
  const types = {}; v.on.forEach(s => (OUT[s.o].media || []).forEach(m => types[m] = (types[m] || 0) + 1));
  const df = new Map(); v.on.forEach(s => terms(s.t).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  const total = v.on.length;
  const shared = [...df.entries()].filter(([, n]) => n === total && total > 1).map(([w]) => w).slice(0, 6);
  const some = [...df.entries()].filter(([, n]) => n < total).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14);
  const i = ITEMS.indexOf(v.id), first = v.on[0], lastS = v.on[v.on.length - 1];
  const when = s => S.view === "day" ? hm(s.at) : dayStr(s.at, { month: "short", day: "numeric" }) + ", " + hm(s.at);
  const lab = o => [o.labels?.ownership === "government-controlled" ? "government-controlled" : null, (o.media || [])[0]].filter(Boolean).join(", ");
  d.innerHTML = `<div class="main">` +
    `<button type="button" class="back" data-back>&larr; Back to the edition (Esc)</button>` +
    (i >= 0 ? `<span class="steps">Story ${i + 1} of ${ITEMS.length}. j and k go to the next and previous.</span>` : "") +
    `<p class="kick" style="margin-top:18px"><span class="sec">${esc(v.section.label)}</span></p>` +
    `<h1>${esc(v.lead.t)}</h1>` +
    `<p class="dek">${v.n} of the ${live.size} outlets in this view that published ${S.view === "day" ? "that day" : "in this period"} ran this story` +
    `${!S.reps && v.on.some(s => s.rep) ? ", counting a word-for-word reprint as the outlet it repeats" : ""}. ${esc(OUT[first.o].name)} was first, at ${end(hm(first.at))}` +
    (v.on.length > 1 ? ` The latest was ${esc(OUT[lastS.o].name)}, at ${end(hm(lastS.at))}` : "") + `</p>` +
    `<p class="actions"><button type="button" data-save-event>Save this story (s)</button></p>` +
    (v.img ? `<figure><img src="${esc(v.img)}" alt="" referrerpolicy="no-referrer" onerror="this.closest('figure').remove()"><figcaption>Preview image from one of the outlets below.</figcaption></figure>` : "") +
    `<h2>How each outlet put it</h2><ul class="heads">` +
    v.on.map(s => {
      const o = OUT[s.o], hit = termOn && terms(s.t).includes(termOn);
      return `<li class="${hit ? "hit" : ""}"><time>${when(s)}</time><div><span class="who">${esc(o.name)}<span class="lab">${esc(lab(o))}</span></span>` +
        `<a href="${esc(s.u)}" target="_blank" rel="noopener">${esc(s.t)}</a>${s.rep ? `<span class="rep">Reprint of ${esc(OUT[s.rep]?.name || s.rep)}&rsquo;s story</span>` : ""}</div>` +
        `<button type="button" class="save-one" data-save-story="${esc(s.id)}" aria-label="Save ${esc(o.name)}'s headline">save</button></li>`;
    }).join("") + `</ul>` +
    (total > 1 ? `<h2>Where the wording differed</h2><p class="terms">${some.length ? "Words only some headlines used (select one to mark those headlines): " +
      some.map(([w, n]) => `<button type="button" data-term="${esc(w)}" aria-pressed="${termOn === w}">${esc(w)}</button> (${n} of ${total})`).join(", ") + "." : "The headlines use the same words."}` +
      (shared.length ? ` Every headline says ${shared.map(w => `&ldquo;${esc(w)}&rdquo;`).join(", ")}.` : "") + `</p>` : "") +
    `</div><aside class="notes">` +
    `<section><h3>Who ran it</h3>${regionsText(v, 6)}. Of them, ${types.Wire || 0} wire service${types.Wire === 1 ? "" : "s"}, ${types["Independent/reader-funded"] || 0} independent or reader-funded, ${types.Local || 0} local.</section>` +
    `<section><h3>Sections</h3>${v.cats.length ? v.cats.map(c => { const s = v.on.find(x => (x.cat || []).includes(c)); const w = s && s.why ? s.why[(s.cat || []).indexOf(c)] : ""; return `${esc(CAT_NAME(c))}${w ? `, because ${esc(whyText(w))}` : ""}`; }).join(". ") + "." : "No section rule matched."}</section>` +
    `<section><h3>Didn&rsquo;t run it</h3>${missing.length ? `${missing.length} outlets in this view published ${S.view === "day" ? "that day" : "in this period"} without this story, most of them in ${Object.entries(missRegions).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r).join(" and ")}.` +
      `<details><summary>See which</summary><ul>${missing.map(o => `<li>${esc(o.name)}</li>`).join("")}</ul></details>` : "Every outlet in this view that published ran it."}</section>` +
    `</aside>`;
}

// ---------------------------------------------------------------- filter panels
function renderPanel() {
  const p = $("#panel");
  p.hidden = false;
  let h = "";
  if (panel === "region") {
    const depth = S.region.length, kids = new Map();
    META.outlets.forEach(o => { const r = regionOf(o); if (S.region.every((x, i) => r[i] === x) && inType(o) && r[depth]) kids.set(r[depth], (kids.get(r[depth]) || 0) + 1); });
    const level = ["region", "country", "state or city", "city"][depth] || "place";
    h = `<h2>Region</h2><p class="hint">By where each outlet is based. Now: ${esc(["World", ...S.region].join(" › "))}. ${kids.size ? `Choose a ${level}.` : "No smaller places here."}</p><div class="opts">` +
      (depth ? `<button type="button" class="opt" data-up="${depth - 1}">&larr; Back to ${esc(depth > 1 ? S.region[depth - 2] : "the whole world")}</button>` : "") +
      [...kids.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `<button type="button" class="opt" data-region="${esc(k)}">${esc(k)}<span class="n">${n} outlet${n > 1 ? "s" : ""}</span></button>`).join("") + `</div>`;
  } else if (panel === "type") {
    const n = new Map(); META.outlets.filter(o => inRegion(o) && o.available !== false).forEach(o => (o.media || []).forEach(t => n.set(t, (n.get(t) || 0) + 1)));
    h = `<h2>Media type</h2><p class="hint">An outlet can be several types (the New York Times is National and Print). Each type follows a fixed rule from the outlet&rsquo;s labels.</p><div class="opts">` +
      `<button type="button" class="opt" data-type="" aria-pressed="${!S.type}">All media types</button>` +
      META.media_types.map(t => `<button type="button" class="opt" data-type="${esc(t.id)}" aria-pressed="${S.type === t.id}" title="${esc(t.rule)}">${esc(t.id)}<span class="n">${n.get(t.id) || 0}</span></button>`).join("") + `</div>`;
  } else if (panel === "outlets") {
    const scope = META.outlets.filter(inScope).sort((a, b) => regionOf(a).slice(0, 2).join("/").localeCompare(regionOf(b).slice(0, 2).join("/")) || a.name.localeCompare(b.name));
    const counts = new Map(); DATA.stories.forEach(s => counts.set(s.o, (counts.get(s.o) || 0) + 1));
    let last = "";
    h = `<h2>Outlets</h2><p class="hint">Select an outlet to switch it off or on. Your choice is remembered in this browser.</p><div class="opts">` +
      scope.map(o => {
        const grp = regionOf(o).slice(0, 2).join(", "), head = grp !== last ? `<p class="grp lbl">${esc(grp)}</p>` : "";
        last = grp;
        if (o.available === false) return head + `<button type="button" class="opt" disabled title="${esc(o.why_unavailable || "")}">${esc(o.name)}<span class="n">no working feed</span></button>`;
        const on = !S.off.has(o.id), failing = STATUS?.outlets?.[o.id]?.ok === false;
        return head + `<button type="button" class="opt${on ? "" : " off"}" data-outlet="${o.id}" aria-pressed="${on}">${esc(o.name)}<span class="n">${failing ? "feed failing" : on ? fmtInt(counts.get(o.id) || 0) : "off"}</span></button>`;
      }).join("") + `</div><div class="row-actions"><button type="button" data-all="on">Switch all on</button><button type="button" data-all="off">Switch all off</button></div>`;
  } else if (panel === "rank") {
    h = `<h2>Rank stories by</h2><div class="opts">` +
      [["coverage", "Most covered", "How many outlets ran each story"], ["picks", "Outlets' own picks", "Each outlet's top stories, in its own order (single days only)"], ["newest", "Newest", "The latest stories first"]]
        .map(([k, name, hint]) => `<button type="button" class="opt" data-rank="${k}" aria-pressed="${S.rank === k}"${k === "picks" && S.view !== "day" ? " disabled" : ""} title="${hint}">${name}</button>`).join("") +
      `</div><label class="check"><input type="checkbox" id="reps"${S.reps ? " checked" : ""}> Count reprints as their own outlet. When an outlet runs another outlet&rsquo;s story word for word (usually AP&rsquo;s), it normally counts as the original outlet.</label>`;
  }
  p.innerHTML = `<div class="panel-in">${h}</div>`;
  const r = $("#reps"); if (r) r.addEventListener("change", e => setFilter({ reps: e.target.checked }, true));
}
function openPanel(name) {
  panel = panel === name ? null : name;
  if (!panel) { $("#panel").hidden = true; renderFilters(); return; }
  renderFilters(); renderPanel();
  $("#panel button:not(:disabled)")?.focus();
}
function closePanel() { panel = null; $("#panel").hidden = true; renderFilters(); }

// ---------------------------------------------------------------- saving (storage and the folder dialog are in saved.js)
function saveOpen(storyId) {
  const id = S.open || ITEMS[sel];
  const g = id && DATA.groups.find(x => x.id === id), v = g && view(g);
  if (!v || !window.SAVED) return;
  const copy = s => ({ outlet: s.o, outletName: OUT[s.o]?.name || s.o, t: s.t, u: s.u, at: s.at, ...(s.rep ? { rep: OUT[s.rep]?.name || s.rep } : {}) });
  const link = "./#" + (S.view !== "day" ? "v=" + S.view + "&" : "") + "d=" + S.id + "&c=" + encodeURIComponent(v.id);
  if (storyId) { const s = v.on.find(x => x.id === storyId); if (s) SAVED.open({ kind: "story", key: "story:" + s.u, period: S.id, link, headline: s.t, stories: [copy(s)] }); return; }
  SAVED.open({ kind: "event", key: "event:" + S.view + ":" + S.id + ":" + v.id, period: S.id, link, headline: v.lead.t, covered: v.n, stories: v.on.map(copy) });
}

// ---------------------------------------------------------------- status line at the foot
function renderStatus() {
  if (!STATUS) return;
  const last = new Date(STATUS.updated);
  const failing = Object.entries(STATUS.outlets).filter(([id, s]) => s.ok === false && !s.unavailable && OUT[id]);
  const unavailable = META.outlets.filter(o => o.available === false);
  $("#status").innerHTML = `Last updated ${dayStr(last, { month: "short", day: "numeric" })}, ${hm(last)} Eastern${STATUS.run?.url ? ` (<a href="${esc(STATUS.run.url)}">update log</a>)` : ""}. ` +
    `Outlets&rsquo; own feeds are checked every 15 minutes; outlets collected through Google News, once an hour. ` +
    (failing.length ? `Not answering right now: ${failing.map(([id, s]) => `<span title="${esc(s.err || "")}">${esc(OUT[id].name)}</span>`).join(", ")}. ` : "") +
    (unavailable.length ? `No working feed: ${unavailable.map(o => `<span title="${esc(o.why_unavailable || "")}">${esc(o.name)}</span>`).join(", ")}.` : "");
}

// ---------------------------------------------------------------- actions
async function go(change) {
  Object.assign(S, change);
  if ("view" in change || "id" in change) { S.open = null; sel = 0; limit = 120; showSingles = false; await loadPeriod(); }
  render();
}
function setFilter(change, keepPanel) {
  Object.assign(S, change); S.open = null; sel = 0; limit = 120; termOn = null; showSingles = false; saveLocal();
  render();
  if (keepPanel && panel) $("#panel button:not(:disabled)")?.focus();
}
function step(dir) { const l = periods(S.view), i = l.indexOf(S.id) + dir; if (i >= 0 && i < l.length) go({ id: l[i] }); }
function openStory(id) {
  if (!id) return;
  const i = ITEMS.indexOf(id); if (i >= 0) sel = i;
  S.open = id; termOn = null; closePanelQuiet();
  render(); window.scrollTo(0, 0); $("#event").focus({ preventScroll: true });
}
function closeStory() { S.open = null; termOn = null; render(); markSel(); $("#main").focus({ preventScroll: true }); }
function closePanelQuiet() { if (panel) { panel = null; $("#panel").hidden = true; } }
function back() {
  if (panel) return closePanel();
  if (S.open) return closeStory();
  if (S.q) return setFilter({ q: "" });
  if (S.type) return setFilter({ type: null });
  if (S.region.length) return setFilter({ region: S.region.slice(0, -1) });
  if (S.cat) return setFilter({ cat: null });
}
function toggleTheme() {
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  r.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("ci-theme", r.dataset.theme); } catch (e) {}
  renderMast();
}

document.addEventListener("click", e => {
  const t = e.target.closest("button, a, [data-open]");
  if (!t) return;
  const ds = t.dataset;
  if (ds.open !== undefined && (t.matches("a, button, li, .item"))) { e.preventDefault(); return openStory(ds.open); }
  if (t.matches("a")) return;
  if (ds.panel) return openPanel(ds.panel);
  if (ds.view) return go({ view: ds.view, id: null });
  if (ds.rank) { setFilter({ rank: ds.rank }, true); return renderPanel(); }
  if (ds.cat !== undefined) return setFilter({ cat: !ds.cat || S.cat === ds.cat ? null : ds.cat });
  if (ds.up !== undefined) return setFilter({ region: S.region.slice(0, +ds.up) }, true);
  if (ds.region !== undefined) return setFilter({ region: [...S.region, ds.region] }, true);
  if (ds.type !== undefined) { setFilter({ type: ds.type || null }); return closePanel(); }
  if (ds.outlet) { const off = new Set(S.off); off.has(ds.outlet) ? off.delete(ds.outlet) : off.add(ds.outlet); setFilter({ off }); renderPanel(); return $(`#panel [data-outlet="${ds.outlet}"]`)?.focus(); }
  if (ds.all) { const off = new Set(S.off); META.outlets.filter(inScope).forEach(o => ds.all === "on" ? off.delete(o.id) : off.add(o.id)); setFilter({ off }); return renderPanel(); }
  if (ds.clearAll !== undefined) return setFilter({ cat: null, region: [], type: null, q: "", off: new Set() });
  if (ds.term !== undefined) { termOn = termOn === ds.term ? null : ds.term; return renderEvent(); }
  if (ds.saveEvent !== undefined) return saveOpen();
  if (ds.saveStory) return saveOpen(ds.saveStory);
  if (ds.refresh !== undefined) return refresh();
  if (ds.themeToggle !== undefined) return toggleTheme();
  if (ds.guide !== undefined) return $("#help").showModal();
  if (ds.back !== undefined) return closeStory();
  if (ds.more !== undefined) { limit += 200; return renderFront(); }
  if (ds.singles !== undefined) { showSingles = true; return renderFront(); }
  if (t.id === "prev") return step(-1);
  if (t.id === "next") return step(1);
});
// selecting a story with the mouse (hover doesn't move the keyboard selection; a click opens it)
$("#q").addEventListener("input", e => { S.q = e.target.value.trim(); S.open = null; sel = 0; render(); });
$("#home").addEventListener("click", e => { e.preventDefault(); closePanelQuiet(); S.cat = null; S.region = []; S.type = null; S.q = ""; go({ view: "day", id: null }); });

document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches("input[type=search], input[type=text]")) {
    if (e.key === "Escape") { e.target.value = ""; S.q = ""; e.target.blur(); render(); }
    if (e.key === "Enter" || e.key === "ArrowDown") { e.target.blur(); $("#main").focus({ preventScroll: true }); }
    return;
  }
  if (document.querySelector("dialog[open]")) return;  // the key guide and the save dialog handle their own keys
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); return back(); }
  if (panel && e.target.closest("#panel") && ["j", "k", "ArrowDown", "ArrowUp"].includes(k)) {  // move within an open panel
    const bs = [...document.querySelectorAll("#panel button:not(:disabled), #panel input")];
    const i = bs.indexOf(e.target);
    e.preventDefault();
    return bs[Math.max(0, Math.min(bs.length - 1, i + (k === "j" || k === "ArrowDown" ? 1 : -1)))]?.focus();
  }
  if (k === "j" || k === "ArrowDown" || k === "k" || k === "ArrowUp") {
    const d = k === "j" || k === "ArrowDown" ? 1 : -1;
    e.preventDefault();
    if (S.open) { const i = ITEMS.indexOf(S.open); if (i >= 0 && ITEMS[i + d]) openStory(ITEMS[i + d]); return; }
    return select(sel + d);
  }
  if (k === "Enter" && !e.target.matches("button, a, summary, input, select")) { e.preventDefault(); if (!S.open) openStory(ITEMS[sel]); return; }
  if (k === "/") { e.preventDefault(); return $("#q").focus(); }
  if (k === "?") { e.preventDefault(); return $("#help").showModal(); }
  if (k === "[") return step(-1);
  if (k === "]") return step(1);
  if (k === "d") { location.href = "digest.html"; return; }
  if (k === "s") { e.preventDefault(); return saveOpen(); }
  if (k === "u" && NEWER) { e.preventDefault(); return refresh(); }
  if (k === "r") { const order = S.view === "day" ? ["coverage", "picks", "newest"] : ["coverage", "newest"]; return setFilter({ rank: order[(order.indexOf(S.rank) + 1) % order.length] }); }
  if (k === "g") { e.preventDefault(); return openPanel("region"); }
  if (k === "t") { e.preventDefault(); return openPanel("type"); }
  if (k === "o") { e.preventDefault(); return openPanel("outlets"); }
  const n = KEYS_CATS.indexOf(k);
  if (n >= 0 && CATS[n]) return setFilter({ cat: S.cat === CATS[n].id ? null : CATS[n].id });
});
window.addEventListener("hashchange", async () => { const before = S.view + S.id; fromHash(); if (S.view + S.id !== before) await loadPeriod(); render(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => STATUS && renderMast());
setInterval(() => STATUS && renderMast(), 30000);  // keep the countdown current
setInterval(checkForNewer, 60000);

// ---------------------------------------------------------------- start
(async function start() {
  try {
    [META, INDEX] = await Promise.all([getJSON("meta.json"), getJSON("index.json")]);
    META.outlets.forEach(o => OUT[o.id] = o);
    CATS = META.categories;
    loadLocal();
    fromHash();
    await loadPeriod();
    if (S.open) { renderMast(); renderFilters(); renderFront(); }  // build the reading order first, so j/k work in an opened story
    render();
    getJSON("status.json").then(s => { STATUS = s; renderMast(); renderStatus(); }).catch(() => {});
  } catch (err) {
    $("#front").innerHTML = `<p class="empty"><b>The news couldn&rsquo;t be loaded.</b>${esc(err.message)}. Try reloading the page.</p>`;
  }
})();
