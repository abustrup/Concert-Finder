# How this works, and how it could be wrong

Written 2026-08-12. Everything here is checkable from the repository; where a
number appears, the command that re-derives it appears next to it, because a
count written into a document is stale the moment the next harvest runs.

## The product decision everything else follows from

Songkick will show someone in Copenhagen several hundred upcoming events.
Spotify's concerts page shows whatever is in its ticketing inventory. Both are
answering "what is on". Most people go to somewhere between five and ten
concerts a year, so "what is on" is not the question they arrived with.

This answers a different one: **which handful of these would you actually go
to.** The default is twelve, adjustable between five and twenty, and the list
is allowed to come back shorter than asked when the evidence is thin. That last
part is the whole design. A recommender that always fills its quota is not
making twelve recommendations, it is making four and padding.

## Where the listings come from

Every event was parsed out of a response fetched from a venue's own website.
There is no path in this repository by which an event can be added any other
way — not by hand, not by a language model. `pipeline/validate.mjs` enforces it:
each event must name the adapter that produced it, a source URL whose host is a
registered venue, and the timestamp it was fetched at.

Three adapters cover almost everything, which is why adding a venue is normally
one entry in `pipeline/sources.json` rather than new code:

| Adapter | What it reads | Why it exists |
| --- | --- | --- |
| `jsonld-page` | schema.org `MusicEvent` markup on one index page | Loppen publishes 44 events on its front page, with ticket link and price |
| `sitemap-jsonld` | the sitemap enumerates event pages, each carrying JSON-LD | Stengade lists 227 `/show/` pages |
| `wp-rest` | the WordPress REST API's event post type | eleven Danish venues expose one; five share a plugin |
| `next-data` | the Next.js hydration payload | VEGA publishes no structured markup at all, but `__NEXT_DATA__` carries more than JSON-LD would |
| `html-event` | an ordinary event page, read the way a person reads it | The big rooms publish nothing structured. DR Koncerthuset's 574 calendar pages have og:title and a Danish date in the text, and nothing else |
| `ticketmaster` | the Discovery API, **switched off** | The only free self-service worldwide source. Needs a key, a repository variable, and a read of their caching terms first |

Re-derive what is actually covered:

```
node -e "const m=require('./data/harvest-meta.json');console.table(m.perSource.map(s=>({venue:s.name,events:s.kept})))"
```

### What is deliberately not covered

`pipeline/sources.json` keeps two lists beside the active one, so coverage
claims stay honest rather than implied:

- **`excluded`** — venues whose `robots.txt` disallows crawling. Hotel Cecil,
  Bremen Teater and Godset all say no, and the crawler obeys. Songkick is here
  too, for a different reason: it is a competitor's aggregation, not a primary
  source, so it is never harvested. It is only ever used as a coverage
  benchmark.
- **`notYetCovered`** — venues that were probed and did not yield. Each carries
  the reason and the date it was checked. Roskilde Festival is here because its
  programme pages are undated artist profiles; DR Koncerthuset because it
  publishes no structured data of any kind.

## How something gets recommended

Three kinds of evidence, and a pick that has none is never shown:

1. **You listen to them.** The strongest signal, weighted by how much.
2. **You listen to someone close to them.** From ListenBrainz's open
   similar-artist data. The explanation names the artist of yours it came from,
   so the claim is checkable rather than atmospheric.
3. **It matches your genres.** From MusicBrainz tags, as a cosine similarity
   against the tag profile of the artists you listen to.

Evidence combines with a noisy-OR, so a festival with eight of your artists
saturates while a club show with one does not, and depth breaks ties without
overturning the ranking.

Then **selection is not ranking.** The top twelve by score would be twelve
variations on your favourite band. Maximal Marginal Relevance picks each next
event by `λ·relevance − (1−λ)·similarity to what is already chosen`, with
λ = 0.72, and hard constraints on top: one show per artist, at most three per
venue. Two of the twelve places are held for acts you do *not* already listen
to, filled from the qualifying candidates rather than invented.

### Weighting a listening history

Two judgements, both arguable, both stated so they can be argued with:

- **Time listened beats times played.** A track you skipped after twenty
  seconds is not evidence you want to stand in a room and hear it. Plays under
  30 seconds are discarded.
- **Recent listening counts for more**, with an 18-month half-life. What you
  had on repeat in 2019 says less about which ticket you would buy this autumn.
  Long enough that a favourite you have not played this year still survives
  comfortably.

## What happens to your data

Nothing leaves your browser. This is not a policy, it is the architecture:
`docs/index.html` is a single self-contained file with the corpus, the engine,
the stylesheet and the typeface inlined. It loads no scripts, no fonts, no
images and no analytics from anywhere. A page that fetches nothing cannot leak
the file you dropped into it.

`test/shots.mjs` asserts this: it drives the real page in a real browser and
fails the build if any request leaves the page other than to `file://` or a
`data:` URI. The zip reader is 150 lines in `src/unzip.mjs` rather than a
library, for the same reason — a third-party unzip script would have full
access to the file you just opened, and the promise would rest on their
behaviour instead of on something checkable.

The one exception is stated on the page before it happens: looking up a
ListenBrainz username reads that account's public statistics from
`api.listenbrainz.org`, and only when the button is pressed.

**There is no Spotify login.** It would need an app registration, and any
implementation would use Authorization Code with PKCE so that no client secret
exists. It is not built, because it is not needed: the data export contains
more history than the API would return, and asking someone to grant account
permissions to a personal website is exactly the thing that should feel
sketchy.

## How it stays alive

A GitHub Actions job runs every Monday at 05:20 UTC. It crawls, enriches the
artist index, validates, rebuilds the page and commits. Three things about it
are deliberate:

- **A run that finds nothing fails** rather than shipping the old corpus
  quietly. Silence and success must not look the same.
- **The crawl is polite by construction.** `pipeline/lib/http.mjs` fetches
  `robots.txt` once per host and obeys it, serialises requests per host with a
  gap of at least 700ms, honours `Crawl-delay`, and sends a User-Agent naming
  the project with a link to this repository.
- **Enrichment is incremental**, capped at 900 artists a run, cached for 90
  days. MusicBrainz asks for one request a second and being a good citizen of a
  free service matters more than finishing in one go.

## How it could be wrong

Stated plainly, because the failure modes here are not obvious from using it.

**Coverage is partial, and it is skewed by how a website is built rather than
by how good the venue is.** The venues that publish structured data get covered;
the ones that render their programme in JavaScript do not, however important
they are. Royal Arena, Parken, Amager Bio, Forum and Musikhuset Aarhus serve no
event URLs at all in their HTML — 60 links on Royal Arena's events page, every
one of them a JavaScript chunk — so they are absent, and `pipeline/sources.json`
records that reason against each of them. Parken's concerts sell through Live
Nation, so they would arrive through the Ticketmaster adapter rather than
through a crawler. Anyone reading this list as "the concerts in Denmark" is
reading it wrong, and the footer names the venues it covers for that reason.

**Europe is not covered by crawling, and cannot be.** Twenty major European
venues were probed on 2026-08-12 — Berghain, Paradiso, Melkweg, Debaser,
Rockefeller, Tavastia, Razzmatazz and thirteen more. **Not one publishes
schema.org event data.** Crawling three hundred European venues by hand is not
a plan, which is why the Europe and world filters are honest about showing only
what is covered until the Ticketmaster adapter is switched on.

**Dates are read from Danish prose for most venues.** They publish no date
field, so `pipeline/lib/dkdate.mjs` reads "Onsdag 11. november 2026" or
"11.11.26" out of the page text. When the year is missing it guesses forward.
That is right for a programme page and wrong for anything else, and it is the
single most likely source of a wrong date on the site.

**Non-music events leak.** Culture houses programme craft groups and quiz
nights through the same feed as concerts. Two filters catch most of it: a stem
list that matches inside Danish compounds, and a rule that a bill repeating
five or more times at one venue is a recurring activity rather than a concert.
Both are reported in `data/harvest-meta.json` so over-filtering is visible.
Neither is complete.

**The artist index is thin for small acts.** MusicBrainz resolves well-known
artists reliably and obscure Danish support acts poorly. When it cannot resolve
an artist, that artist can only ever be recommended by exact name match.

**A recommender has no ground truth.** The eval in `test/eval.mjs` grades
against six personas whose must-appear and must-not-appear lists were written
by hand in `test/personas.json` before the engine ran. That catches gross
failures — a metal listener being sent to a light-orchestra concert — and
cannot tell you whether the twelfth pick was better than the thirteenth. No
offline eval can. The honest claim is that the list is defensible, not that it
is optimal.

**Prices and times are as the venue published them**, and venues are wrong
about their own listings more often than you would expect. Every card links
back to the venue or the ticket seller, and that link is the authority.
