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
    const weight = hasPlays
      ? Math.max(0.05, Math.sqrt((Number(a.plays) || 0) / (maxPlays || 1)))
      : 1 / (1 + Math.log2(rank + 2))

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

/** The user's genre profile, read off whichever of their artists we know. */
export function tasteTagVector(taste, artistIndex) {
  const vec = new Map()
  if (!artistIndex) return vec
  for (const a of taste.names) {
    const idx = lookupArtist(artistIndex, a.name)
    if (!idx?.tags?.length) continue
    for (const t of idx.tags) {
      const tag = typeof t === 'string' ? t : t.name
      const w = typeof t === 'string' ? 1 : t.count || 1
      if (!tag) continue
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
        new Map(idx.tags.map((t) => [typeof t === 'string' ? t : t.name, typeof t === 'string' ? 1 : t.count || 1]))
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
        const tag = typeof t === 'string' ? t : t.name
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
function selectMMR(candidates, count, opts, artistIndex) {
  const chosen = []
  const pool = [...candidates]
  const usedArtists = new Map()
  const usedVenues = new Map()

  const admissible = (c) => {
    for (const a of c.event.artists || []) {
      const k = foldName(a)
      if ((usedArtists.get(k) || 0) >= opts.maxPerArtist) return false
    }
    const v = c.event.venue?.id
    if (v && (usedVenues.get(v) || 0) >= opts.maxPerVenue) return false
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
  }

  while (chosen.length < count && pool.length) {
    let bestIdx = -1
    let bestVal = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]
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
    if (bestIdx < 0) break
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

  const { chosen, rest } = selectMMR(scored, opts.count, opts, index)

  // Reserve slots for things they do not already listen to. A list made only of
  // direct hits is a diary, not a recommendation — but this never invents a
  // pick: it only reorders which qualifying candidates get the last places.
  const wantDiscovery = Math.min(opts.discoverySlots, Math.floor(opts.count / 3))
  let picks = chosen
  const isDiscovery = (c) => c.best?.kind !== 'direct'
  if (wantDiscovery > 0 && chosen.length) {
    const have = chosen.filter(isDiscovery).length
    if (have < wantDiscovery) {
      const need = wantDiscovery - have
      const candidates = rest.filter(isDiscovery).slice(0, need)
      if (candidates.length) {
        const directs = chosen.filter((c) => !isDiscovery(c))
        const drop = new Set(directs.slice(-candidates.length))
        picks = [...chosen.filter((c) => !drop.has(c)), ...candidates]
      }
    }
  }

  picks.sort((a, b) => a.event.startDate.localeCompare(b.event.startDate))

  const matchedArtists = new Set()
  for (const p of scored) for (const e of p.evidence) if (e.via) matchedArtists.add(e.via)

  return {
    picks: picks.map((p) => ({
      ...p,
      why: explain(p, opts.lang || 'en'),
      whyDa: explain(p, 'da'),
      discovery: isDiscovery(p),
    })),
    diagnostics: {
      askedFor: opts.count,
      returned: picks.length,
      short: picks.length < opts.count,
      shortReason:
        picks.length < opts.count
          ? scored.length < opts.count
            ? 'not enough events cleared the evidence bar'
            : 'variety limits (one show per artist, at most a few per venue) ran out of distinct options'
          : null,
      eventsConsidered: filtered.length,
      eventsScored: scored.length,
      corpusSize: events.length,
      tasteSize: taste.size,
      tasteArtistsMatched: matchedArtists.size,
      filtered: filterCounts,
      discoveryPicks: picks.filter(isDiscovery).length,
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
