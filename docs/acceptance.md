# What "working" means

Fixed on **2026-08-12, before the build**, because the standing rule is to pin down acceptance in
plain language first, and because a recommender is the easiest kind of software to grade by whether
it looks finished rather than by whether it works.

`test/eval.mjs` runs the machine-checkable half. The rest is on this list anyway: dropping a case
because a machine cannot check it would let the eval quietly redefine the goal as whatever is
convenient to test.

## The job, in one sentence

> A person hands over their listening taste in under a minute, without an account, and gets back a
> short, dated, checkable list of concerts they would actually go to — mostly in Denmark — with a
> route to a ticket for each one.

Everything below is a consequence of that sentence.

## The number that decides the product

The owner's success condition, verbatim: *"5-20 concerts pretty focused that any given person might
would love to hear pr year. Not necesarilly much more than that... Most people probably do around
5-10 concerts a year not more, so recomending hundres of concerts is just confusing."*

So the product is **not** a listings site with personalisation bolted on. It is a shortlist that
happens to be built from listings. Every design argument resolves against that sentence: when in
doubt, show fewer.

The default is **twelve**. That is where the name comes from.

## The acceptance cases

Each is a plain claim, a way to measure it, and the number that counts as a pass.

### A. A person can get a list

| # | Claim | Pass | Checked by |
| --- | --- | --- | --- |
| A1 | From landing to a personal list without an account, in at most 3 interactions. | 3 or fewer | eval + screenshots |
| A2 | At least three independent ways in, one of which needs no credential from anybody. | 3 or more working | eval |
| A3 | The whole thing works with JavaScript on and no server: it is a static site. | no backend call in the import path | privacy test |

### B. The list is short, and short on purpose

| # | Claim | Pass | Checked by |
| --- | --- | --- | --- |
| B1 | The list never exceeds the cap the user set, and the cap never exceeds 20. | 0 violations across all personas | eval |
| B2 | When the evidence is thin, the list is **shorter** than the cap rather than padded to it. | at least one persona returns fewer than asked, and says why | eval |
| B3 | No artist appears twice. | 0 duplicate artists | eval |
| B4 | No single venue takes over the list. | at most 3 of 12 from one venue | eval |
| B5 | The list spreads across the year when the corpus allows it. | at least 4 distinct months when 4 are available | eval |

### C. The list is *good*

This is the case that matters and the hardest to check honestly. We have no click data and one real
user, so the method is hand-labelled personas: a taste profile, plus artists that **must** appear if
they are playing, plus artists that **must not** appear.

| # | Claim | Pass | Checked by |
| --- | --- | --- | --- |
| C1 | Every must-appear artist that is actually playing in range shows up. | 100% recall on the label set | eval |
| C2 | No must-not-appear artist shows up. | 0 violations | eval |
| C3 | Two different tastes get two different lists. | at most 30% overlap between any two personas' top 12 | eval |
| C4 | Every pick explains itself by naming real evidence — which artist of theirs, or which similar artist and why we think they are similar. | 100% of picks carry a named reason | eval |
| C5 | A tribute band, covers night or karaoke does not get recommended as the real artist. | 0 tribute acts in any persona's list | eval |

### D. The data is real

The single worst failure available to this project is a plausible, well-designed listing for a
concert that does not exist. Someone would plan an evening around it.

| # | Claim | Pass | Checked by |
| --- | --- | --- | --- |
| D1 | Every event carries a source URL, the date it was fetched, and the adapter that produced it. | 100% | validate |
| D2 | No event in the shipped dataset was written by a language model. Enforced by construction: events only enter the corpus through an adapter that parsed a fetched response. | 0 model-authored events | provenance check |
| D3 | Events in the past are never shown. | 0 | eval |
| D4 | The page states how old its data is, in plain words, where a user will see it. | present | screenshot |
| D5 | A refresh that fetches nothing fails loudly instead of silently shipping the old corpus. | run fails | CI |

### E. Safe, compliant, and not sketchy

| # | Claim | Pass | Checked by |
| --- | --- | --- | --- |
| E1 | Listening data never leaves the browser. No upload, no analytics, no third-party script. | 0 outbound requests carrying user data | privacy test |
| E2 | No client secret exists anywhere in the repo. Any Spotify login is PKCE-only. | 0 secrets | secret scan |
| E3 | Every scraper reads robots.txt first and obeys it, identifies itself, and rate-limits. | 100% of adapters | code + CI |
| E4 | Every event links back to the venue or ticket seller it came from. | 100% | validate |
| E5 | The site says, in plain language a non-technical person understands, what happens to their data. | present | screenshot |

### F. It looks like someone decided something

Judged by someone who has run a freelance film business since 2020. "Not obviously templated" is the
bar, not "has a design".

| # | Claim | Pass |
| --- | --- | --- |
| F1 | One type family. One accent colour. One spacing scale. | no second family, no second accent |
| F2 | Renders correctly at 390px and at 1440px. | screenshots at both |
| F3 | Light and dark both deliberate, neither an afterthought. | screenshots of both |
| F4 | Nothing on the page is a stock AI-site tell: no purple-blue gradient, no glassmorphism, no emoji headers. | none present |

### G. It stays alive

| # | Claim | Pass |
| --- | --- | --- |
| G1 | A weekly job refreshes the corpus without anyone touching it. | scheduled workflow exists and has run |
| G2 | The job's failure is visible, not silent. | failure opens an issue or fails the run |
| G3 | Adding a new venue is a data change, not a code change, wherever the site's shape allows it. | new venue = one entry + one adapter id |

## What is deliberately *not* promised

- **Not every concert in Denmark.** Coverage is whatever the adapters actually reach, and the site
  says which venues it covers and which it does not.
- **Not commercial.** No ticket resale, no affiliate links, no ads. Links go to the venue or the
  official seller.
- **Not a login for other people's accounts.** Nobody types a password into this site, ever.
- **Not real-time.** The corpus is as fresh as the last weekly run, and the page says when that was.

## How this gets graded honestly

The trap in a recommender is that it always returns *something*, and something always looks fine.
Three defences, all of them in `test/`:

1. **A control that must fire.** Every check that hunts for a problem is run once against input that
   is guaranteed to contain the problem. A check that cannot fail is not a check.
2. **Persona labels written before the engine.** The must-appear and must-not-appear lists are fixed
   in `test/personas/` and dated. Moving a label to make a test pass is a change to the product's
   goal, and it shows up in the diff as one.
3. **A refutation pass.** Before anything is called done, a separate pass tries to break it: malformed
   uploads, an empty history, a taste with nothing in Denmark, a corpus with one event in it.
