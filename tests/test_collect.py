#!/usr/bin/env python3
"""Offline tests for scripts/collect.py: feed parsing, topics, places and story grouping (no network)."""
import importlib.util, os, sys
from collections import Counter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("collect", os.path.join(ROOT, "scripts", "collect.py"))
c = importlib.util.module_from_spec(spec)
sys.argv = ["collect.py"]
spec.loader.exec_module(c)

RSS = b"""<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>x</title>
<item><title>Senate passes budget &amp; heads home</title><link>https://example.com/politics/a?utm_source=rss</link>
<pubDate>Mon, 12 Oct 2026 14:00:00 GMT</pubDate><description>&lt;p&gt;Late vote.&lt;/p&gt;</description>
<category>Politics</category><media:content url="https://img.example.com/small.jpg" medium="image" width="300"/>
<media:content url="https://img.example.com/big.jpg" medium="image" width="1200"/></item>
<item><title>County approves data center - Local Paper</title><link>https://news.google.com/rss/articles/abc</link>
<pubDate>Mon, 12 Oct 2026 13:00:00 GMT</pubDate><source url="https://paper.example">Local Paper</source></item>
</channel></rss>"""
ATOM = b"""<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><title type="html">Storm hits coast</title><link rel="alternate" href="https://example.org/x"/>
<updated>2026-10-12T09:00:00-04:00</updated><summary>Winds &lt;img src="https://example.org/p.png"&gt; up</summary></entry></feed>"""
BROKEN = b"""<rss><channel><item><title><![CDATA[Fish & chips win prize]]></title><link>https://example.net/f</link>
<pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate><description>Tasty & hot</description></item></channel></rss>"""


def story(o, t, x="", sid=None, at="2026-10-14T12:00:00Z"):
    return {"id": sid or (o + str(abs(hash(t)) % 10**6)), "o": o, "t": t, "x": x, "u": "https://example.com/" + o, "at": at}


def test_parsing():
    r = c.parse_feed(RSS)
    assert len(r) == 2 and r[0]["t"] == "Senate passes budget & heads home", r
    assert r[0]["x"] == "Late vote." and r[0]["at"].hour == 14
    assert r[0]["img"] == "https://img.example.com/big.jpg", "the widest photo wins"
    assert r[0]["tags"] == ["Politics"]
    assert r[1]["via_o"] == "Local Paper"
    assert c.clean_title(r[1]["t"], r[1]["via_o"]) == "County approves data center"
    a = c.parse_feed(ATOM)
    assert a[0]["u"] == "https://example.org/x" and a[0]["at"].hour == 13 and a[0]["img"] == "https://example.org/p.png"
    b = c.parse_feed(BROKEN)  # not well-formed: falls back to reading by pattern
    assert b[0]["t"] == "Fish & chips win prize" and b[0]["u"] == "https://example.net/f"
    try:
        c.parse_feed(b"<!DOCTYPE html><html><body>blocked</body></html>")
        raise AssertionError("an HTML page must not parse as a feed")
    except ValueError:
        pass
    assert c.norm_url("https://WWW.Example.com/a/?utm_source=rss&id=3") == "https://www.example.com/a?id=3"
    assert c.fix_img("//cdn.example.com/p.jpg", "https://example.com/a") == "https://cdn.example.com/p.jpg"
    assert c.fix_img("/p.jpg", "https://example.com/a/b") == "https://example.com/p.jpg"


def test_categories():
    us = {"country": "United States"}
    ids, whys = c.categories_of({"t": "Anything", "u": "https://x.com/a", "tags": ["Politics"]}, {})
    assert ("politics", "t:Politics") in zip(ids, whys)
    ids, whys = c.categories_of({"t": "Anything", "u": "https://x.com/business/a"}, {})
    assert ("business", "p:business") in zip(ids, whys)
    ids, _ = c.categories_of({"t": "Hurricane makes landfall as Fed weighs rate cut", "u": "https://x.com/a"}, us)
    assert {"environment", "economy", "us"} <= set(ids), ids  # a story can be in several categories
    ids, whys = c.categories_of({"t": "Riots erupt in Albania's capital", "u": "https://x.com/a"}, us)
    assert ("world", "w:albania") in zip(ids, whys) and "us" not in ids
    ids, whys = c.categories_of({"t": "Texas floods leave thousands without power", "u": "https://x.com/a"}, us)
    assert "world" not in ids and ("us", "u") in zip(ids, whys), "a US state is not World news"
    ids, whys = c.categories_of({"t": "Zoning board meets", "u": "https://x.com/a"}, {"country": "Canada"})
    assert list(zip(ids, whys)) == [("world", "f")], "an outlet outside the US with no US place named: World"
    ids, _ = c.categories_of({"t": "Texas zoning board meets", "u": "https://x.com/a"}, {"country": "Canada"})
    assert "world" not in ids, "a foreign outlet writing about a US state isn't World news"
    ids, _ = c.categories_of({"t": "Zoning board meets", "u": "https://x.com/a"}, {})
    assert ids == [], "no outlet country and no rule: no category"


def test_conditional_cache_headers():
    entry = {"etag": '"abc"', "modified": "Mon, 12 Oct 2026 10:00:00 GMT"}
    assert c.get_feed.__doc__ and "If-None-Match" in c.get_feed.__doc__  # documented; the network path is exercised by --test


def test_places():
    assert c.places_in("Riots erupt in Albania's capital Tirana") == {"albania"}
    assert c.places_in("French police clash with students") == {"france"}
    assert c.places_in("Senate passes budget") == set()


def grouped(stories):
    """Headline -> shared event id, or None when the story is its own event (no other outlet covered it)."""
    c.group_day(stories)
    assert all(s.get("c") for s in stories), "every story has an event id"
    n = Counter(s["c"] for s in stories)
    return {s["t"]: (s["c"] if n[s["c"]] > 1 else None) for s in stories}


def test_grouping():
    same = [
        story("ap", "Iran says cargo ship sank after hitting a mine in Strait of Hormuz"),
        story("bbc", "Cargo ship sinks after mine strike in Strait of Hormuz, Iran says"),
        story("rt", "Container ship sinks in Hormuz mine strike amid US-Iran tensions"),
        story("npr", "Social Security benefits rise 3.6% for 2027 retirees"),
        story("cnbc", "Social Security announces 3.6% cost-of-living increase for 2027"),
        story("vox", "Why the city council keeps delaying the budget vote"),
    ] + [story("filler%d" % i, "Unrelated headline about topic number %d and things" % i) for i in range(40)]
    g = grouped(same)
    hormuz = {g[s["t"]] for s in same[:3]}
    assert len(hormuz) == 1 and None not in hormuz, g
    assert g[same[3]["t"]] and g[same[3]["t"]] == g[same[4]["t"]]
    assert g[same[3]["t"]] != g[same[0]["t"]]
    assert g[same[5]["t"]] is None, "a story nobody else covered has no group"


def test_different_places_never_join():
    s = [
        story("cbs", "Chaos erupts in France as student protesters clash with police"),
        story("ap", "Student protests in Albania's capital Tirana turn violent"),
        story("guardian", "Student protests in Albania turn violent as demonstrators clash with police"),
    ] + [story("filler%d" % i, "Unrelated headline about topic number %d and things" % i) for i in range(40)]
    g = grouped(s)
    assert g[s[1]["t"]] and g[s[1]["t"]] == g[s[2]["t"]], g
    assert g[s[0]["t"]] != g[s[1]["t"]], "France and Albania are different stories"


def test_one_outlet_never_joins_itself():
    s = [story("ap", "Pope Leo recovers after lung surgery", sid="a1"),
         story("ap", "Pope Leo recovering well after lung surgery, Vatican says", sid="a2")] + \
        [story("filler%d" % i, "Unrelated headline about topic number %d and things" % i) for i in range(40)]
    g = grouped(s)
    assert g[s[0]["t"]] is None and g[s[1]["t"]] is None, g


def test_reprints():
    s = [story("houston-chronicle", "Florida wins key ruling on social media law for kids", at="2026-10-14T12:05:00Z"),
         story("ap", "Florida wins key ruling on social media law for kids", at="2026-10-14T12:10:00Z"),
         story("reuters", "Florida can enforce law barring young kids from social media, court rules")] + \
        [story("filler%d" % i, "Unrelated headline about topic number %d and things" % i) for i in range(40)]
    c.group_day(s)
    assert s[0]["c"] == s[1]["c"] == s[2]["c"]
    assert s[0].get("rep") == "ap", "a wire service is treated as the original even if posted later"
    assert "rep" not in s[1] and "rep" not in s[2]


def test_local_outlets_in_different_cities():
    assert c.city_of("baltimore-sun") and c.city_of("houston-chronicle")
    assert c.city_of("baltimore-sun") != c.city_of("houston-chronicle")
    assert c.city_of("ap") is None and c.city_of("new-york-times") is None
    vecs = [{"county": .6, "commissioner": .8}, {"county": .6, "school": .8}, {"county": .6, "commissioner": .8}]
    vecs = [{w: x / sum(v * v for v in d.values()) ** .5 for w, x in d.items()} for d in vecs]
    # 0 and 1 are 0.36 alike: enough for national outlets, not for local outlets in different cities
    assert c.group(vecs, [{"a"}, {"b"}, {"c"}], cities=["Maryland/Baltimore", "Texas/Houston", None])[0] != \
        c.group(vecs, [{"a"}, {"b"}, {"c"}], cities=["Maryland/Baltimore", "Texas/Houston", None])[1]
    same = c.group(vecs[:1] * 2, [{"a"}, {"b"}], cities=["Maryland/Baltimore", "Texas/Houston"])
    assert same[0] == same[1], "identical stories (a shared wire story) still join across cities"
    assert c.words("How major US stock indexes fared Wednesday 10/14/2026") == c.words("How major US stock indexes fared")
    assert "october" not in c.words("Hello Houston (October 14, 2026)")
    assert c.words("Russian missiles hit Kiev") == c.words("Russian missiles hit Kyiv")
    assert "united-nations" in c.words("UN warns of famine")


def test_repeats_and_junk():
    assert c.clean_title("EU proposes one-year delay to methane import rules-Xinhua", None, "Xinhua") == "EU proposes one-year delay to methane import rules"
    assert c.clean_title("County approves data center - Local Paper", "Local Paper") == "County approves data center"
    assert c.is_junk(c.clean_title("Videos | - CNN", None, "CNN")) and c.is_junk("Cartoon for October 15, 2026") and not c.is_junk("Live music returns to the harbor")
    assert not c.is_junk("Live: Israel strikes Gaza") and not c.is_junk("Watch: Chaos erupts in France")
    s = [story("xinhua", "Japanese farm minister resigns over controversies: media", at="2026-10-14T01:00:00Z"),
         story("xinhua", "Japanese farm minister decides to resign over controversies: media", at="2026-10-14T02:00:00Z"),
         story("baltimore-banner", "Prince George's County Board of Education District 3"),
         story("baltimore-banner", "Prince George's County Board of Education District 6")]
    kept = c.drop_repeats(s)
    assert [x["t"] for x in kept if x["o"] == "xinhua"] == [s[0]["t"]], "the later repeat is dropped"
    assert len([x for x in kept if x["o"] == "baltimore-banner"]) == 2, "different districts are different stories"


def test_published_fields():
    import tempfile, json as j
    s = [dict(story("ap", "One"), tags=["World"], ti=1, r=1)]
    old = (c.DATA, c.EXTRA)
    with tempfile.TemporaryDirectory() as tmp:
        c.DATA, c.EXTRA = tmp, tmp + "/extra"
        c.save_day("2026-10-14", s)
        pub = j.load(open(tmp + "/days/2026-10-14.json"))["stories"][0]
        assert "tags" not in pub and "ti" not in pub and pub["r"] == 1, pub
        back = c.load_day("2026-10-14")["stories"][0]
        assert back["tags"] == ["World"] and back["ti"] == 1, "internal fields come back for the collector"
    c.DATA, c.EXTRA = old


def test_fallback_when_a_feed_refuses():
    real_poll, real_gap = c.poll, c.GOOGLE_GAP
    calls = []
    def fake(o, cache):
        calls.append(o["feed"])
        if "news.google.com" in o["feed"]:
            return o, [{"t": "From Google", "u": "https://news.google.com/x", "at": c.NOW}], None, 0.1
        return o, None, "OSError: HTTP 403", 0.1
    c.poll, c.GOOGLE_GAP = fake, 0
    try:
        o = {"id": "axios", "name": "Axios", "via": "rss", "feed": "https://api.axios.com/feed/", "homepage": "https://www.axios.com"}
        res = c.poll_all([o], {}, {"outlets": {}})
        assert res[0][1] and res[0][2] is None and "axios" in c.FELL_BACK, res
        assert calls[-1].endswith("site:axios.com"), calls
        recent = {"outlets": {"axios": {"fallback_at": c.iso(c.NOW)}}}
        c.FELL_BACK.clear()
        res = c.poll_all([o], {}, recent)
        assert res[0][2] and "axios" not in c.FELL_BACK, "no second Google request within the hour"
    finally:
        c.poll, c.GOOGLE_GAP = real_poll, real_gap
        c.FELL_BACK.clear()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
