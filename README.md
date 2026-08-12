# TOLV

**Twelve concerts a year, chosen from what you actually listen to.**
Danish venues first, with Europe and the rest of the world behind a filter.

Open `docs/index.html` in any browser. No server, no build step, no network, no
account. It is one self-contained file.

---

## Why it exists

Songkick will hand someone in Copenhagen several hundred upcoming events.
Spotify's concerts page shows whatever its ticketing partner has. Both answer
"what is on". Most people go to five or ten concerts a year, so that is not the
question they arrived with.

This answers **which handful would you actually go to** — twelve by default,
adjustable from five to twenty, and shorter than that when the evidence is thin.
A list that always fills its quota is padding, not recommending.

## Three ways in, none of which needs an account

| | | |
| --- | --- | --- |
| **Drop in an export** | The zip Spotify emails you. Also Apple Music, Last.fm, ListenBrainz, and Spotify exports going back years. | Best results |
| **A ListenBrainz username** | Public listening stats, so a name is enough. No password, no permissions. | Ten seconds |
| **Type some bands** | Twenty artists, typed. Rough and immediately useful. | No account at all |

**Nothing is uploaded.** The page loads no third-party script, no font, no
image and no analytics, so the file you drop in has nowhere to go. The browser
test fails the build if any request leaves the page. There is no Spotify login,
deliberately: the export holds more history than the API would give, and asking
for account permissions is exactly what should feel sketchy.

## What is in the box

```
docs/index.html      the whole site: corpus, engine, styles and typeface inlined
docs/METHOD.md       how it works, what is covered, and how it could be wrong
docs/acceptance.md   what "working" means, fixed before the build
src/                 the engine — shared by the page and the tests
pipeline/            crawl, enrich, validate, build
  sources.json       the venue registry: add a venue here, not in code
  lib/dkdate.mjs     reading "Onsdag 11. november 2026" out of Danish prose
test/                unit tests, the persona eval, and a real browser
```

## The part that keeps itself alive

Every Monday a GitHub Actions job with no credentials crawls the registered
venues, enriches the artist index from MusicBrainz and ListenBrainz, validates
every event's provenance, rebuilds the page and commits it.

Three properties are enforced rather than intended:

- **Nothing can invent an event.** Every event must name the adapter that
  produced it and a source URL whose host is a registered venue. `validate.mjs`
  runs four cases built to fail it, so a validator that has stopped checking
  cannot pass silently.
- **A run that finds nothing fails.** Silence and success must not look alike.
- **The crawler is polite by construction.** `robots.txt` fetched once per host
  and obeyed, one request at a time per host, `Crawl-delay` honoured, and a
  User-Agent that says who we are. Three venues say no, and are not crawled.

## How the picking works

Three kinds of evidence, and a pick with none is never shown: you listen to
them; you listen to someone close to them; or it matches your genres. Then
selection diversifies on purpose — one show per artist, at most three per venue,
and two of the twelve places held for acts you do not already know.

Every card says which of your artists put it there, so the claim is checkable
rather than atmospheric.

Full detail, including the ways it can be wrong: [docs/METHOD.md](docs/METHOD.md).

## Running the checks

```
node test/run.mjs         # unit tests
node pipeline/validate.mjs # every event carries its provenance
node test/eval.mjs         # the shortlist, against hand-labelled personas
node test/shots.mjs        # a real browser, and screenshots
```

## Not affiliated

Not affiliated with Spotify, Songkick, Bandsintown or any venue. No ads, no
affiliate links, no ticket resale. Every event links to the venue or its
official seller.

Typeface: [Space Grotesk](https://github.com/floriankarsten/space-grotesk),
SIL Open Font License, self-hosted.

## What is left for you

Four things this could not decide on its own.

**Turning on GitHub Pages.** The site is built and committed at `docs/index.html`;
serving it publicly is a publishing decision, so it is yours. Settings → Pages →
Source: *Deploy from a branch* → Branch: `main`, folder `/docs`.

**Europe and the world.** `pipeline/adapters/ticketmaster.mjs` is written and
registered but switched off. It needs a free self-service key from
developer.ticketmaster.com as the Actions secret `TICKETMASTER_API_KEY`, and it
needs someone to read their Terms of Use — specifically the caching section —
because a public repository is durable republication rather than a cache, and
that is a judgement about somebody else's terms rather than a setting. Until
then the region filter honestly shows only what is covered.

**Kultunaut.** Denmark's cultural events database holds roughly 136,000 events
and has no open API: access is a licensed partner feed you get by asking
(datanaut.kultunaut.dk). One email is worth more than any scraper here, and the
pitch is unusually strong — non-commercial, static, listening history never
leaving the browser, every link pointing back at them. That is an outreach
decision, so it is yours.

**The venues that say no.** Hotel Cecil, Bremen Teater and Godset disallow
crawling in `robots.txt` and are therefore absent. Asking them directly is the
only route in, and it is a conversation rather than a code change.
