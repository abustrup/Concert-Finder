// The engine.
//
// The product decision this file implements: a short list beats a complete one.
// Songkick will happily show a Copenhagen visitor several hundred upcoming
// events. Most people go to somewhere between five and ten concerts a year, so
// a list of three hundred is not generosity, it is an unanswered question.
//
// So everything here is built around a hard cap and a refusal to fill it with
// filler. Three consequences that are easy to get wrong and are deliberate:
//
//   - The list may come back SHORTER than asked. If only six events clear the
//     evidence bar, six is the honest answer and the seventh would be noise.
//   - Ranking is not the same as selection. The top twelve by score would be
//     twelve variations on one band. Selection diversifies on purpose.
//   - Some slots are reserved for things the person does NOT already listen to,
//     because a recommender that only returns your own library is a search box.

import { keysFor, foldName, looksLikeTribute, nearlyEqual } from './text.mjs'

export const DEFAULTS = {
  count: 12,
  minCount: 5,
  maxCount: 20,
  minScore: 0.18,
  discoverySlots: 2,
  maxPerVenue: 3,
  maxPerArtist: 1,
  // No more than a third of the list in any one month. The Danish season is
  // heavily autumn-weighted — 326 events in October against 12 in June — so
  // without this the "twelve nights across your year" idea collapses into
  // "ten nights in October", which is a worse answer to the same question and
  // makes the year spine a lie.
  maxPerMonthFraction: 1 / 3,
  lambda: 0.72, // MMR: relevance vs variety. Higher keeps the ranking honest.
  horizonDays: 365,
  roomPreference: 'any', // 'any' | 'intimate'
  includeTributes: false,
}

const KIND_WEIGHT = { direct: 1.0, similar: 0.62, tag: 0.34 }

// ---------------------------------------------------------------- taste model

/**
 * Turn a raw import into weights.
 *
 * Play counts are extremely skewed — a top artist can have fifty times the
 * plays of the twentieth — so raw shares would make everything but the top
 * three invisible. The square root keeps the head on top while leaving the
 * tail able to earn a recommendation, which matters because the tail is where
 * the interesting concerts are.
 */
export function buildTaste(artists, opts = {}) {
  const list = (artists || []).filter((a) => a && a.name && String(a.name).trim())
  if (!list.length) return { byKey: new Map(), names: [], size: 0, tags: new Map() }

  const hasPlays = list.some((a) => Number(a.plays) > 0)
  const maxPlays = hasPlays ? Math.max(...list.map((a) => Number(a.plays) || 0)) : 0

  const byKey = new Map()
  const names = []

  list.forEach((a, i) => {
    const rank = Number.isFinite(a.rank) ? a.rank : i
    // Rank-only input (a typed list, or a service that gives an order but no
    // counts). The top name must weigh 1, or a person's favourite band scores
    // half of what a direct hit is worth and nothing ever clears the bar.
    const weight = hasPlays
      ? Math.max(0.05, Math.sqrt((Number(a.plays) || 0) / (maxPlays || 1)))
      : 1 / Math.log2(rank + 2)

    const entry = { name: String(a.name).trim(), weight, plays: Number(a.plays) || null, rank }
    names.push(entry)
    for (const k of keysFor(entry.name)) {
      const prev = byKey.get(k)
      if (!prev || prev.weight < weight) byKey.set(k, entry)
    }
  })

  names.sort((x, y) => y.weight - x.weight)
  return { byKey, names, size: names.length, tags: opts.tags || new Map() }
}

// MusicBrainz tag votes can be NEGATIVE — the community downvotes a wrong tag,
// and Mogwai's "ambient" sits at -1. Left alone, a negative vote becomes a
// negative component in a cosine vector, which does not mean "less like this",
// it means the maths stops describing anything.
//
// Nationality tags are dropped for a different reason: "danish" is already the
// country field, and leaving it in the genre vector makes every Danish artist
// look like every other Danish artist regardless of what they sound like.
const TAG_STOPLIST = new Set([
  'danish', 'dansk', 'denmark', 'norwegian', 'swedish', 'finnish', 'icelandic',
  'nordic', 'scandinavian', 'british', 'american', 'english', 'german', 'french',
  'seen live', 'favorites', 'favourites', 'awesome', 'good', 'male vocalists',
  'female vocalists', 'under 2000 listeners', 'spotify',
])

export function tagWeight(t) {
  const count = typeof t === 'string' ? 1 : t.count
  // A downvoted tag contributes nothing; it never subtracts.
  if (typeof count === 'number' && count <= 0) return 0
  return typeof count === 'number' ? count : 1
}

// A backstop the engine applies to whatever index it is handed, so a bad
// artist match upstream can never turn a political label into a taste
// dimension people get matched on.
const BANNED_TAG = /nsbm|national socialist|nazi|white power|fascist|supremac/i

export function usableTag(t) {
  const name = (typeof t === 'string' ? t : t?.name || '').toLowerCase().trim()
  if (!name || TAG_STOPLIST.has(name)) return null
  if (BANNED_TAG.test(name)) return null
  return name
}

/** The user's genre profile, read off whichever of their artists we know. */
export function tasteTagVector(taste, artistIndex) {
  const vec = new Map()
  if (!artistIndex) return vec
  for (const a of taste.names) {
    const idx = lookupArtist(artistIndex, a.name)
    if (!idx?.tags?.length) continue
    for (const t of idx.tags) {
      const tag = usableTag(t)
      const w = tagWeight(t)
      if (!tag || w <= 0) continue
      vec.set(tag, (vec.get(tag) || 0) + a.weight * w)
    }
  }
  return normalizeVector(vec)
}

function normalizeVector(vec) {
  let norm = 0
  for (const v of vec.values()) norm += v * v
  norm = Math.sqrt(norm) || 1
  const out = new Map()
  for (const [k, v] of vec) out.set(k, v / norm)
  return out
}

function cosine(a, b) {
  if (!a.size || !b.size) return 0
  let dot = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = large.get(k)
    if (w) dot += v * w
  }
  let nb = 0
  for (const v of b.values()) nb += v * v
  nb = Math.sqrt(nb) || 1
  let na = 0
  for (const v of a.values()) na += v * v
  na = Math.sqrt(na) || 1
  return dot / (na * nb)
}

export function lookupArtist(artistIndex, name) {
  if (!artistIndex) return null
  for (const k of keysFor(name)) {
    const hit = artistIndex.get ? artistIndex.get(k) : artistIndex[k]
    if (hit) return hit
  }
  return null
}

function tasteHit(taste, name) {
  for (const k of keysFor(name)) {
    const hit = taste.byKey.get(k)
    if (hit) return hit
  }
  // A near-match only for names long enough that one character cannot be a
  // different band. "Mew" and "Men" must never collide.
  const folded = foldName(name)
  if (folded.length >= 8) {
    for (const [k, v] of taste.byKey) {
      if (nearlyEqual(k, folded)) return v
    }
  }
  return null
}

// -------------------------------------------------------------------- scoring

const noisyOr = (strengths) => 1 - strengths.reduce((p, s) => p * (1 - Math.min(0.999, s)), 1)

/**
 * Score one event against one taste, and record WHY.
 *
 * The evidence array is not debug output: it becomes the sentence the person
 * reads under the recommendation. A pick that cannot say why it is there does
 * not get shown, which is what stops the list drifting into "popular near you".
 */
export function scoreEvent(event, taste, artistIndex, userTags, opts = DEFAULTS) {
  const evidence = []
  const artists = event.artists?.length ? event.artists : [event.title]

  for (const artistName of artists.slice(0, 8)) {
    const direct = tasteHit(taste, artistName)
    if (direct) {
      evidence.push({
        kind: 'direct',
        artist: artistName,
        via: direct.name,
        weight: direct.weight,
        strength: direct.weight * KIND_WEIGHT.direct,
      })
      continue
    }

    const idx = lookupArtist(artistIndex, artistName)
    if (!idx) continue

    // Similar artists: the index stores, for each artist we know is playing,
    // the artists a listener of THEM also listens to. If one of those is in the
    // person's library, that is real evidence and we can name it.
    let bestSimilar = null
    for (const sim of idx.similar || []) {
      const simName = typeof sim === 'string' ? sim : sim.name
      const simScore = typeof sim === 'string' ? 0.6 : Math.min(1, sim.score ?? 0.6)
      const hit = tasteHit(taste, simName)
      if (!hit) continue
      const strength = hit.weight * simScore * KIND_WEIGHT.similar
      if (!bestSimilar || strength > bestSimilar.strength) {
        bestSimilar = { kind: 'similar', artist: artistName, via: hit.name, similarity: simScore, weight: hit.weight, strength }
      }
    }
    if (bestSimilar) {
      evidence.push(bestSimilar)
      continue
    }

    if (userTags?.size && idx.tags?.length) {
      const evTags = normalizeVector(
        new Map(
          idx.tags
            .map((t) => [usableTag(t), tagWeight(t)])
            .filter(([name, w]) => name && w > 0)
        )
      )
      const sim = cosine(userTags, evTags)
      if (sim > 0.12) {
        const shared = [...evTags.keys()].filter((t) => userTags.has(t)).slice(0, 3)
        evidence.push({ kind: 'tag', artist: artistName, tags: shared, similarity: sim, strength: sim * KIND_WEIGHT.tag })
      }
    }
  }

  if (!evidence.length) return null

  const strengths = evidence.map((e) => e.strength)
  const score = noisyOr(strengths)
  const depth = strengths.reduce((a, b) => a + b, 0)

  // Depth breaks ties without overturning the ranking: a festival with eight of
  // your artists should beat a club show with one, but not beat your favourite
  // band's only Danish date.
  let rank = score * (1 + 0.12 * Math.log1p(depth))

  if (opts.roomPreference === 'intimate') {
    const cls = event.venue?.sizeClass
    if (cls === 'club') rank *= 1.12
    else if (cls === 'arena') rank *= 0.82
  }

  evidence.sort((a, b) => b.strength - a.strength)
  return { event, score, depth, rank, evidence, best: evidence[0] }
}

// ------------------------------------------------------------------ selection

function eventSimilarity(a, b, artistIndex) {
  const aArtists = new Set((a.event.artists || []).map(foldName))
  const bArtists = new Set((b.event.artists || []).map(foldName))
  let shared = 0
  for (const x of aArtists) if (bArtists.has(x)) shared++
  const artistOverlap = shared / Math.max(1, Math.min(aArtists.size, bArtists.size))

  const tagsOf = (r) => {
    const m = new Map()
    for (const name of r.event.artists || []) {
      const idx = lookupArtist(artistIndex, name)
      for (const t of idx?.tags || []) {
        const tag = usableTag(t)
        if (tag) m.set(tag, (m.get(tag) || 0) + 1)
      }
    }
    return normalizeVector(m)
  }
  const tagSim = cosine(tagsOf(a), tagsOf(b))

  const sameVenue = a.event.venue?.id && a.event.venue.id === b.event.venue?.id ? 1 : 0
  const sameMonth = a.event.startDate?.slice(0, 7) === b.event.startDate?.slice(0, 7) ? 1 : 0

  return 0.55 * artistOverlap + 0.25 * tagSim + 0.12 * sameVenue + 0.08 * sameMonth
}

/**
 * Maximal Marginal Relevance.
 *
 * Pick the candidate that maximises  λ·relevance − (1−λ)·max similarity to what
 * is already picked. Without this, a person whose top artist has three Danish
 * dates gets three near-identical rows and eleven months of nothing.
 */
function selectMMR(candidates, count, opts, artistIndex, discoveryQuota = 0) {
  const chosen = []
  const pool = [...candidates]
  const usedArtists = new Map()
  const usedVenues = new Map()
  const usedMonths = new Map()
  const maxPerMonth = Math.max(2, Math.ceil(count * (opts.maxPerMonthFraction ?? 1)))

  const admissible = (c) => {
    for (const a of c.event.artists || []) {
      const k = foldName(a)
      if ((usedArtists.get(k) || 0) >= opts.maxPerArtist) return false
    }
    const v = c.event.venue?.id
    if (v && (usedVenues.get(v) || 0) >= opts.maxPerVenue) return false
    const mo = c.event.startDate?.slice(0, 7)
    if (mo && (usedMonths.get(mo) || 0) >= maxPerMonth) return false
    return true
  }

  const commit = (c) => {
    chosen.push(c)
    for (const a of c.event.artists || []) {
      const k = foldName(a)
      usedArtists.set(k, (usedArtists.get(k) || 0) + 1)
    }
    const v = c.event.venue?.id
    if (v) usedVenues.set(v, (usedVenues.get(v) || 0) + 1)
    const mo = c.event.startDate?.slice(0, 7)
    if (mo) usedMonths.set(mo, (usedMonths.get(mo) || 0) + 1)
  }

  const isDiscovery = (c) => c.best?.kind !== 'direct'

  while (chosen.length < count && pool.length) {
    // Reserve the discovery places INSIDE the loop rather than swapping them in
    // afterwards. The old post-hoc swap could drop a chosen pick and add a
    // replacement that reused an artist or a venue already spent, quietly
    // breaking the one-show-per-artist promise the whole list rests on.
    const slotsLeft = count - chosen.length
    const stillNeedDiscovery = Math.max(0, discoveryQuota - chosen.filter(isDiscovery).length)
    const mustBeDiscovery = stillNeedDiscovery >= slotsLeft

    let bestIdx = -1
    let bestVal = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
      if (mustBeDiscovery && !isDiscovery(c)) continue
      if (!admissible(c)) continue
      let maxSim = 0
      for (const s of chosen) {
        const sim = eventSimilarity(c, s, artistIndex)
        if (sim > maxSim) maxSim = sim
      }
      const val = opts.lambda * c.rank - (1 - opts.lambda) * maxSim
      if (val > bestVal) {
        bestVal = val
        bestIdx = i
      }
    }
    if (bestIdx < 0) {
      // Nothing discovery-shaped is left. Better a full list of honest direct
      // matches than an artificially short one.
      if (mustBeDiscovery && discoveryQuota > 0) {
        discoveryQuota = 0
        continue
      }
      break
    }
    commit(pool.splice(bestIdx, 1)[0])
  }
  return { chosen, rest: pool }
}

// ---------------------------------------------------------------- explanation

export function explain(result, lang = 'en') {
  const e = result.best
  const venue = result.event.venue?.name
  if (!e) return ''
  if (lang === 'da') {
    if (e.kind === 'direct') return `Du lytter til ${e.via}.`
    if (e.kind === 'similar') return `Fordi du lytter til ${e.via}.`
    if (e.kind === 'tag') return `Rammer din smag for ${(e.tags || []).slice(0, 2).join(' og ')}.`
    return ''
  }
  if (e.kind === 'direct') return `You listen to ${e.via}.`
  if (e.kind === 'similar') return `Because you listen to ${e.via}.`
  if (e.kind === 'tag') return `Matches your taste for ${(e.tags || []).slice(0, 2).join(' and ')}.`
  return ''
}

// ----------------------------------------------------------------------- main

export function recommend({ taste, events, artistIndex, options = {} }) {
  const opts = { ...DEFAULTS, ...options }
  opts.count = Math.max(opts.minCount, Math.min(opts.maxCount, opts.count))

  const index = artistIndex instanceof Map ? artistIndex : new Map(Object.entries(artistIndex || {}))
  const userTags = tasteTagVector(taste, index)

  const from = opts.from || new Date().toISOString().slice(0, 10)
  const to = opts.to || addDays(from, opts.horizonDays)

  const filtered = []
  const filterCounts = { past: 0, beyondWindow: 0, country: 0, city: 0, tribute: 0, cancelled: 0 }

  for (const ev of events) {
    if (!ev.startDate || ev.startDate < from) {
      filterCounts.past++
      continue
    }
    if (ev.startDate > to) {
      filterCounts.beyondWindow++
      continue
    }
    if (ev.status && ev.status !== 'scheduled') {
      filterCounts.cancelled++
      continue
    }
    if (opts.countries?.length && !opts.countries.includes(ev.venue?.country)) {
      filterCounts.country++
      continue
    }
    if (opts.cities?.length && !opts.cities.includes(ev.venue?.city)) {
      filterCounts.city++
      continue
    }
    if (!opts.includeTributes && (ev.isTribute || looksLikeTribute(ev.title))) {
      filterCounts.tribute++
      continue
    }
    filtered.push(ev)
  }

  const scored = []
  for (const ev of filtered) {
    const r = scoreEvent(ev, taste, index, userTags, opts)
    if (r && r.score >= opts.minScore) scored.push(r)
  }
  scored.sort((a, b) => b.rank - a.rank)

  // One artist, several dates: nudge toward the smaller room, do not delete the
  // others.
  //
  // The first version dropped every date but one per artist BEFORE selection.
  // That silently removed the engine's freedom to place an artist in a quiet
  // month: dk-pop had qualifying shows in five months and could only ever use
  // three, because each artist had already been pinned to one date chosen by
  // rank rather than by what the list needed. Selection already guarantees one
  // show per artist, so the pre-filter bought nothing and cost the spread.
  const CAPACITY_ORDER = { club: 0, mid: 1, large: 2, arena: 3 }
  const smallestPerArtist = new Map()
  const artistKeyOf = (r) => foldName(r.best?.artist || r.event.headliner || r.event.title)
  for (const r of scored) {
    const key = artistKeyOf(r)
    const prev = smallestPerArtist.get(key)
    const rank = CAPACITY_ORDER[r.event.venue?.sizeClass] ?? 9
    if (!prev || rank < prev) smallestPerArtist.set(key, rank)
  }
  for (const r of scored) {
    const mine = CAPACITY_ORDER[r.event.venue?.sizeClass] ?? 9
    if (mine === smallestPerArtist.get(artistKeyOf(r))) r.rank *= 1.06
  }
  scored.sort((a, b) => b.rank - a.rank)
  const deduped = scored

  // Confidence scales the list. When only a few of a person's artists are
  // actually playing, twelve picks would mean nine built on genre similarity
  // alone, which is how a shortlist turns back into a listings page.
  const matchedArtistCount = new Set(
    scored.flatMap((r) => r.evidence.filter((e) => e.kind === 'direct').map((e) => e.via))
  ).size
  const confidenceCap = Math.max(opts.minCount, matchedArtistCount * 2)
  const effectiveCount = Math.min(opts.count, confidenceCap)

  const wantDiscoveryQuota = Math.min(opts.discoverySlots, Math.floor(effectiveCount / 3))
  const { chosen, rest } = selectMMR(deduped, effectiveCount, opts, index, wantDiscoveryQuota)

  const isDiscoveryPick = (c) => c.best?.kind !== 'direct'
  const picks = chosen

  picks.sort((a, b) => a.event.startDate.localeCompare(b.event.startDate))

  const matchedArtists = new Set()
  for (const p of scored) for (const e of p.evidence) if (e.via) matchedArtists.add(e.via)

  return {
    picks: picks.map((p) => ({
      ...p,
      why: explain(p, opts.lang || 'en'),
      whyDa: explain(p, 'da'),
      discovery: isDiscoveryPick(p),
    })),
    diagnostics: {
      askedFor: opts.count,
      cappedAt: effectiveCount < opts.count ? effectiveCount : null,
      matchedArtistCount,
      returned: picks.length,
      short: picks.length < opts.count,
      // A code, not a sentence: the page is bilingual and the reason is shown
      // to the person, so it cannot be English prose decided here.
      shortReason:
        picks.length < opts.count
          ? effectiveCount < opts.count
            ? 'thin-evidence'
            : scored.length < opts.count
              ? 'thin-evidence'
              : 'variety-limit'
          : null,
      eventsConsidered: filtered.length,
      eventsScored: scored.length,
      corpusSize: events.length,
      tasteSize: taste.size,
      tasteArtistsMatched: matchedArtists.size,
      filtered: filterCounts,
      discoveryPicks: picks.filter(isDiscoveryPick).length,
      window: { from, to },
      scoreRange: scored.length ? { top: scored[0].score, floor: opts.minScore } : null,
    },
  }
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
