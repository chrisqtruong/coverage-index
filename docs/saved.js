// Coverage Index: saved stories and folders. Kept in this browser (localStorage), with export and import as a
// JSON file for backups and other devices. Each saved item is a copy: headline, outlet, time and link to the
// original article, so it survives even after the archive or the outlet's page changes. Used by index.html and
// saved.html.
"use strict";

window.SAVED = (() => {
  const KEY = "ci-saved";
  const blank = () => ({ version: 1, folders: [], items: [] });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function read() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || "null");
      return d && Array.isArray(d.folders) && Array.isArray(d.items) ? d : blank();
    } catch (e) { return blank(); }
  }
  function write(d) {
    try { localStorage.setItem(KEY, JSON.stringify(d)); return true; }
    catch (e) { alert("Saving failed: this browser isn't allowing storage here (private window, or storage full). Export what you have."); return false; }
  }

  function addFolder(name) {
    name = name.trim().slice(0, 80);
    if (!name) return null;
    const d = read();
    const have = d.folders.find(f => f.name.toLowerCase() === name.toLowerCase());
    if (have) return have;
    const f = { id: uid(), name, created: new Date().toISOString() };
    d.folders.push(f);
    write(d);
    return f;
  }
  function renameFolder(id, name) {
    name = name.trim().slice(0, 80);
    const d = read(), f = d.folders.find(x => x.id === id);
    if (!f || !name) return;
    f.name = name;
    write(d);
  }
  function deleteFolder(id) {  // its items are removed too; the caller confirms first
    const d = read();
    d.folders = d.folders.filter(f => f.id !== id);
    d.items = d.items.filter(i => i.folder !== id);
    write(d);
  }

  // item: { kind: "event" | "story", key, date, event, headline, stories: [{ outlet, outletName, t, u, at, rep }] }
  function save(item, folderId) {
    const d = read();
    if (d.items.some(i => i.folder === folderId && i.key === item.key)) return "already";
    d.items.push({ ...item, id: uid(), folder: folderId, saved: new Date().toISOString() });
    return write(d) ? "saved" : "failed";
  }
  function remove(id) { const d = read(); d.items = d.items.filter(i => i.id !== id); write(d); }
  function move(id, folderId) {
    const d = read(), i = d.items.find(x => x.id === id);
    if (!i) return;
    if (d.items.some(x => x.folder === folderId && x.key === i.key)) { d.items = d.items.filter(x => x.id !== id); }
    else i.folder = folderId;
    write(d);
  }

  function exportFile() {
    const d = read();
    const blob = new Blob([JSON.stringify(d, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "coverage-index-saved-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  // Import adds to what's here: folders with the same name are combined, and items already in a folder are skipped.
  async function importFile(file) {
    const got = JSON.parse(await file.text());
    if (!got || !Array.isArray(got.folders) || !Array.isArray(got.items)) throw new Error("this isn't a Coverage Index export");
    const d = read(), map = {};
    let folders = 0, items = 0;
    for (const f of got.folders) {
      let mine = d.folders.find(x => x.name.toLowerCase() === String(f.name).toLowerCase());
      if (!mine) { mine = { id: uid(), name: String(f.name).slice(0, 80), created: f.created || new Date().toISOString() }; d.folders.push(mine); folders++; }
      map[f.id] = mine.id;
    }
    for (const i of got.items) {
      const folder = map[i.folder];
      if (!folder || !i.key || d.items.some(x => x.folder === folder && x.key === i.key)) continue;
      d.items.push({ ...i, id: uid(), folder });
      items++;
    }
    write(d);
    return { folders, items };
  }

  // ---------------------------------------------------------------- the "save to folder" dialog
  let dlg;
  function dialog() {
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.id = "save-dlg";
    dlg.className = "save-dlg";
    dlg.setAttribute("aria-label", "Save to a folder");
    document.body.appendChild(dlg);
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
    return dlg;
  }
  function open(item) {
    const d = read(), el = dialog();
    const what = item.kind === "event" ? `the event, with ${item.stories.length} headline${item.stories.length > 1 ? "s" : ""}` : `${escH(item.stories[0].outletName)}'s headline`;
    el.innerHTML =
      `<p class="lbl">Save</p><h2>${escH(item.headline)}</h2>` +
      `<p class="mono save-what">Saving ${what}: headline text, outlet, time and link to the source.</p>` +
      (d.folders.length ? `<p class="lbl">To a folder</p><ul class="save-folders">` +
        d.folders.map(f => {
          const n = d.items.filter(i => i.folder === f.id).length, here = d.items.some(i => i.folder === f.id && i.key === item.key);
          return `<li><button type="button" data-folder="${f.id}"${here ? " disabled" : ""}>${escH(f.name)} <span class="n">${here ? "already here" : n}</span></button></li>`;
        }).join("") + `</ul>` : "") +
      `<form class="save-new" method="dialog"><label class="lbl" for="save-name">${d.folders.length ? "Or a new folder" : "New folder"}</label>` +
      `<input id="save-name" type="text" maxlength="80" autocomplete="off" placeholder="Folder name"><button type="submit">save</button></form>` +
      `<p class="mono save-msg" aria-live="polite"></p>` +
      `<p class="mono save-foot"><a href="saved.html">open saved</a> · <button type="button" data-close>close (Esc)</button></p>`;
    const done = (folder, res) => {
      el.querySelector(".save-msg").textContent = res === "saved" ? `Saved to "${folder.name}".` : res === "already" ? `Already in "${folder.name}".` : "";
      if (res === "saved") setTimeout(() => el.open && el.close(), 900);
    };
    el.querySelectorAll("[data-folder]").forEach(b => b.addEventListener("click", () => {
      const f = read().folders.find(x => x.id === b.dataset.folder);
      done(f, save(item, f.id));
    }));
    el.querySelector("form").addEventListener("submit", e => {
      e.preventDefault();
      const name = el.querySelector("#save-name").value;
      if (!name.trim()) { el.querySelector(".save-msg").textContent = "Type a folder name, or choose a folder above."; return; }
      const f = addFolder(name);
      done(f, save(item, f.id));
    });
    el.querySelector("[data-close]").addEventListener("click", () => el.close());
    el.showModal();
    (el.querySelector("[data-folder]:not(:disabled)") || el.querySelector("#save-name")).focus();
  }

  return { read, write, addFolder, renameFolder, deleteFolder, save, remove, move, exportFile, importFile, open };
})();
