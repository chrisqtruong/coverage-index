// Fills the method page from the published data, so the figures always match the code that produced them.
"use strict";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

(async function () {
  const [meta, status] = await Promise.all([
    fetch("data/meta.json", { cache: "no-cache" }).then(r => r.json()),
    fetch("data/status.json", { cache: "no-cache" }).then(r => r.json()).catch(() => null),
  ]);
  const m = meta.method, outs = meta.outlets;
  const live = outs.filter(o => o.available !== false);
  const google = live.filter(o => o.via === "google");
  set("m-version", status?.run?.sha ? "code " + status.run.sha.slice(0, 7) : "local copy");
  set("m-outlets", `${outs.length} outlets: ${live.length - google.length} read from their own feed, ${google.length} through Google News, ${outs.length - live.length} unavailable`);
  set("m-ua", m.user_agent);
  set("m-summary", m.summary_chars);
  set("m-photos", m.photo_fetches);
  set("m-pair", m.pair_min.toFixed(2));
  set("m-group", m.group_min.toFixed(2));
  set("m-places", m.places);
  set("m-link", m.link_days);
  set("m-cats", m.categories);
  set("m-labelnote", meta.label_note);
  document.getElementById("m-media").innerHTML = meta.media_types.map(t => `<li>${esc(t.id)}: ${esc(t.rule)}.</li>`).join("");
  const regions = {};
  outs.forEach(o => regions[o.continent] = (regions[o.continent] || 0) + 1);
  set("m-regions", Object.entries(regions).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", "));
  const verified = outs.filter(o => o.label_review?.verified_by).length;
  set("m-verified", `${verified} of ${outs.length} outlets verified by a person; ${outs.length - verified} unverified (researched with AI assistance)`);
  const run = document.getElementById("m-run");
  if (status?.run?.url) run.innerHTML = `<a href="${esc(status.run.url)}">run ${esc(status.run.id)}</a>, ${esc(new Date(status.updated).toUTCString())}`;
  else run.textContent = status?.updated ? new Date(status.updated).toUTCString() + " (local run, no public log)" : "none";
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  document.querySelector("#m-table tbody").innerHTML = outs.slice().sort((a, b) => a.name.localeCompare(b.name)).map(o => {
    const L = o.labels || {}, src = o.label_sources || {};
    const urls = [...new Set(Object.values(src))];
    const feed = o.available === false ? "unavailable" : o.via === "google" ? "Google News" : "own feed";
    const rv = o.label_review || {};
    const st = rv.verified_by ? `verified, ${esc(rv.verified_by)}, ${esc(rv.verified_on)}` : "unverified";
    return `<tr><td>${esc(o.name)}</td><td>${esc((o.place || []).slice(1).join(", "))}</td><td>${esc(L.scope)}</td><td>${esc(L.ownership)}</td>` +
      `<td>${esc(L.owner)}</td><td>${esc(L.format)}${L.specialist ? ", " + esc(L.specialist) : ""}</td><td>${feed}</td>` +
      `<td>${urls.map(u => `<a href="${esc(u)}">${esc(host(u))}</a>`).join(" ")}</td>` +
      `<td${rv.verified_by ? "" : ' class="unv"'}>${st}${o.label_confidence === "medium" ? "; sources partly conflict or are thin" : ""}${o.label_note ? `<span class="note">${esc(o.label_note)}</span>` : ""}</td></tr>`;
  }).join("");
})().catch(e => { document.querySelector(".method").insertAdjacentHTML("afterbegin", `<p>Data could not be loaded: ${esc(e.message)}.</p>`); });
