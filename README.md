# Coverage Index

A news reader for people who follow the news closely. Every 15 minutes it collects headlines from about 170 outlets on six continents, groups stories about the same event, and shows who covered each event, who didn't, and how each outlet headlined it.

Live site: https://chrisqtruong.github.io/coverage-index/ (daily digest: `digest.html`, method: `method.html`)

## What it does

- **Filters, broad to narrow:** Category › Region › Media type › Outlet. The breadcrumb at the top always shows the current filter, and the URL keeps it, so any view can be bookmarked or shared.
- **Three rankings:** coverage (events covered by the most outlets in the current filter), outlets' picks (each outlet's own top stories, by feed order), and newest.
- **Coverage view:** open an event to see which outlets ran it and which didn't, each outlet's headline side by side with its labels and time, and the words that appear in some headlines but not others.
- **Archive:** any day, plus week, month and year roundups that join the same event across days.
- **Daily digest:** written at 7am Eastern for the day before, as a page and as plain text.

## How it works

- `scripts/collect.py` runs every 15 minutes in GitHub Actions (`.github/workflows/collect.yml`). It reads each outlet's own RSS or Atom feed, or a Google News search for outlets with no usable feed. It sends conditional requests (ETag / If-Modified-Since, kept in `data/feed-cache.json`), so feeds that haven't changed cost almost nothing. A failed feed is logged and shown on the page; it never stops the run.
- **Grouping:** headlines (plus the start of each summary) become lists of distinctive words, compared by TF-IDF cosine similarity. Two stories join when they come from different outlets, their words overlap enough, the story also matches the group as a whole, and they don't name different places (`places.json`). No AI model is used.
- **Reprints:** when outlets run another outlet's story word for word (usually AP), the copies are marked. By default a reprint counts as the outlet it repeats; "count reprints" counts it as its own.
- **Categories** (`categories.json`): a story gets every category whose rules it matches, from the outlet's own section tags, the web address, or headline keywords. Each match records why.
- **Outlet labels** (`outlets.json`): scope, ownership, format and coverage area, each with a source link. Media types are derived from those labels by the rules in `media_types`. There are no political-lean or reliability ratings. Labels were researched with AI assistance and stay marked unverified until a person checks them (`label_review`).

## Keys

`j`/`k` or the arrow keys move, `enter` opens, `esc` goes back (closes the event, then drops the narrowest filter, one per press), `/` searches, `1`-`9` and `0` jump to a category, `c` `g` `t` `o` open the category, region, media type and outlet lists, `[` `]` go to the earlier or later day, `r` switches ranking, `?` lists every key.

j and k were chosen because they sit under the right hand and are a common convention, but nothing requires knowing vim: the arrow keys do the same thing.

## Settings

- **Update interval:** the cron line in `.github/workflows/collect.yml` (every 15 minutes). Outlets collected through Google News are checked about once an hour regardless (`GOOGLE_EVERY` in `scripts/collect.py`), because Google blocks frequent requests. GitHub's scheduling is best-effort.
- **Thresholds** (matching, digest size, digest hour): constants at the top of `scripts/collect.py`.

## Adding an outlet

Add an entry to `outlets.json` with its feed URL (`via: "rss"`) or a Google News site search (`via: "google"`), its location (`place`, `lat`, `lng`) and its labels with sources. Then run `python3 scripts/collect.py --test` to check that the feed answers.

## Running locally

```
python3 scripts/collect.py            # collect and update docs/data/
python3 scripts/collect.py --test     # check every feed, write nothing
python3 scripts/collect.py --offline  # rebuild groups, categories, roundups and digests from saved data
python3 tests/test_collect.py         # offline tests
python3 -m http.server -d docs        # view the site at http://localhost:8000
```

Standard library Python and `curl` only. No build step for the site.

## Content

Headlines, short summary excerpts and preview images belong to the outlets. They come from public feeds and link back to the original articles. Images are shown from the outlet's own servers and are never copied.

Code: MIT License.
