// Fills the method page from the published data, so the figures always match the code that produced them,
// and makes the page easy to move through: a contents rail that follows the reader, j/k between sections,
// and a searchable, filterable outlet directory grouped by region.
"use strict";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
const $ = s => document.querySelector(s);

// ---------------------------------------------------------------- contents: rail (desktop), sticky bar (phone)
const sections = [...document.querySelectorAll(".mt-main section[id]")];
const toc = sections.map((s, i) => `<li><a href="#${s.id}" data-sec="${s.id}">${i + 1}. ${esc(s.dataset.title)}</a></li>`).join("");
$("#rail").innerHTML = toc;
$("#bar").innerHTML = toc;
let current = null;
function mark(id) {
  if (id === current) return;
  current = id;
  document.querySelectorAll("[data-sec]").forEach(a => a.setAttribute("aria-current", a.dataset.sec === id));
  const s = sections.find(x => x.id === id);
  $("#bar-current").textContent = s ? `Contents: ${sections.indexOf(s) + 1}. ${s.dataset.title}` : "Contents";
}
// the section nearest the top of the screen is the current one (an observer, not a scroll listener)
const seen = new Map();
const io = new IntersectionObserver(entries => {
  entries.forEach(e => seen.set(e.target.id, e.isIntersecting));
  const visible = sections.filter(s => seen.get(s.id));
  if (visible.length) mark(visible[0].id);
}, { rootMargin: "0px 0px -65% 0px" });
sections.forEach(s => io.observe(s));
$("#bar").addEventListener("click", e => { if (e.target.closest("a")) $(".mt-bar").open = false; });

// j / k: next and previous section; / searches outlets
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, textarea")) {
    if (e.key === "Escape" && e.target.id === "dir-q") { e.target.value = ""; e.target.blur(); renderDir(); }
    return;
  }
  const i = sections.findIndex(s => s.id === current);
  if (e.key === "j" || e.key === "k") {
    const n = sections[Math.max(0, Math.min(sections.length - 1, (i < 0 ? -1 : i) + (e.key === "j" ? 1 : -1)))];
    n.scrollIntoView({ block: "start" });
    mark(n.id);
    history.replaceState(null, "", "#" + n.id);
  }
  if (e.key === "/") { e.preventDefault(); $("#labels").scrollIntoView({ block: "start" }); $("#dir-q").focus({ preventScroll: true }); }
});

// ---------------------------------------------------------------- figures and the outlet directory
let OUTS = [], ownFilter = null, feedFilter = null;
const feedOf = o => o.available === false ? "unavailable" : o.via === "google" ? "Google News" : "own feed";
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
const REGION_ORDER = ["North America", "Latin America", "Europe", "Middle East", "Africa", "Asia", "Oceania"];

function outletHTML(o) {
  const L = o.labels || {}, rv = o.label_review || {};
  const urls = [...new Set(Object.values(o.label_sources || {}))];
  const st = rv.verified_by ? `verified, ${esc(rv.verified_by)}, ${esc(rv.verified_on)}` : "unverified";
  return `<article class="outlet"><h4>${esc(o.name)}</h4><span class="st${rv.verified_by ? " ok" : ""}">${st}${o.label_confidence === "medium" ? ", thin sources" : ""}</span>` +
    `<p class="facts-line">${esc((o.place || []).slice(1).join(", "))} · <b>${esc(L.scope)}</b> · <b>${esc(L.ownership)}</b>${L.owner ? ` (${esc(L.owner)})` : ""} · ` +
    `<b>${esc(L.format)}</b>${L.specialist ? `, ${esc(L.specialist)}` : ""} · ${feedOf(o)}</p>` +
    (urls.length ? `<p class="src">sources: ${urls.map(u => `<a href="${esc(u)}">${esc(host(u))}</a>`).join("")}</p>` : "") +
    (o.label_note || o.why_unavailable ? `<details><summary>note</summary><p>${esc([o.why_unavailable, o.label_note].filter(Boolean).join(" "))}</p></details>` : "") +
    `</article>`;
}

function chips(el, label, values, active, attr) {
  el.innerHTML = `<span>${label}:</span><button type="button" ${attr}="" aria-pressed="${!active}">all</button>` +
    values.map(([v, n]) => `<button type="button" ${attr}="${esc(v)}" aria-pressed="${active === v}">${esc(v)} ${n}</button>`).join("");
}

function renderDir() {
  const q = $("#dir-q").value.trim().toLowerCase();
  const match = o => (!ownFilter || o.labels?.ownership === ownFilter) && (!feedFilter || feedOf(o) === feedFilter) &&
    (!q || [o.name, o.labels?.owner, ...(o.place || [])].join(" ").toLowerCase().includes(q));
  const hits = OUTS.filter(match);
  const count = (fn, list) => { const m = new Map(); list.forEach(o => { const k = fn(o); if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  chips($("#chip-own"), "ownership", count(o => o.labels?.ownership, OUTS), ownFilter, "data-own");
  chips($("#chip-feed"), "feed", count(feedOf, OUTS), feedFilter, "data-feed");
  set("dir-count", hits.length === OUTS.length ? `${OUTS.length} outlets, grouped by region. Open a region to see its outlets.` : `${hits.length} of ${OUTS.length} outlets match.`);
  if (!hits.length) { $("#dir").innerHTML = `<p class="dir-empty">No outlet matches. Clear the search (Esc) or choose "all".</p>`; return; }
  const filtered = hits.length !== OUTS.length;
  const by = new Map();
  hits.forEach(o => { const r = (o.place || [])[0] || "Other"; if (!by.has(r)) by.set(r, []); by.get(r).push(o); });
  $("#dir").innerHTML = [...by.keys()].sort((a, b) => (REGION_ORDER.indexOf(a) + 99) % 99 - (REGION_ORDER.indexOf(b) + 99) % 99 || a.localeCompare(b)).map(r => {
    const list = by.get(r).sort((a, b) => a.name.localeCompare(b.name));
    return `<details class="dir-region"${filtered ? " open" : ""}><summary>${esc(r)} <span class="n">${list.length}</span></summary>${list.map(outletHTML).join("")}</details>`;
  }).join("");
}

document.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-own")) { ownFilter = b.dataset.own || null; renderDir(); }
  if (b.hasAttribute("data-feed")) { feedFilter = b.dataset.feed || null; renderDir(); }
});
$("#dir-q").addEventListener("input", renderDir);

(async function () {
  const [meta, status, index] = await Promise.all([
    fetch("data/meta.json", { cache: "no-cache" }).then(r => r.json()),
    fetch("data/status.json", { cache: "no-cache" }).then(r => r.json()).catch(() => null),
    fetch("data/index.json", { cache: "no-cache" }).then(r => r.json()).catch(() => null),
  ]);
  const m = meta.method, outs = meta.outlets;
  OUTS = outs;
  const live = outs.filter(o => o.available !== false);
  const google = live.filter(o => o.via === "google");
  const sources = `${outs.length} outlets: ${live.length - google.length} read from their own feed, ${google.length} through Google News, ${outs.length - live.length} unavailable`;
  set("m-version", status?.run?.sha ? "code " + status.run.sha.slice(0, 7) : "local copy");
  set("m-outlets", sources);
  set("g-outlets", sources + ".");
  set("m-ua", m.user_agent);
  set("m-summary", m.summary_chars);
  set("m-photos", m.photo_fetches);
  set("m-pair", m.pair_min.toFixed(2));
  set("m-group", m.group_min.toFixed(2));
  set("m-places", m.places);
  set("m-link", m.link_days);
  set("m-cats", m.categories);
  set("m-labelnote", meta.label_note);
  $("#m-media").innerHTML = meta.media_types.map(t => `<li><b>${esc(t.id)}:</b> ${esc(t.rule)}.</li>`).join("");
  const regions = {};
  outs.forEach(o => regions[o.continent] = (regions[o.continent] || 0) + 1);
  set("m-regions", Object.entries(regions).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", "));
  const verified = outs.filter(o => o.label_review?.verified_by).length;
  const vtext = `${verified} of ${outs.length} outlets verified by a person; ${outs.length - verified} unverified (researched with AI assistance).`;
  set("m-verified", vtext);
  set("g-labels", "Checkable facts with source links; no political-lean ratings. " + vtext);
  const run = $("#m-run");
  if (status?.run?.url) run.innerHTML = `<a href="${esc(status.run.url)}">run ${esc(status.run.id)}</a>, ${esc(new Date(status.updated).toUTCString())}`;
  else run.textContent = status?.updated ? new Date(status.updated).toUTCString() + " (local run, no public log)" : "none";
  renderDir();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  // share of stories with no category, from the latest day (computed, so it can't go stale)
  const day = index?.days?.[index.days.length - 1];
  if (day) {
    const st = (await fetch(`data/days/${day}.json`).then(r => r.json())).stories;
    const none = st.filter(s => !(s.cat || []).length).length;
    set("m-nocat", `${none} of ${st.length.toLocaleString("en-US")} stories (${(100 * none / st.length).toFixed(1)}%) on ${day}`);
  }
})().catch(e => { $(".mt-main").insertAdjacentHTML("afterbegin", `<p>Data could not be loaded: ${esc(e.message)}.</p>`); });
