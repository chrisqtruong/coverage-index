// Coverage Index: reader. Plain JavaScript, no build step. Reads the JSON the collector (every 15 minutes) writes to data/.
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = n => n.toLocaleString("en-US");
const TZ = "America/New_York";
const wide = () => matchMedia("(min-width: 821px)").matches;

// ---------------------------------------------------------------- state (mirrored in the URL)
const S = {
  view: "day",        // day | week | month | year
  id: null,           // 2026-10-14 | 2026-W42 | 2026-10 | 2026
  rank: "coverage",   // coverage | picks | newest
  cat: null,          // category id, or null for all
  region: [],         // place path: [] = World, ["Europe"], ["Europe", "United Kingdom"], ...
  type: null,         // media type, or null for all
  off: new Set(),     // outlets excluded
  reps: false,        // count reprints as their own outlet
  q: "",
  open: null,         // id of the selected event
};
let META, INDEX, STATUS, OUT = {}, CATS = [], DATA = null, sel = 0, limit = 80, termOn = null, ROWS = [];
const cache = new Map();
const KEYS_CATS = "1234567890"; // number keys select the first ten categories

// ---------------------------------------------------------------- URL
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
function saveLocal() {
  try { localStorage.setItem("spread-off", [...S.off].join(",")); localStorage.setItem("spread-reps", S.reps ? "1" : ""); } catch (e) {}
}
function loadLocal() {
  try {
    const off = localStorage.getItem("spread-off");
    if (off) S.off = new Set(off.split(",").filter(Boolean));
    S.reps = localStorage.getItem("spread-reps") === "1";
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
function periods(view) { return view === "day" ? INDEX.days : INDEX.roundups[view] || []; }
function latest(view) { if (!INDEX) return null; const l = periods(view); return l[l.length - 1] || null; }

async function loadPeriod() {
  S.id = S.id && periods(S.view).includes(S.id) ? S.id : latest(S.view);
  if (!S.id) { DATA = { groups: [], stories: [] }; return; }
  if (S.view === "day") {
    const d = await getJSON("days/" + S.id + ".json");
    const by = new Map();
    for (const s of d.stories) {
      const k = s.c || s.id;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(s);
    }
    DATA = { stories: d.stories, groups: [...by.entries()].map(([id, ss]) => ({ id, s: ss })) };
  } else {
    const r = await getJSON("roundups/" + S.view + "/" + S.id + ".json");
    DATA = { stories: r.groups.flatMap(g => g.s.map(s => ({ ...s, cat: g.cat, c: g.id }))),
             groups: r.groups.map(g => ({ id: g.id, s: g.s.map(s => ({ ...s, cat: g.cat })) })) };
  }
}

// ---------------------------------------------------------------- filters
const regionOf = o => o.place || [];
const inRegion = o => { const r = regionOf(o); return S.region.every((p, i) => r[i] === p); };
const inType = o => !S.type || (o.media || []).includes(S.type);
const inScope = o => o && inRegion(o) && inType(o);
const isOn = o => inScope(o) && o.available !== false && !S.off.has(o.id);
const catOk = s => !S.cat || (s.cat || []).includes(S.cat);
const qOk = s => { if (!S.q) return true; const q = S.q.toLowerCase(); return s.t.toLowerCase().includes(q) || (OUT[s.o]?.name || "").toLowerCase().includes(q); };
const WIRE = o => (o?.media || []).includes("Wire");
const CAT_NAME = id => (CATS.find(c => c.id === id) || {}).name || id;

// An event as currently filtered: only stories from included outlets, each outlet counted once, and a reprint
// counted as the outlet it repeats unless "count reprints" is on.
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
  return { id: g.id, on: sorted, n: keys.size, lead, first: sorted[0].at, last: sorted[sorted.length - 1].at,
           img: (on.find(s => s.img) || {}).img,
           cats: Object.entries(cats).filter(([, k]) => k * 3 >= on.length).sort((a, b) => b[1] - a[1]).map(([c]) => c) };
}
const publishing = () => new Set(DATA.stories.filter(s => isOn(OUT[s.o])).map(s => s.o));

function rows() {
  if (S.rank === "picks" && S.view === "day") {
    const by = new Map();
    for (const s of DATA.stories) {
      if (!isOn(OUT[s.o]) || !catOk(s) || !qOk(s)) continue;
      if (!by.has(s.o)) by.set(s.o, []);
      by.get(s.o).push(s);
    }
    const out = [];
    const order = [...by.keys()].sort((a, b) => regionOf(OUT[a]).join("/").localeCompare(regionOf(OUT[b]).join("/")) || OUT[a].name.localeCompare(OUT[b].name));
    for (const o of order) {
      const g = OUT[o].via === "google";
      const ss = by.get(o).sort((a, b) => g ? b.at.localeCompare(a.at) : (a.r - b.r) || b.at.localeCompare(a.at)).slice(0, 3);
      out.push({ head: OUT[o].name + (g ? " (Google News: newest; no outlet order available)" : "") });
      ss.forEach((s, i) => out.push({ kind: "story", s, n: i + 1, g: s.c || s.id }));
    }
    return out;
  }
  const gs = DATA.groups.map(view).filter(Boolean);
  if (S.rank === "newest") return gs.sort((a, b) => b.last.localeCompare(a.last)).map(v => ({ kind: "group", v }));
  gs.sort((a, b) => b.n - a.n || b.last.localeCompare(a.last));
  const out = gs.filter(v => v.n > 1).map(v => ({ kind: "group", v }));
  const single = gs.filter(v => v.n === 1);
  if (single.length) {
    out.push({ head: fmtInt(single.length) + " events covered by one outlet" });
    single.forEach(v => out.push({ kind: "group", v }));
  }
  return out;
}

// ---------------------------------------------------------------- formatting
const hm = (iso, opts = {}) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ, ...opts });
const dayLabel = (iso, opts) => new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, ...opts });
function periodLabel() {
  if (!S.id) return "";
  if (S.view === "day") return S.id === latest("day") ? "Today" : dayLabel(S.id + "T16:00:00Z", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  if (S.view === "week") return "Week " + S.id.split("-W")[1] + ", " + S.id.slice(0, 4);
  if (S.view === "month") return new Date(S.id + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  return S.id;
}
function whyText(code) {
  if (!code) return "";
  const [k, ...rest] = code.split(":"), v = rest.join(":");
  return { t: `outlet section "${v}"`, p: `web address /${v}/`, k: `headline keyword "${v}"`, w: `headline names ${v}`, f: "outlet based outside the U.S., no U.S. place named", u: "U.S. outlet, no other country named" }[k] || code;
}
const typeOf = o => (o.media || [])[0] || (o.labels || {}).format || "";

// ---------------------------------------------------------------- render
function render() {
  toHash();
  renderMast();
  renderSide();
  renderList();
  renderDetail();
}

function renderMast() {
  // run line: now, last run, next run, feeds answering
  const now = new Date();
  const parts = [dayLabel(now, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", ""), hm(now) + " ET"];
  if (STATUS) {
    const last = new Date(STATUS.updated), next = nextRun(last);
    const live = META.outlets.filter(o => o.available !== false);
    const ok = live.filter(o => STATUS.outlets?.[o.id]?.ok !== false).length;
    parts.push("last run " + hm(last), "next " + hm(next) + (Date.now() - next > 20 * 60000 ? " (overdue)" : ""), `${ok}/${live.length} feeds ok`);
  }
  $("#runline").textContent = parts.join(" · ");

  // breadcrumb: Category > Region path > Media type > Outlet
  const scope = META.outlets.filter(o => inScope(o) && o.available !== false);
  const on = scope.filter(o => !S.off.has(o.id));
  const crumbs = [`<button type="button" data-crumb="cat">${esc(S.cat ? CAT_NAME(S.cat) : "All")}</button>`,
    `<button type="button" data-up="0">World</button>`,
    ...S.region.map((r, i) => `<button type="button" data-up="${i + 1}">${esc(r)}</button>`)];
  if (S.type) crumbs.push(`<button type="button" data-crumb="type">${esc(S.type)}</button>`);
  if (on.length !== scope.length) crumbs.push(`<button type="button" data-crumb="outlets">${on.length === 1 ? esc(on[0].name) : `${on.length} of ${scope.length} outlets`}</button>`);
  $("#crumbs").innerHTML = crumbs.join(`<span class="sep" aria-hidden="true">›</span>`);

  $("#cats").innerHTML = CATS.map((c, i) => `<button type="button" data-cat="${c.id}" aria-pressed="${S.cat === c.id}">` +
    `${i < 10 ? "[" + KEYS_CATS[i] + "] " : ""}${esc(c.name)}</button>`).join("");
  document.title = "Coverage Index: " + periodLabel();
}
function nextRun(last) {  // the workflow runs every 15 minutes, at :07, :22, :37 and :52
  const n = new Date(last); n.setUTCMinutes(7, 0, 0);
  while (n <= last || n < Date.now() - 20 * 60000) n.setUTCMinutes(n.getUTCMinutes() + 15);
  return n;
}

function renderSide() {
  // region tree: World, the regions, and the children of each place along the selected path
  const kids = depth => {
    const m = new Map();
    META.outlets.forEach(o => { const r = regionOf(o); if (S.region.slice(0, depth).every((x, i) => r[i] === x) && r[depth]) m.set(r[depth], (m.get(r[depth]) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const btn = (name, depth, path) => {
    const on = path.length <= S.region.length && path.every((x, i) => S.region[i] === x);
    const here = path.length === S.region.length && on;
    return `<li><button type="button" class="d${Math.min(depth, 3)}${on ? " on" : ""}${here ? " here" : ""}" data-region="${esc(path.join("/"))}">${esc(name)}</button></li>`;
  };
  const tree = [btn("World", 0, [])];
  (function walk(depth) {
    for (const [name] of kids(depth)) {
      const path = [...S.region.slice(0, depth), name];
      tree.push(btn(name, depth + 1, path));
      if (S.region[depth] === name && depth + 1 <= S.region.length) walk(depth + 1);
    }
  })(0);
  $("#regions").innerHTML = tree.join("");

  const n = new Map();
  META.outlets.filter(o => inRegion(o) && o.available !== false).forEach(o => (o.media || []).forEach(t => n.set(t, (n.get(t) || 0) + 1)));
  $("#types").innerHTML = META.media_types.map(t => `<li><button type="button" data-type="${esc(t.id)}" aria-pressed="${S.type === t.id}" title="Rule: ${esc(t.rule)}">` +
    `<span>${esc(t.id)}</span><span class="n">${n.get(t.id) || 0}</span></button></li>`).join("");

  const scope = META.outlets.filter(inScope).sort((a, b) => regionOf(a).slice(0, 2).join("/").localeCompare(regionOf(b).slice(0, 2).join("/")) || a.name.localeCompare(b.name));
  const live = scope.filter(o => o.available !== false), onN = live.filter(o => !S.off.has(o.id)).length;
  $("#outlets-sum").textContent = `Outlets ${onN} of ${live.length}`;
  const counts = new Map(); DATA.stories.forEach(s => counts.set(s.o, (counts.get(s.o) || 0) + 1));
  let last = "";
  $("#outlets").innerHTML = scope.map(o => {
    const grp = regionOf(o).slice(1, 2).join("") || regionOf(o)[0] || "";
    const head = grp !== last ? `<li class="grp">${esc(grp)}</li>` : "";
    last = grp;
    if (o.available === false) return head + `<li><button type="button" disabled title="${esc(o.why_unavailable || "")}"><span>${esc(o.name)}</span><span class="n">unavailable</span></button></li>`;
    const failing = STATUS?.outlets?.[o.id]?.ok === false;
    return head + `<li><button type="button" data-outlet="${o.id}" aria-pressed="${!S.off.has(o.id)}"><span>${esc(o.name)}</span>` +
      `<span class="n">${failing ? "feed failing" : fmtInt(counts.get(o.id) || 0)}</span></button></li>`;
  }).join("");

  document.querySelectorAll("[data-rank]").forEach(b => { b.setAttribute("aria-pressed", b.dataset.rank === S.rank); b.disabled = b.dataset.rank === "picks" && S.view !== "day"; });
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === S.view));
  $("#reps").checked = S.reps;
}

function renderList() {
  ROWS = rows();
  const live = publishing();
  const groups = ROWS.filter(r => r.kind === "group").length;
  const picks = S.rank === "picks" && S.view === "day";
  $("#count").textContent = `${periodLabel()} · ${picks ? fmtInt(ROWS.filter(r => r.head).length) + " outlets" : fmtInt(groups) + " events"} in this view`;
  const list = periods(S.view), i = list.indexOf(S.id);
  $("#prev").disabled = i <= 0;
  $("#next").disabled = i < 0 || i >= list.length - 1;
  if (document.activeElement !== $("#q")) $("#q").value = S.q;

  const el = $("#list");
  if (!ROWS.length) { el.innerHTML = `<li class="note mono">${emptyText(live)}</li>`; $("#more").hidden = true; return; }
  // keep the selected event selected across re-renders
  const ids = ROWS.filter(r => !r.head).map(r => r.kind === "group" ? r.v.id : r.g);
  if (S.open && ids.indexOf(S.open) >= 0) sel = ids.indexOf(S.open);
  sel = Math.min(sel, ids.length - 1);
  if (sel >= limit) limit = sel + 20;
  let k = -1;
  el.innerHTML = ROWS.slice(0, limit).map(r => {
    if (r.head) return `<li class="head"><h3 class="lbl">${esc(r.head)}</h3></li>`;
    k++;
    if (r.kind === "story") {
      const s = r.s;
      return `<li class="row" data-k="${k}" data-g="${esc(r.g)}"><p class="t">${esc(s.t)}</p>` +
        `<p class="m">#${r.n} in ${esc(OUT[s.o].name)}'s feed · ${hm(s.at)}${(s.cat || []).length ? " · " + s.cat.map(CAT_NAME).join(", ") : ""}</p></li>`;
    }
    const v = r.v;
    const when = S.view === "day" ? hm(v.first) : dayLabel(v.first, { day: "numeric", month: "short" });
    const cats = v.cats.length === 1 ? CAT_NAME(v.cats[0]) : v.cats.length ? `${v.cats.length} categories` : "no category";
    return `<li class="row" data-k="${k}" data-g="${esc(v.id)}"><p class="t">${esc(v.lead.t)}</p>` +
      `<p class="m">covered by ${v.n} of ${live.size} · <span title="${esc(v.cats.map(CAT_NAME).join(", "))}">${esc(cats)}</span> · ${when}</p></li>`;
  }).join("");
  $("#more").hidden = ROWS.length <= limit;
  S.open = ids[sel] || null;
  markSel(false);
}
function emptyText(live) {
  if (!DATA.stories.length) return "<b>No stories recorded for this period.</b>Collection runs every 15 minutes.";
  if (!live.size) return "<b>No included outlet published in this period.</b>Widen the region or media type, or include more outlets.";
  if (S.q) return `<b>No headlines match "${esc(S.q)}".</b>Esc clears the search.`;
  return `<b>No ${S.cat ? esc(CAT_NAME(S.cat)) + " " : ""}events in this view.</b>Esc removes the narrowest filter.`;
}
const selectable = () => [...$("#list").querySelectorAll("li.row")];
function markSel(scroll = true) {
  const rs = selectable();
  rs.forEach((r, i) => r.classList.toggle("sel", i === sel));
  if (rs[sel]) { S.open = rs[sel].dataset.g; if (scroll) rs[sel].scrollIntoView({ block: "nearest" }); }
}

// ---------------------------------------------------------------- the selected event
const STOP = new Set("a an and are as at be by for from has have he her his in is it its of on or says said say she that the their they this to was were will with after amid over new into than but not more about who what why how".split(" "));
const terms = t => [...new Set((t.toLowerCase().replace(/[’']s\b/g, "").match(/[a-z0-9][a-z0-9-]+/g) || []).filter(w => !STOP.has(w) && w.length > 2))];

function renderDetail() {
  const d = $("#detail");
  const g = S.open && DATA.groups.find(x => x.id === S.open);
  const v = g && view(g);
  if (!v) { d.innerHTML = S.open && !wide() ? `<button type="button" class="back mono" data-back>‹ events (Esc)</button><p class="empty">This event is not in the current view.</p>` : ""; return; }
  const live = publishing();
  const covered = new Set(v.on.map(s => s.o));
  const missing = [...live].filter(o => !covered.has(o)).map(o => OUT[o]).sort((a, b) => a.name.localeCompare(b.name));
  const missTypes = [...new Set(missing.flatMap(o => o.media || []))].slice(0, 4);
  const total = v.on.length;
  const per = v.on.map(s => terms(s.t)), df = new Map();
  per.forEach(ws => ws.forEach(w => df.set(w, (df.get(w) || 0) + 1)));
  const shared = [...df.entries()].filter(([, k]) => k === total && total > 1).map(([w]) => w).slice(0, 6);
  const some = [...df.entries()].filter(([, k]) => k < total).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14);
  const lead = v.lead;
  const catWhy = (lead.cat || []).map((c, i) => `${CAT_NAME(c)} (${whyText((lead.why || [])[i])})`);
  d.innerHTML =
    `<button type="button" class="back mono" data-back>‹ events (Esc)</button>` +
    `<p class="lbl">Event · coverage</p>` +
    `<h2 class="t">${esc(lead.t)}</h2>` +
    `<p class="save-line mono"><button type="button" data-save-event>save event (s)</button></p>` +
    `<p class="cov mono"><b>Covering ${v.n} of ${live.size}</b> outlets in this view${!S.reps && v.on.some(s => s.rep) ? "; reprints counted as the outlet they repeat" : ""}</p>` +
    (missing.length ? `<details class="miss mono"><summary>Not covering: ${esc(missTypes.join(", "))}${missTypes.length < new Set(missing.flatMap(o => o.media || [])).size ? ", ..." : ""} (${missing.length})</summary>` +
      `<ul>${missing.map(o => `<li>${esc(o.name)}</li>`).join("")}</ul></details>` : `<p class="miss mono">Not covering: none</p>`) +
    (v.img ? `<img src="${esc(v.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "") +
    `<h3 class="lbl sec">How they headline it</h3><ul class="heads">` +
    v.on.map(s => {
      const o = OUT[s.o];
      const hit = termOn && terms(s.t).includes(termOn);
      return `<li class="${hit ? "hit" : ""}"><p class="who">${esc(o.name)} · ${esc(typeOf(o))} · ${S.view === "day" ? hm(s.at) : dayLabel(s.at, { day: "numeric", month: "short" }) + " " + hm(s.at)}</p>` +
        `<a href="${esc(s.u)}" target="_blank" rel="noopener">${esc(s.t)}</a>` +
        (s.rep ? `<span class="rep">reprint of ${esc(OUT[s.rep]?.name || s.rep)}</span>` : "") +
        `<button type="button" class="save-one mono" data-save-story="${esc(s.id)}" aria-label="save ${esc(o.name)}'s headline">save</button></li>`;
    }).join("") + `</ul>` +
    (total > 1 ? `<p class="terms mono">Terms in some headlines only: ` +
      (some.length ? some.map(([w, k]) => `<button type="button" data-term="${esc(w)}" aria-pressed="${termOn === w}">"${esc(w)}" (${k})</button>`).join(" · ") : "none") +
      (shared.length ? `. In all: ${shared.map(w => `"${esc(w)}"`).join(", ")}` : "") + `.</p>` : "") +
    (catWhy.length ? `<p class="terms mono">Categories: ${esc(catWhy.join("; "))}.</p>` : "");
}

// ---------------------------------------------------------------- saving (storage and the folder dialog are in saved.js)
// A saved item is a copy of the headlines, outlets, times and links, so it outlives the archive and the outlet's page.
function saveOpen(storyId) {
  const g = S.open && DATA.groups.find(x => x.id === S.open);
  const v = g && view(g);
  if (!v || !window.SAVED) return;
  const copy = s => ({ outlet: s.o, outletName: OUT[s.o]?.name || s.o, t: s.t, u: s.u, at: s.at, ...(s.rep ? { rep: OUT[s.rep]?.name || s.rep } : {}) });
  const link = "./#" + (S.view !== "day" ? "v=" + S.view + "&" : "") + "d=" + S.id + "&c=" + encodeURIComponent(v.id);
  if (storyId) {
    const s = v.on.find(x => x.id === storyId);
    if (s) SAVED.open({ kind: "story", key: "story:" + s.u, period: S.id, link, headline: s.t, stories: [copy(s)] });
    return;
  }
  SAVED.open({ kind: "event", key: "event:" + S.view + ":" + S.id + ":" + v.id, period: S.id, link, headline: v.lead.t,
               covered: v.n, stories: v.on.map(copy) });
}

// ---------------------------------------------------------------- status line
function renderStatus() {
  if (!STATUS) return;
  const last = new Date(STATUS.updated), next = nextRun(last);
  const failing = Object.entries(STATUS.outlets).filter(([id, s]) => s.ok === false && !s.unavailable && OUT[id]);
  const unavailable = META.outlets.filter(o => o.available === false);
  $("#status").innerHTML = `Last run ${hm(last)} ET${STATUS.run?.url ? ` (<a href="${esc(STATUS.run.url)}">log</a>)` : ""}. ` +
    `Next scheduled ${hm(next)} ET. Outlets' own feeds are checked every 15 minutes; outlets collected through Google News, once an hour. ` +
    (failing.length ? `Feeds failing: ${failing.map(([id, s]) => `<span title="${esc(s.err || "")}">${esc(OUT[id].name)}</span>`).join(", ")}. ` : "All available feeds responded. ") +
    (unavailable.length ? `Unavailable: ${unavailable.map(o => `<span title="${esc(o.why_unavailable || "")}">${esc(o.name)}</span>`).join(", ")}.` : "");
}

// ---------------------------------------------------------------- actions
async function go(change) {
  Object.assign(S, change);
  if ("view" in change || "id" in change) { S.open = null; sel = 0; limit = 80; await loadPeriod(); }
  render();
}
function setFilter(change) { Object.assign(S, change); S.open = null; sel = 0; limit = 80; termOn = null; saveLocal(); render(); }
function step(dir) { const l = periods(S.view), i = l.indexOf(S.id) + dir; if (i >= 0 && i < l.length) go({ id: l[i] }); }
function reading(on) { document.body.classList.toggle("reading", on && !wide()); if (on && !wide()) { window.scrollTo(0, 0); $("#detail").focus({ preventScroll: true }); } }
function back() {
  if ($("#help").open) return;
  if (document.body.classList.contains("reading")) { reading(false); markSel(); return; }
  if (S.q) return setFilter({ q: "" });
  if (S.type) return setFilter({ type: null });
  if (S.region.length) return setFilter({ region: S.region.slice(0, -1) });
  if (S.cat) return setFilter({ cat: null });
}
function select(i, scroll = true) {
  const n = selectable().length;
  if (!n) return;
  sel = Math.max(0, Math.min(n - 1, i));
  termOn = null;
  markSel(scroll);
  toHash();
  renderDetail();
}

document.addEventListener("click", e => {
  const t = e.target.closest("button, li.row, a");
  if (!t || t.matches("a")) return;
  const ds = t.dataset;
  if (t.matches("li.row")) { select(+ds.k, false); return reading(true); }
  if (t.id === "side-toggle") { const open = !$("#side").classList.contains("open"); $("#side").classList.toggle("open", open); t.setAttribute("aria-expanded", open); return; }
  if (ds.view) return go({ view: ds.view, id: null });
  if (ds.rank) return setFilter({ rank: ds.rank });
  if (ds.crumb === "cat") return setFilter({ cat: null });
  if (ds.crumb === "type") return setFilter({ type: null });
  if (ds.crumb === "outlets") { $("#outlets-box").open = true; $("#side").classList.add("open"); return $("#outlets button:not(:disabled)")?.focus(); }
  if (ds.up !== undefined) return setFilter({ region: S.region.slice(0, +ds.up) });
  if (ds.cat !== undefined) return setFilter({ cat: S.cat === ds.cat ? null : ds.cat });
  if (ds.region !== undefined) { setFilter({ region: ds.region ? ds.region.split("/") : [] }); return $(`#regions [data-region="${CSS.escape(ds.region)}"]`)?.focus(); }
  if (ds.type !== undefined) { setFilter({ type: S.type === ds.type ? null : ds.type }); return $(`#types [data-type="${CSS.escape(ds.type)}"]`)?.focus(); }
  if (ds.outlet) { const off = new Set(S.off); off.has(ds.outlet) ? off.delete(ds.outlet) : off.add(ds.outlet); setFilter({ off }); return $(`#outlets [data-outlet="${ds.outlet}"]`)?.focus(); }
  if (ds.all) { const off = new Set(S.off); META.outlets.filter(inScope).forEach(o => ds.all === "on" ? off.delete(o.id) : off.add(o.id)); return setFilter({ off }); }
  if (ds.term !== undefined) { termOn = termOn === ds.term ? null : ds.term; return renderDetail(); }
  if (ds.saveEvent !== undefined) return saveOpen();
  if (ds.saveStory) return saveOpen(ds.saveStory);
  if (ds.back !== undefined) return back();
  if (t.id === "prev") return step(-1);
  if (t.id === "next") return step(1);
  if (t.id === "more") { limit += 100; return renderList(); }
});
$("#reps").addEventListener("change", e => setFilter({ reps: e.target.checked }));
$("#q").addEventListener("input", e => { S.q = e.target.value.trim(); S.open = null; sel = 0; render(); });
$("#home").addEventListener("click", e => { e.preventDefault(); S.cat = null; S.region = []; S.type = null; S.q = ""; reading(false); go({ view: "day", id: null }); });

document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches("input[type=search]")) {
    if (e.key === "Escape") { e.target.value = ""; S.q = ""; e.target.blur(); render(); }
    if (e.key === "Enter" || e.key === "ArrowDown") { e.target.blur(); $("#list").focus(); }
    return;
  }
  if (document.querySelector("dialog[open]")) return;  // a dialog (keys, save) handles its own keys
  if (e.key === "Escape") { e.preventDefault(); return back(); }
  if ($("#help").open) return;
  const k = e.key;
  // in the sidebar, j/k and the arrows move between its controls
  if (e.target.closest("#side") && ["j", "k", "ArrowDown", "ArrowUp"].includes(k)) {
    const bs = [...document.querySelectorAll("#side button:not(:disabled), #side summary")].filter(b => b.offsetParent);
    const i = bs.indexOf(e.target);
    e.preventDefault();
    return bs[Math.max(0, Math.min(bs.length - 1, i + (k === "j" || k === "ArrowDown" ? 1 : -1)))]?.focus();
  }
  if (k === "j" || k === "ArrowDown") { e.preventDefault(); return select(sel + 1); }
  if (k === "k" || k === "ArrowUp") { e.preventDefault(); return select(sel - 1); }
  if (k === "Enter" && !e.target.matches("button, a, summary, input")) { e.preventDefault(); return reading(true); }
  if (k === "/") { e.preventDefault(); return $("#q").focus(); }
  if (k === "?") { e.preventDefault(); return $("#help").showModal(); }
  if (k === "[") return step(-1);
  if (k === "]") return step(1);
  if (k === "d") { location.href = "digest.html"; return; }
  if (k === "s") { e.preventDefault(); return saveOpen(); }
  if (k === "r") { const order = S.view === "day" ? ["coverage", "picks", "newest"] : ["coverage", "newest"]; return setFilter({ rank: order[(order.indexOf(S.rank) + 1) % order.length] }); }
  if (k === "g") { $("#side").classList.add("open"); return $("#regions button.here")?.focus(); }
  if (k === "t") { $("#side").classList.add("open"); return $("#types button")?.focus(); }
  if (k === "o") { $("#side").classList.add("open"); $("#outlets-box").open = true; return $("#outlets button:not(:disabled)")?.focus(); }
  const n = KEYS_CATS.indexOf(k);
  if (n >= 0 && CATS[n]) return setFilter({ cat: S.cat === CATS[n].id ? null : CATS[n].id });
});
window.addEventListener("hashchange", async () => { const before = S.view + S.id; fromHash(); if (S.view + S.id !== before) await loadPeriod(); render(); });
setInterval(() => STATUS && renderMast(), 60000);  // keep the clock and next-run time current

// ---------------------------------------------------------------- start
(async function start() {
  try {
    [META, INDEX] = await Promise.all([getJSON("meta.json"), getJSON("index.json")]);
    META.outlets.forEach(o => OUT[o.id] = o);
    CATS = META.categories;
    loadLocal();
    fromHash();
    await loadPeriod();
    const opened = S.open;
    render();
    if (opened && S.open === opened) reading(true);
    getJSON("status.json").then(s => { STATUS = s; renderMast(); renderStatus(); renderSide(); }).catch(() => {});
  } catch (err) {
    $("#list").innerHTML = `<li class="note mono"><b>Data could not be loaded.</b>${esc(err.message)}. Reload the page.</li>`;
  }
})();
