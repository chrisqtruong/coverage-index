#!/usr/bin/env python3
"""Coverage Index: collect headlines from every outlet in outlets.json and group the same story across outlets.

  python3 scripts/collect.py            # fetch every feed, update docs/data/
  python3 scripts/collect.py --test     # fetch every feed, print a per-outlet report, write nothing
  python3 scripts/collect.py --offline  # no fetching: rebuild groups, categories, roundups and digests from saved data
  python3 scripts/collect.py --digest 2026-10-14   # (re)build one day's digest

Standard library only. Feed reading comes from tracewire's scripts/wire.py. Prints changed=true|false
(also to $GITHUB_OUTPUT) so the workflow (every 15 minutes) commits only when something changed.

How stories are grouped (no AI): every headline (plus the start of its summary) becomes a list of
distinctive words. Two stories from different outlets join the same group when their words overlap
enough (TF-IDF cosine similarity). A group only grows when the newcomer also matches the group as a
whole, so one loose match can't chain unrelated stories together.
"""
import concurrent.futures as cf, datetime as dt, email.utils, gzip, hashlib, html, json, math, os, re, subprocess, sys, time
import urllib.parse
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTLETS = json.load(open(os.path.join(ROOT, "outlets.json"), encoding="utf-8"))
OUTLETS_BY_ID = {o["id"]: o for o in OUTLETS["outlets"]}
CATS = json.load(open(os.path.join(ROOT, "categories.json"), encoding="utf-8"))["categories"]
PLACES = json.load(open(os.path.join(ROOT, "places.json"), encoding="utf-8"))["places"]
PLACE_RE = re.compile(r"\b(%s)\b" % "|".join(re.escape(w) for w in sorted(PLACES, key=len, reverse=True)))
DATA = os.path.join(ROOT, "docs", "data")
CACHE = os.path.join(ROOT, "data", "feed-cache.json")  # ETag / Last-Modified per feed, so unchanged feeds cost almost nothing
UA = "Mozilla/5.0 (compatible; coverage-index/1.0; +https://github.com/chrisqtruong/coverage-index)"  # honest, and not refused as a bare bot
ET_TZ = ZoneInfo("America/New_York")  # days are US Eastern days
NOW = dt.datetime.now(dt.timezone.utc)
KEEP_DAYS = 2           # ignore feed items published before yesterday (Eastern)
SUMMARY = 160           # characters of summary kept; never the article itself
PHOTO_FETCHES = 150     # article pages fetched per run to find a photo
GOOGLE_GAP = 3          # seconds between Google News requests (it rate-limits)
GOOGLE_EVERY = 55       # minutes between checks of the outlets collected through Google News (runs are every 15)
PAIR_MIN = 0.30         # story-to-story similarity needed to join
GROUP_MIN = 0.30        # story-to-group similarity needed to join (tuned 2026-10-14: 0.22 let unrelated stories chain)
LOCAL_MIN = 0.50        # local outlets in different cities join only when this similar (e.g. the same wire story)
LINK_DAYS = 3           # roundups link a story's groups across this many days
ROUNDUP_KEEP = 300      # groups kept per roundup file
DIGEST_HOUR = 7         # Eastern hour after which yesterday's digest is built
DIGEST_KEEP = 20        # stories in a digest


# ---------------------------------------------------------------- fetching (parsing from tracewire's wire.py)

def get(url, accept="application/rss+xml, application/atom+xml, application/xml, text/xml, */*", timeout=25):
    """Download through curl. Several sites' bot protection refuses Python's own HTTPS connections but accepts
    curl's, with the same headers. curl retries once on timeouts and 429/5xx, never on 403/404."""
    def run(extra):
        r = subprocess.run(["curl", "-sSL", "--compressed", "--max-time", str(timeout), "--retry", "1", "--retry-delay", "4",
                            "-A", UA, "-w", "\n%{http_code}", *extra, url], capture_output=True)
        raw, _, code = r.stdout.rpartition(b"\n")
        return r, raw, code

    r, raw, code = run(["-H", "Accept: " + accept])
    if r.returncode == 92 or code == b"406":  # a broken HTTP/2 server, or one that rejects the Accept header
        r, raw, code = run(["--http1.1"])
    if r.returncode or code != b"200":
        raise OSError("HTTP %s %s" % (code.decode() or "-", r.stderr.decode("utf-8", "replace").strip()[:120]))
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw  # some servers gzip unasked


class NotModified(Exception):
    pass


def get_feed(url, cache):
    """Like get(), but sends If-None-Match / If-Modified-Since from the last fetch and raises NotModified on 304.
    cache is this feed's entry ({"etag", "modified"}); it is updated in place."""
    import tempfile
    with tempfile.NamedTemporaryFile() as hdr:
        extra = ["-D", hdr.name, "-H", "Accept: application/rss+xml, application/atom+xml, application/xml, text/xml, */*"]
        if cache.get("etag"):
            extra += ["-H", "If-None-Match: " + cache["etag"]]
        if cache.get("modified"):
            extra += ["-H", "If-Modified-Since: " + cache["modified"]]

        def run(more):
            r = subprocess.run(["curl", "-sSL", "--compressed", "--max-time", "25", "--retry", "1", "--retry-delay", "4",
                                "-A", UA, "-w", "\n%{http_code}", *more, url], capture_output=True)
            raw, _, code = r.stdout.rpartition(b"\n")
            return r, raw, code

        r, raw, code = run(extra)
        if r.returncode == 92 or code == b"406":
            r, raw, code = run(["-D", hdr.name, "--http1.1"])
        if code == b"304":
            raise NotModified()
        if r.returncode or code != b"200":
            raise OSError("HTTP %s %s" % (code.decode() or "-", r.stderr.decode("utf-8", "replace").strip()[:120]))
        heads = {}
        for line in open(hdr.name, encoding="latin-1").read().splitlines():  # last response's headers win
            if ":" in line:
                k, v = line.split(":", 1)
                heads[k.strip().lower()] = v.strip()
            elif line.startswith("HTTP/"):
                heads = {}
        cache.clear()
        if heads.get("etag"):
            cache["etag"] = heads["etag"]
        if heads.get("last-modified"):
            cache["modified"] = heads["last-modified"]
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def when(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = email.utils.parsedate_to_datetime(s)
    except Exception:
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def text(x):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", x or ""))).strip()


def local(tag):
    return tag.rsplit("}", 1)[-1]


IMG_EXT = re.compile(r"\.(jpe?g|png|webp|gif|avif)(\?|$)", re.I)


def img_in(markup):
    m = re.search(r"<img\b[^>]*?\bsrc=[\"']([^\"']+)", markup or "", re.I)
    return html.unescape(m.group(1)) if m else None


def parse_feed(raw):
    """RSS, RDF and Atom. Returns dicts: t title, u link, at time, x summary, via_o (Google News outlet),
    img photo, tags (the outlet's own section names)."""
    raw = raw.lstrip(b"\xef\xbb\xbf \t\r\n")
    if raw[:200].lower().find(b"<html") >= 0 or raw[:15].lower().startswith(b"<!doctype html"):
        raise ValueError("got an HTML page, not a feed (blocked or moved)")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return parse_loose(raw)
    out = []
    for el in root.iter():
        if local(el.tag) not in ("item", "entry"):
            continue
        f, imgs, tags = {}, [], []
        for ch in el:
            n = local(ch.tag)
            if n == "title":
                f["t"] = text(ch.text)
            elif n == "link":
                href = ch.get("href")
                if href and ch.get("rel", "alternate") == "alternate":
                    f.setdefault("u", href)
                elif ch.text and ch.text.strip():
                    f.setdefault("u", ch.text.strip())
            elif n in ("pubDate", "published", "updated", "date", "issued") and "at" not in f:
                f["at"] = when(ch.text)
            elif n == "source" and ch.text:
                f["via_o"] = text(ch.text)
            elif n in ("description", "summary") and ch.text:
                f["x"] = text(ch.text)[:SUMMARY]
                imgs.append((0, img_in(ch.text)))
            elif n == "encoded" and ch.text:
                imgs.append((0, img_in(ch.text)))
                f.setdefault("x", text(ch.text)[:SUMMARY])
            elif n == "content" and ch.text and ch.get("type") in ("html", "xhtml"):
                imgs.append((0, img_in(ch.text)))
            elif n == "guid" and ch.text and "u" not in f and ch.text.startswith("http"):
                f["u"] = ch.text.strip()
            elif n in ("category", "subject"):
                tags.append(text(ch.text or ch.get("term") or ""))
        for m in el.iter():  # media:content / media:thumbnail / enclosure, also inside media:group
            n = local(m.tag)
            url = m.get("url") or m.get("href")
            if not url:
                continue
            kind = (m.get("medium") or "") + (m.get("type") or "")
            if n in ("content", "thumbnail") and ("image" in kind or IMG_EXT.search(url) or (n == "thumbnail")):
                imgs.append((int(m.get("width") or 1), url))
            elif n == "enclosure" and ("image" in kind or IMG_EXT.search(url)):
                imgs.append((1, url))
            elif n == "image" and IMG_EXT.search(url):
                imgs.append((1, url))
        imgs = [(w, u) for w, u in imgs if u and u.startswith(("http", "//"))]
        if imgs:
            f["img"] = max(imgs, key=lambda p: p[0])[1]
        tags = [t for t in tags if t and len(t) < 60]
        if tags:
            f["tags"] = tags[:8]
        if f.get("t") and f.get("u"):
            out.append(f)
    return out


def parse_loose(raw):
    """Fallback for feeds that are not well-formed XML (stray &, bad entities): read <item>/<entry> blocks by pattern."""
    t = raw.decode("utf-8", "replace")
    cdata = lambda s: re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", s or "", flags=re.S)
    out = []
    for blk in re.findall(r"<(?:item|entry)\b.*?</(?:item|entry)>", t, re.S):
        g = lambda tag: (re.search(r"<%s\b[^>]*>(.*?)</%s>" % (tag, tag), blk, re.S) or [None, ""])[1]
        title = text(cdata(g("title")))
        link = g("link").strip() or (re.search(r'<link\b[^>]*href="([^"]+)"', blk) or [None, ""])[1]
        link = cdata(link).strip()
        at = when(g("pubDate") or g("published") or g("updated") or g("dc:date"))
        if title and link.startswith("http"):
            f = {"t": title, "u": html.unescape(link), "at": at, "x": text(cdata(g("description")))[:SUMMARY]}
            m = re.search(r'<(?:media:content|media:thumbnail|enclosure)\b[^>]*url="([^"]+)"', blk) or None
            img = (m and m.group(1)) or img_in(cdata(g("description"))) or img_in(cdata(g("content:encoded")))
            if img:
                f["img"] = html.unescape(img)
            tags = [text(cdata(c)) for c in re.findall(r"<category\b[^>]*>(.*?)</category>", blk, re.S)]
            if tags:
                f["tags"] = [x for x in tags if x][:8]
            out.append(f)
    if not out:
        raise ValueError("not a readable feed")
    return out


def norm_url(u):
    p = urllib.parse.urlsplit(u.strip())
    q = "&".join(x for x in p.query.split("&") if x and not x.startswith(("utm_", "ref=", "cmpid", "ocid", "taid", "smid")))
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), q, ""))


def norm_title(t):
    t = re.sub(r"\s+[-|–]\s+[^-|–]{2,40}$", "", t)  # drop " - Outlet" suffix (Google News)
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def clean_title(t, via_o, outlet_name=None):
    """Drop an outlet's own name from the end of a headline: Google News adds ' - Outlet', and some outlets add
    '-Xinhua' or ' | CNN' themselves."""
    for name in filter(None, (via_o, outlet_name)):
        t = re.sub(r"\s*[-|–:]\s*%s\s*$" % re.escape(name), "", t, flags=re.I).strip()
    return t


JUNK_TITLES = {"videos", "video", "photos", "live", "watch", "podcast", "newsletter", "cartoon"}


def is_junk(t):
    """Feed entries that are a section, not a story: "Videos | - CNN", "Cartoon for October 15, 2026"."""
    rest = [w for w in re.sub(r"[^a-z ]+", " ", t.lower()).split() if w not in DATES and w not in ("for", "the", "of", "and")]
    return not rest or all(w in JUNK_TITLES for w in rest)


def drop_repeats(stories):
    """An outlet that posts the same story twice (a new link, a lightly edited headline) keeps only its first
    version: same outlet, same day, and at least 80% of the headline's distinctive words shared (4 words or more)."""
    kept, by_outlet = [], defaultdict(list)
    for s in sorted(stories, key=lambda s: s["at"]):
        ws = set(words(s["t"]))
        if len(ws) >= 4 and any(len(ws & w) / len(ws | w) >= 0.8 for w in by_outlet[s["o"]]):
            continue
        by_outlet[s["o"]].append(ws)
        kept.append(s)
    return kept


def poll(o, cache):
    """Returns (outlet, items or None, error or None, seconds). items == [] means the feed hasn't changed (304)."""
    t0 = time.time()
    feeds = o["feed"] if isinstance(o["feed"], list) else [o["feed"]]  # some outlets split news across feeds
    items, unchanged = [], 0
    for i, url in enumerate(feeds):
        entry = cache.setdefault(o["id"] if i == 0 else "%s#%d" % (o["id"], i), {})
        try:
            got = parse_feed(get_feed(url, entry))
            if not got:
                raise ValueError("feed had no stories")
            items += got
        except NotModified:
            unchanged += 1
        except Exception as e:
            entry.clear()  # next time, ask for the whole feed
            return o, None, "%s: %s" % (type(e).__name__, str(e)[:160]), time.time() - t0
    if unchanged == len(feeds):
        return o, [], None, time.time() - t0
    return o, items, None, time.time() - t0


def google_due(o, status):
    """Google News outlets are checked about once an hour, however often the collector runs."""
    last = (status.get("outlets", {}).get(o["id"]) or {}).get("checked")
    return not last or NOW - when(last) >= dt.timedelta(minutes=GOOGLE_EVERY)


def poll_all(outlets, cache, status):
    """Direct feeds 12 at a time; Google News feeds that are due, one at a time with a pause, alongside."""
    live = [o for o in outlets if o.get("available", True) and o.get("feed")]
    direct = [o for o in live if o["via"] != "google"]
    google = [o for o in live if o["via"] == "google" and google_due(o, status)]

    def slow():
        res = []
        for i, o in enumerate(google):
            if i:
                time.sleep(GOOGLE_GAP)
            res.append(poll(o, cache))
        return res

    with cf.ThreadPoolExecutor(13) as ex:
        g = ex.submit(slow)
        res = list(ex.map(lambda o: poll(o, cache), direct))
        res += g.result()
    # Fallback: some sites refuse GitHub's servers but not a home connection. When an outlet's own feed fails,
    # fetch its Google News site search instead, at most about once an hour per outlet.
    out = []
    for o, items, err, secs in res:
        if err and o["via"] != "google" and fallback_due(o, status):
            site = urllib.parse.urlsplit(o["homepage"]).netloc.removeprefix("www.")
            time.sleep(GOOGLE_GAP)
            o2, items2, err2, secs2 = poll(dict(o, feed=GOOGLE_SEARCH + site), {})
            if items2:
                FELL_BACK[o["id"]] = err
                out.append((o, items2, None, secs + secs2))
                continue
        out.append((o, items, err, secs))
    return out


GOOGLE_SEARCH = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=when:1d+site:"
FELL_BACK = {}  # outlet id -> the error its own feed gave, for outlets collected through the fallback this run


def fallback_due(o, status):
    last = (status.get("outlets", {}).get(o["id"]) or {}).get("fallback_at")
    return not last or NOW - when(last) >= dt.timedelta(minutes=GOOGLE_EVERY)


# ---------------------------------------------------------------- photos

OG = re.compile(r"<meta\b[^>]*(?:property|name)=[\"'](?:og:image(?::secure_url)?|twitter:image(?::src)?)[\"'][^>]*>", re.I)


def og_image(url):
    """The article's own preview image (what a link preview shows), read from the first 300 KB of the page."""
    try:
        page = get(url, accept="text/html,*/*", timeout=12)[:300_000].decode("utf-8", "replace")
    except Exception:
        return None
    for tag in OG.findall(page):
        m = re.search(r"content=[\"']([^\"']+)", tag, re.I)
        if m:
            return urllib.parse.urljoin(url, html.unescape(m.group(1).strip()))
    return None


def fix_img(u, page):
    if not u:
        return None
    u = html.unescape(u.strip())
    if u.startswith("//"):
        u = "https:" + u
    u = urllib.parse.urljoin(page, u)
    return u.replace("http://", "https://", 1) if u.startswith("http://") else u


# ---------------------------------------------------------------- categories (rules in categories.json, no AI)

def has(word, text_):
    return re.search(r"\b%s\b" % re.escape(word), text_) is not None


def categories_of(story, outlet):
    """Every category whose rules match, each with the first reason found, checked in order: the outlet's own
    section tags, the web address, keywords in the headline. Returns (ids, whys); a why is a short code the page
    turns into a sentence: t:<section tag>, p:<web address part>, k:<keyword>, w:<country named> (World),
    f (outlet based outside the US, no US place named: World), u (US outlet, no other country named)."""
    tags = [t.lower() for t in story.get("tags", [])]
    path = "" if "news.google.com" in story["u"] else urllib.parse.urlsplit(story["u"]).path.lower() + "/"
    title = story["t"].lower().replace("\u2019", "'")
    ids, whys = [], []
    for c in CATS:
        why = next(("t:" + story["tags"][i] for i, t in enumerate(tags) for w in c["tags"] if has(w, t)), None) \
            or next(("p:" + seg for seg in c["paths"] if "/%s/" % seg in path), None) \
            or next(("k:" + w for w in c["keywords"] if has(w, title)), None)
        if why:
            ids.append(c["id"]); whys.append(why)
    named = places_in(story["t"])
    foreign = sorted(p for p in named if p not in US_STATES)
    if foreign and "world" not in ids:
        ids.append("world"); whys.append("w:" + foreign[0])
    elif outlet.get("country") not in (None, "United States") and not (named & US_STATES) and "world" not in ids:
        ids.append("world"); whys.append("f")  # f: the outlet is based outside the US, and no US place is named
    if not foreign and outlet.get("country") == "United States" and "us" not in ids:
        ids.append("us"); whys.append("u")
    return ids, whys


# ---------------------------------------------------------------- grouping the same story (no AI)

STOP = set("""a about above after again against all also am amid an and any are as at be because been before being below
between both but by can could did do does doing down during each few for from further had has have having he her here hers
him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she
should so some such than that the their them then there these they this those through to too under until up very was we were
what when where which while who whom why will with would you your says said say new news live latest update updates breaking
watch video videos photo photos report reports year years week day days today yesterday tomorrow first one two three may
might must get gets got make makes made take takes took back still via per amp vs us""".split())


def stem(w):
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 5 and w.endswith("ing"):
        return w[:-3]
    if len(w) > 4 and w.endswith("ed"):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


# Spellings and short forms that mean the same thing, so "Kiev" matches "Kyiv" when grouping stories.
SAME = {"kiev": "kyiv", "kharkov": "kharkiv", "odessa": "odesa", "peking": "beijing", "bombay": "mumbai",
        "burma": "myanmar", "turkiye": "turkey", "czechia": "czech", "uae": "emirates",
        "un": "united-nations", "nato's": "nato", "irgc": "revolutionary-guard", "idf": "israeli-military",
        "gop": "republican", "potus": "trump", "scotus": "supreme-court", "fed's": "fed", "ev": "electric-vehicle",
        "evs": "electric-vehicle", "ai's": "ai", "dprk": "north-korea", "prc": "china"}


DATES = set("january february march april may june july august september october november december jan feb mar apr jun jul aug "
            "sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday".split())


def words(s):
    """Distinctive words of a headline. Dates are left out: newsletters all say "October 14, 2026", which says
    nothing about what they cover. Other numbers stay (3.7%, 2,500 containers)."""
    s = re.sub(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b", " ", s.lower())
    return [SAME.get(w) or stem(w) for w in re.findall(r"[a-z0-9]+", s.replace("’", "'").replace("'s ", " "))
            if (len(w) > 2 or w.isdigit() or w in SAME) and w not in STOP and w not in DATES and not re.fullmatch(r"(19|20)\d\d", w)]


def tf(story):
    c = Counter()
    for w in words(story["t"]):
        c[w] += 2  # the headline counts double
    for w in words(story.get("x", ""))[:30]:
        c[w] += 1
    return c


def vectors(counts, max_df):
    """TF-IDF vectors, normalised to length 1. Words in more than max_df of the documents are ignored."""
    n = len(counts)
    df = Counter(w for c in counts for w in c)
    limit = max(3, int(n * max_df))
    idf = {w: math.log((n + 1) / (d + 1)) + 1 for w, d in df.items() if d <= limit}
    out = []
    for c in counts:
        v = {w: k * idf[w] for w, k in c.items() if w in idf}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        out.append({w: x / norm for w, x in v.items()})
    return out


def cos(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(w, 0.0) for w, x in a.items())


def candidates(vecs, max_post=400, near=None):
    """Pairs of documents that share at least two distinctive words (an inverted index, so it stays fast)."""
    post = defaultdict(list)
    for i, v in enumerate(vecs):
        for w in v:
            post[w].append(i)
    shared = Counter()
    for ids in post.values():
        if len(ids) < 2 or len(ids) > max_post:
            continue
        for a in range(len(ids)):
            for b in range(a + 1, len(ids)):
                if near is None or near(ids[a], ids[b]):
                    shared[(ids[a], ids[b])] += 1
    return [p for p, k in shared.items() if k >= 2]


US_STATES = {  # places.json also lists US states; naming one doesn't make a story World news
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
    "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
    "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire",
    "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
    "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
    "washington", "west virginia", "wisconsin", "wyoming", "puerto rico"}


def places_in(title):
    return {PLACES[m] for m in PLACE_RE.findall(title.lower().replace("\u2019", "'"))}


def group(vecs, owners, pair_min=PAIR_MIN, group_min=GROUP_MIN, near=None, places=None, cities=None):
    """Join documents into groups. Strongest matches first; a join happens only when the two documents come
    from different outlets (owners) that aren't already both in the group, and when the two groups also
    match as wholes (their average word lists), so groups don't snowball. Returns a group number per document."""
    pairs = []
    for a, b in candidates(vecs, near=near):
        if owners[a] & owners[b]:
            continue
        s = cos(vecs[a], vecs[b])
        if cities and cities[a] and cities[b] and cities[a] != cities[b] and s < LOCAL_MIN:
            continue  # two local outlets in different cities: "county commissioner" here isn't the one there
        if s >= pair_min:
            pairs.append((s, a, b))
    pairs.sort(reverse=True)
    parent = list(range(len(vecs)))
    members = {i: [i] for i in range(len(vecs))}
    own = {i: set(owners[i]) for i in range(len(vecs))}
    where = {i: set(places[i]) if places else set() for i in range(len(vecs))}
    cent = {i: dict(vecs[i]) for i in range(len(vecs))}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for s, a, b in pairs:
        ra, rb = find(a), find(b)
        if ra == rb or own[ra] & own[rb]:
            continue
        if where[ra] and where[rb] and not where[ra] & where[rb]:  # both name places, none in common
            continue
        ca, cb = cent[ra], cent[rb]
        na = math.sqrt(sum(x * x for x in ca.values())) or 1.0
        nb = math.sqrt(sum(x * x for x in cb.values())) or 1.0
        if cos(ca, cb) / (na * nb) < group_min:
            continue
        if len(members[ra]) < len(members[rb]):
            ra, rb = rb, ra
        parent[rb] = ra
        members[ra] += members.pop(rb)
        own[ra] |= own.pop(rb)
        where[ra] |= where.pop(rb)
        keep = cent[ra]
        for w, x in cent.pop(rb).items():
            keep[w] = keep.get(w, 0.0) + x
    return [find(i) for i in range(len(vecs))]


def city_of(outlet_id):
    """The city of a local or regional outlet, for the LOCAL_MIN rule; None for national and international outlets."""
    o = OUTLETS_BY_ID.get(outlet_id, {})
    if o.get("labels", {}).get("scope") in ("local", "regional"):
        return "/".join(o.get("place", [])[1:])
    return None


def group_day(stories):
    """Give every story an event id ("c"): stories about the same event from different outlets share one."""
    if not stories:
        return
    vecs = vectors([tf(s) for s in stories], max_df=0.05)
    roots = group(vecs, [{s["o"]} for s in stories], places=[places_in(s["t"]) for s in stories],
                  cities=[city_of(s["o"]) for s in stories])
    size = Counter(roots)
    name = {}  # a group is named after its smallest story id, so the name stays stable between runs
    for s, r in zip(stories, roots):
        name[r] = min(name.get(r, s["id"]), s["id"])
    for s, r in zip(stories, roots):
        s.pop("rep", None)
        s["c"] = name[r] if size[r] > 1 else s["id"]  # every story has an event id; a lone story is its own event
    mark_reprints(stories)


def mark_reprints(stories):
    """Outlets often run a wire story word for word. Within a group, a story whose headline exactly matches an
    earlier one is marked rep=<outlet it repeats> (a wire service if one ran it), so the page can count it or not."""
    wire = {o["id"] for o in OUTLETS["outlets"] if "Wire" in (o.get("media") or [o.get("type")])}
    same = defaultdict(list)
    for s in stories:
        if s.get("c"):
            same[(s["c"], norm_title(s["t"]))].append(s)
    for copies in same.values():
        if len({s["o"] for s in copies}) < 2:
            continue
        copies.sort(key=lambda s: (s["o"] not in wire, s["at"]))
        for s in copies[1:]:
            if s["o"] != copies[0]["o"]:
                s["rep"] = copies[0]["o"]


# ---------------------------------------------------------------- storage

def day_of(t):
    return t.astimezone(ET_TZ).date().isoformat()


def day_path(d):
    return os.path.join(DATA, "days", d + ".json")


EXTRA = os.path.join(ROOT, "data", "extra")  # fields the collector needs but the page doesn't: never published
INTERNAL = ("tags", "ti")                   # the outlet's section names (for categories); photo lookup tried


def load_day(d):
    doc = load(day_path(d), {"date": d, "stories": []})
    extra = load(os.path.join(EXTRA, d + ".json"), {})
    for s in doc["stories"]:
        s.update(extra.get(s["id"], {}))
    return doc


def save_day(d, stories):
    extra = {s["id"]: {k: s[k] for k in INTERNAL if k in s} for s in stories if any(k in s for k in INTERNAL)}
    save(os.path.join(EXTRA, d + ".json"), extra)
    return save(day_path(d), {"date": d, "stories": [{k: v for k, v in s.items() if k not in INTERNAL} for s in stories]})


def load(path, default):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save(path, obj):
    """Write only when the content changed. Returns True when it did."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    try:
        if open(path, encoding="utf-8").read() == new:
            return False
    except OSError:
        pass
    open(path, "w", encoding="utf-8").write(new)
    return True


def iso(t):
    return t.isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------- roundups (week, month, year)

def period_ids(d):
    d = dt.date.fromisoformat(d)
    y, w, _ = d.isocalendar()
    return {"week": "%d-W%02d" % (y, w), "month": d.strftime("%Y-%m"), "year": str(d.year)}


def days_in(kind, pid, available):
    return sorted(d for d in available if period_ids(d)[kind] == pid)


def link_groups(items, day_index, gap=LINK_DAYS):
    """items: lists of stories, one list per group. Joins the same story across periods (days, or months for the
    year) that are at most `gap` apart. Groups from the same period never merge: that was already decided."""
    counts = [sum((tf(s) for s in g), Counter()) for g in items]
    vecs = vectors(counts, max_df=0.02)
    owners = [{day_index[i]} for i in range(len(items))]
    near = lambda a, b: abs(day_index[a] - day_index[b]) <= gap
    places = [set().union(*(places_in(s["t"]) for s in g)) for g in items]
    return group(vecs, owners, pair_min=0.35, group_min=0.30, near=near, places=places)


def common_cats(stories):
    """Categories that at least a third of a group's stories carry (at least one category)."""
    n = Counter(c for s in stories for c in s.get("cat", []))
    keep = [c for c, k in n.most_common() if k * 3 >= len(stories)]
    return keep or [c for c, _ in n.most_common(1)]


def counted(stories):
    """The outlets a group counts toward coverage: a reprint counts as the outlet it repeats."""
    return {s.get("rep") or s["o"] for s in stories}


def events(stories):
    """Event id -> its stories, only for events covered by at least two outlets."""
    by_c = defaultdict(list)
    for s in stories:
        if s.get("c"):
            by_c[s["c"]].append(s)
    return {c: ss for c, ss in by_c.items() if len({s["o"] for s in ss}) > 1}


def build_digest(d):
    """The day's top stories by coverage (reprints count as the original), as data and as plain text."""
    meta = {o["id"]: o for o in OUTLETS["outlets"]}
    wire = {o["id"] for o in OUTLETS["outlets"] if "Wire" in (o.get("media") or [o.get("type")])}
    by_c = events(load(day_path(d), {}).get("stories", []))
    groups = []
    for cid, ss in by_c.items():
        ss.sort(key=lambda s: s["at"])
        lead = next((s for s in ss if s["o"] in wire), ss[0])
        groups.append({"id": cid, "n": len(counted(ss)), "t": lead["t"], "cat": common_cats(ss),
                       "s": [{"o": s["o"], "t": s["t"], "u": s["u"], **({"rep": s["rep"]} if s.get("rep") else {})} for s in ss]})
    groups.sort(key=lambda g: (-g["n"], g["id"]))
    top = groups[:DIGEST_KEEP]
    total = len({s["o"] for ss in by_c.values() for s in ss})
    day = dt.date.fromisoformat(d)
    lines = ["COVERAGE INDEX: %s" % day.strftime("%A, %B %-d, %Y"),
             "The %d stories covered by the most outlets. Reprints of another outlet's story count as the original." % len(top), ""]
    for i, g in enumerate(top, 1):
        lines.append("%d. %s" % (i, g["t"]))
        lines.append("   Covered by %d outlets." % g["n"])
        for x in g["s"]:
            lines.append("   - %s: %s%s" % (meta.get(x["o"], {}).get("name", x["o"]), x["t"],
                                         " (reprint of %s)" % meta.get(x["rep"], {}).get("name", x["rep"]) if x.get("rep") else ""))
        lines.append("   https://chrisqtruong.github.io/coverage-index/#d=%s&c=%s" % (d, g["id"]))
        lines.append("")
    return {"date": d, "outlets": total, "groups": top}, "\n".join(lines)


def build_roundup(kind, pid, available):
    days = days_in(kind, pid, available)
    items, day_index = [], []
    for k, d in enumerate(days):
        for g in events(load(day_path(d), {}).get("stories", [])).values():
            items.append(g)
            day_index.append(k)
    return finish_roundup(kind, pid, days, items, link_groups(items, day_index) if items else [])


def build_year(pid):
    """The year, built from its month roundups (reading every day of a year each run would get slow).
    Each month keeps its top ROUNDUP_KEEP events, so an event that never made a month's top list is left out."""
    months = sorted(f[:-5] for f in os.listdir(os.path.join(DATA, "roundups", "month")) if f.startswith(pid + "-"))
    items, month_index, days = [], [], []
    for k, m in enumerate(months):
        r = load(os.path.join(DATA, "roundups", "month", m + ".json"), {})
        days += r.get("days", [])
        for g in r.get("groups", []):
            items.append([dict(x, cat=g.get("cat", [])) for x in g["s"]])
            month_index.append(k)
    return finish_roundup("year", pid, days, items, link_groups(items, month_index, gap=1) if items else [])


def finish_roundup(kind, pid, days, items, roots):
    merged = defaultdict(list)
    for g, r in zip(items, roots):
        merged[r] += g
    out = []
    for stories in merged.values():
        per = {}
        for s in sorted(stories, key=lambda s: s["at"]):
            per.setdefault(s["o"], s)  # each outlet once: its first story on this
        if len(per) < 2:
            continue
        ss = sorted(per.values(), key=lambda s: s["at"])
        out.append({"id": ss[0]["id"], "n": len(per), "at": ss[0]["at"], "last": max(s["at"] for s in stories),
                    "cat": common_cats(ss),
                    "s": [{k: s[k] for k in ("id", "o", "t", "u", "at", "img", "rep") if s.get(k)} for s in ss]})
    out.sort(key=lambda g: (-g["n"], g["at"]))
    return {"kind": kind, "id": pid, "days": days, "groups": out[:ROUNDUP_KEEP]}


# ---------------------------------------------------------------- the run

def main():
    args = set(sys.argv[1:])
    test, offline = "--test" in args, "--offline" in args
    outlets = {o["id"]: o for o in OUTLETS["outlets"]}
    status_path = os.path.join(DATA, "status.json")
    status = load(status_path, {"outlets": {}})
    today = day_of(NOW)
    yesterday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
    cutoff = dt.datetime.fromisoformat(yesterday).replace(tzinfo=ET_TZ)
    days = {d: load_day(d) for d in (yesterday, today)}
    by_id = {s["id"]: (d, s) for d, doc in days.items() for s in doc["stories"]}
    seen_t = {(s["o"], norm_title(s["t"])) for doc in days.values() for s in doc["stories"]}
    new, report = [], []
    cache = load(CACHE, {})
    for o in outlets.values():
        if not o.get("available", True):
            status["outlets"][o["id"]] = {"ok": False, "err": o.get("why_unavailable", "No working feed."), "unavailable": True}

    if "--digest" in args:
        d = sys.argv[sys.argv.index("--digest") + 1]
        data, txt = build_digest(d)
        save(os.path.join(DATA, "digest", d + ".json"), data)
        open(os.path.join(DATA, "digest", d + ".txt"), "w", encoding="utf-8").write(txt)
        print(txt)
        return

    if not offline:
        for o, items, err, secs in poll_all(list(outlets.values()), cache, {} if test else status):
            st = status["outlets"].setdefault(o["id"], {})
            st["checked"] = iso(NOW)
            if items == []:  # 304: nothing new since the last run
                st.update(ok=True, err=None, last_ok=iso(NOW), new=0)
                report.append((o["id"], "same", 0, 0, secs, ""))
                continue
            if err:
                st.update(ok=False, err=err)
                report.append((o["id"], "FAIL", 0, 0, secs, err))
                continue
            if o["id"] in FELL_BACK:
                st.update(fallback_at=iso(NOW), fallback_reason=FELL_BACK[o["id"]][:120])
            added = 0
            for pos, f in enumerate(items):
                at = f.get("at") or NOW
                if at > NOW + dt.timedelta(hours=1):
                    at = NOW
                if at < cutoff:
                    continue
                nu = norm_url(f["u"])
                sid = hashlib.sha1(nu.encode()).hexdigest()[:12]
                rank = None if o["via"] == "google" or o["id"] in FELL_BACK else pos + 1  # 1 = top of the outlet's own feed; Google's order isn't the outlet's
                if sid in by_id:  # seen before: keep its best position in the outlet's feed
                    s = by_id[sid][1]
                    if rank:
                        s["r"] = min(s.get("r", rank), rank)
                    continue
                if o.get("source") and f.get("via_o") and f["via_o"] != o["source"]:
                    continue  # a Google News search can return a sister site too (Ahram Online's Arabic edition)
                t = clean_title(f["t"], f.get("via_o"), o["name"])[:240]
                if is_junk(t):
                    continue
                key = (o["id"], norm_title(t))
                if not key[1] or key in seen_t:
                    continue
                seen_t.add(key)
                s = {"id": sid, "o": o["id"], "t": t, "u": f["u"], "at": iso(at)}
                if rank:
                    s["r"] = rank
                if f.get("x") and norm_title(f["x"]) != norm_title(t):
                    s["x"] = f["x"]
                if f.get("tags"):
                    s["tags"] = f["tags"]
                if f.get("img"):
                    s["img"] = fix_img(f["img"], f["u"])
                d = day_of(at)
                if d not in days:
                    continue
                days[d]["stories"].append(s)
                by_id[sid] = (d, s)
                new.append(s)
                added += 1
            st.update(ok=True, err=None, last_ok=iso(NOW), n=len(items), new=added, via_fallback=o["id"] in FELL_BACK)
            report.append((o["id"], "ok", len(items), added, secs, ""))
        if not test:
            save(CACHE, cache)

        if test:
            w = max(len(r[0]) for r in report)
            for r in sorted(report, key=lambda r: (r[1] != "FAIL", r[0])):
                print("%-*s %-4s items=%-4d new=%-4d %5.1fs %s" % (w, r[0], r[1], r[2], r[3], r[4], r[5]))
            print("outlets=%d ok=%d unchanged=%d failed=%d new_stories=%d" % (
                len(report), sum(r[1] == "ok" for r in report), sum(r[1] == "same" for r in report),
                sum(r[1] == "FAIL" for r in report), len(new)))
            return

        # Photos: for direct feeds, read the article's own preview image when the feed didn't include one.
        # Newest first, PHOTO_FETCHES per run; each story is tried once ("ti"), so a backlog clears over a few runs.
        want = sorted((s for doc in days.values() for s in doc["stories"]
                       if not s.get("img") and not s.get("ti") and outlets.get(s["o"], {}).get("via") == "rss"),
                      key=lambda s: s["at"], reverse=True)[:PHOTO_FETCHES]
        with cf.ThreadPoolExecutor(12) as ex:
            for s, img in zip(want, ex.map(lambda s: og_image(s["u"]), want)):
                s["ti"] = 1
                if img:
                    s["img"] = fix_img(img, s["u"])

    for doc in days.values():
        o_names = {k: v["name"] for k, v in outlets.items()}
        for s in doc["stories"]:
            s["t"] = clean_title(s["t"], None, o_names.get(s["o"]))
        doc["stories"] = drop_repeats([s for s in doc["stories"] if not is_junk(s["t"])])
        for s in doc["stories"]:
            s.pop("topic", None)
            s["cat"], s["why"] = categories_of(s, outlets.get(s["o"], {}))
        doc["stories"].sort(key=lambda s: s["at"], reverse=True)
        group_day(doc["stories"])

    changed = False
    for d, doc in days.items():
        if doc["stories"]:
            changed |= save_day(d, doc["stories"])

    available = sorted(f[:-5] for f in os.listdir(os.path.join(DATA, "days")) if f.endswith(".json")) \
        if os.path.isdir(os.path.join(DATA, "days")) else []
    roundups = {}
    for kind in ("week", "month", "year"):
        pids = sorted({period_ids(d)[kind] for d in available})
        roundups[kind] = pids
        build = (lambda pid: build_year(pid)) if kind == "year" else (lambda pid: build_roundup(kind, pid, available))
        for pid in {period_ids(d)[kind] for d in (yesterday, today) if d in available} or set():
            changed |= save(os.path.join(DATA, "roundups", kind, pid + ".json"), build(pid))
        for pid in pids:  # build any roundup that doesn't exist yet (first run, or after --offline changes)
            p = os.path.join(DATA, "roundups", kind, pid + ".json")
            if not os.path.exists(p):
                changed |= save(p, build(pid))

    # The digest: once it's past DIGEST_HOUR Eastern, yesterday is finished, so write its digest (once).
    if NOW.astimezone(ET_TZ).hour >= DIGEST_HOUR and yesterday in available:
        p = os.path.join(DATA, "digest", yesterday + ".json")
        if not os.path.exists(p):
            data, txt = build_digest(yesterday)
            changed |= save(p, data)
            open(os.path.join(DATA, "digest", yesterday + ".txt"), "w", encoding="utf-8").write(txt)
    digests = sorted(f[:-5] for f in os.listdir(os.path.join(DATA, "digest")) if f.endswith(".json")) \
        if os.path.isdir(os.path.join(DATA, "digest")) else []

    counts = {d: len(load(day_path(d), {}).get("stories", [])) for d in available[-60:]}
    index = {"days": available, "counts": counts, "roundups": roundups, "digests": digests}
    changed |= save(os.path.join(DATA, "index.json"), index)
    # The page only sees docs/, so publish the outlet list and category names there.
    meta = {k: v for k, v in OUTLETS.items() if k != "outlets"}
    meta["outlets"] = [{k: v for k, v in o.items() if k not in ("feed",)} for o in OUTLETS["outlets"]]
    meta["categories"] = [{"id": c["id"], "name": c["name"]} for c in CATS]
    # The settings the method page quotes, published from the code itself so the page can't drift from it.
    meta["method"] = {"pair_min": PAIR_MIN, "group_min": GROUP_MIN, "link_days": LINK_DAYS, "summary_chars": SUMMARY,
                      "photo_fetches": PHOTO_FETCHES, "google_gap_s": GOOGLE_GAP, "roundup_keep": ROUNDUP_KEEP,
                      "digest_hour_et": DIGEST_HOUR, "digest_keep": DIGEST_KEEP, "user_agent": UA,
                      "places": len(PLACES), "categories": len(CATS)}
    changed |= save(os.path.join(DATA, "meta.json"), meta)
    if changed or not offline:
        status["updated"] = iso(NOW)
        if os.environ.get("GITHUB_RUN_ID"):  # link each update to its public run log and commit
            repo = os.environ.get("GITHUB_REPOSITORY", "chrisqtruong/coverage-index")
            status["run"] = {"id": os.environ["GITHUB_RUN_ID"], "sha": os.environ.get("GITHUB_SHA", ""),
                             "url": "https://github.com/%s/actions/runs/%s" % (repo, os.environ["GITHUB_RUN_ID"])}
        status["outlets"] = {k: v for k, v in status["outlets"].items() if k in outlets}
        changed |= save(status_path, status)

    line = "changed=%s" % str(changed).lower()
    print(line, "new=%d" % len(new), "today=%d" % len(days[today]["stories"]),
          "events_today=%d" % len(events(days[today]["stories"])))
    if os.environ.get("GITHUB_OUTPUT"):
        open(os.environ["GITHUB_OUTPUT"], "a").write(line + "\n")


if __name__ == "__main__":
    main()
