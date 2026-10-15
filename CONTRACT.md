# Coverage Index: handoff checklist for the collector and page

(Formerly "The Spread". Updated 2026-10-15 to match the built project; a copy lives in the repo as `CONTRACT.md`.)

This lists what the reader in `docs/app.js` expects. Anything not listed here is not read. Keep field names exactly as written, since the reader matches them character for character.

## 1. Data files under `docs/data/`

### `meta.json`
- `outlets`: one entry per outlet, with:
  - `id`: short unique string (used everywhere else)
  - `name`: display name
  - `place`: array of place names, broadest first: world region, country, then state and city where known, e.g. `["Europe", "United Kingdom", "London"]` or `["North America", "United States", "Maryland", "Baltimore"]`. Every outlet has at least a region and a country (no outlet uses `[]`).
  - `media`: array of media types, e.g. `["Wire"]` or `["National", "Print"]`. Values must match `media_types[].id`.
  - `labels`: object with `scope`, `ownership`, `owner`, `format` (e.g. "print", "broadcast", "digital-native", "wire service") and `specialist`. Sources are in `label_sources`; review status in `label_review`.
  - `via`: `"google"` if the outlet's stories come through Google News, otherwise `"rss"`
  - `available`: `false` for outlets with no working feed
  - `why_unavailable`: short reason, shown on hover when `available` is `false`
- `media_types`: array of `{ "id": "Wire", "rule": "one-line definition shown on hover" }`
- `categories`: array of `{ "id": "world", "name": "World" }`. The first ten are bound to number keys 1–0, in order.

### `index.json`
- `days`: array of `YYYY-MM-DD` strings in ascending order (the reader treats the last one as today). Days are U.S. Eastern days.
- `roundups`: object with arrays for `week`, `month`, and `year`:
  - week IDs look like `2026-W42`
  - month IDs look like `2026-10`
  - year IDs look like `2026`
  - each array is ascending
- `digests`: array of days that have a daily digest (used by `digest.html`)

### `status.json`
Written on every run, even when feeds fail.
- `updated`: ISO timestamp of the run
- `run`: optional (only on GitHub Actions runs), `{ "url": "link to the Actions log" }`
- `outlets`: object keyed by outlet `id`, each with `ok` (boolean), `err` (short error text, or null), `unavailable` (boolean, optional). Also present, not read by the page: `checked`, `last_ok`, `n`, `new`.

### `days/<YYYY-MM-DD>.json`
- `stories`: array of story objects, each with:
  - `o`: outlet `id`
  - `t`: headline, as published (an outlet name the outlet appends, like "-Xinhua", is removed)
  - `at`: ISO timestamp of publication
  - `u`: link to the article
  - `c`: event ID. Every story has one. Stories with the same `c` are one event; a story no other outlet covered has its own `c` (equal to its `id`).
  - `cat`: array of category IDs this story belongs to
  - `why`: array of reason codes, one per entry in `cat`, in the same order:
    - `t:<value>`: outlet section, e.g. `t:World`
    - `p:<value>`: web address path, e.g. `p:politics`
    - `k:<value>`: headline keyword, e.g. `k:tariff`
    - `w:<value>`: the headline names a country other than the U.S. (places only, not people), e.g. `w:albania`. Category: World.
    - `f` (no value): the outlet is based outside the U.S. and the headline names no U.S. place. Category: World.
    - `u` (no value): U.S. outlet, and the headline names no other country. Category: U.S.
  - `r`: rank of this story in the outlet's own feed (1 = top). Used by the "Picks" view. Omitted for Google News stories.
  - `rep`: optional. The `o` of the outlet this story repeats, if it is a reprint
  - `img`: optional image URL (the reader hides it if it fails to load)
  - Also present, not required by the page: `id` (stable story ID, used for saving) and `x` (the first 160 characters of the outlet's own summary)

### `roundups/<week|month|year>/<ID>.json`
- `groups`: array of `{ "id": "<event id>", "cat": [...], "n": <outlets>, "at": "<first>", "last": "<latest>", "s": [story, ...] }`. Only events covered by two or more outlets; up to 300 per roundup.
- Each story in `s` has `id`, `o`, `t`, `u`, `at`, and optionally `img` and `rep`. Stories in roundups carry no `cat`, `why` or `r`; the group's `cat` is used.

### `digest/<YYYY-MM-DD>.json` and `.txt`
- Written once a day at 7am Eastern for the day before: the 20 events covered by the most outlets, as data (for `digest.html`) and plain text.

## 2. Page: `docs/index.html` (newspaper layout, rebuilt 2026-10-15)

The reader finds these elements by ID. All must exist.

| ID | Purpose |
|---|---|
| `when`, `prev`, `next` | the date or period shown, with earlier and later buttons |
| `home` | the title; resets all filters |
| `runline` | next-update countdown (`.bar`), feeds answering, the light/dark switch (`data-theme-toggle`) and the key guide (`data-guide`); becomes a `data-refresh` button when a newer update is detected |
| `cats` | section buttons (`data-cat`), filled by the script; the first ten have number keys |
| `f-region`, `f-type`, `f-outlets`, `f-rank` | filter buttons; each opens a panel (`data-panel`) |
| `q` | search input (`type="search"`) |
| `crumbs` | a sentence describing the active filters, with "Show everything" (`data-clear-all`) |
| `panel` | the open filter panel |
| `front` | the front page: `.lead`, `.row3`, `.row4`, `.also` with `.block`s, or `.listing` for the other rankings |
| `event` | one story, opened: headlines, notes in the margin (`aside.notes`), save buttons |
| `main` | wraps `front` and `event` |
| `status` | the status paragraph at the foot |
| `help` | `<dialog>`: the animated key guide, opened with `?` |

Also needed:
- Buttons for the period views with `data-view="day|week|month|year"`
- `style.css`, the Newsreader font, and `saved.js` loaded before `app.js`
- The theme is saved in `localStorage` key `ci-theme` and applied before the page draws.

## 3. Saving to folders

- Saved stories live in this browser (`localStorage` key `ci-saved`), with export and import as a JSON file on `saved.html`. No accounts and no server.
- On the front page, `s` saves the selected story. In an opened story there is a "Save this story" button (`data-save-event`) and one per headline (`data-save-story="<story id>"`).
- `saved.js` creates its own dialog (`#save-dlg`): choose an existing folder or type a new folder name. No name suggestions.
- A saved item is a copy: headline text, outlet name, time, link to the source article, and reprint marks, plus a link back to the story in the reader.
- Other browser storage: `ci-off` (outlets switched off), `ci-reps` (count reprints), `ci-theme`.

## 4. Classes the script adds (the stylesheet styles these)

- Front page: `lead`, `row3`, `row4`, `also`, `block`, `kick` (`num`, `sec`), `takes`, `note`, `sel-able` and `sel` (the keyboard selection), `listing`, `outlet`, `item`, `empty`, `more`
- Opened story: `event`, `main`, `back`, `steps`, `dek`, `actions`, `heads` (`who`, `lab`, `rep`, `save-one`, `hit`), `terms`, `notes`
- Panels: `panel-in`, `opts`, `opt` (`off`), `grp`, `row-actions`, `check`
- Save dialog (from `saved.js`): `save-dlg`, `save-what`, `save-folders`, `save-new`, `save-msg`, `save-foot`
- Keyboard focus styles are required.

## 5. Collector responsibilities

- Run every 15 minutes, at :07, :22, :37 and :52 UTC (the cron line in `.github/workflows/collect.yml`). Outlets collected through Google News are checked about once an hour (`GOOGLE_EVERY`), because Google blocks frequent requests. The reader's "next run" time assumes the 15-minute schedule.
- Use each outlet's direct feed where possible, with conditional requests (ETag / If-Modified-Since). An outlet can have more than one feed (`feed` may be a list).
- A failed outlet should not fail the run. Record it in `status.json` and keep its last good stories.
- Write `status.json` on every run.
- Cluster stories so one event has one `c`. Fill `why` for every category assignment.
- Assign `rep` only when the reprint is clear (the same headline word for word within one event; a wire service is treated as the original).
- Rebuild `index.json` whenever a new day, week, month, or year appears.
- Fields the collector needs but the page doesn't (`tags`, `ti`) are kept in `data/extra/`, which is not published.

## 6. Pages

All exist: `index.html` (reader), `digest.html` (the `d` key opens it), `saved.html`, `method.html`, and `style.css`.

## 7. Quick check before calling it done

- Open the page with no data files: it should show "Data could not be loaded" and not crash.
- Open it with one day of data: category keys, outlet toggles, and the detail panel should all work.
- Turn off one outlet: the breadcrumb, counts, and "covered by N of M" line should update.
- Check that unavailable outlets show as unavailable, not missing.
- Save an event and a single headline to new folders: both appear on `saved.html` with working source links, and export then import brings them back.
