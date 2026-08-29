#!/usr/bin/env node
// Give the engine something to reason with.
//
// Without this, the recommender can only answer "is this exact artist in your
// library" — which finds you the four bands you already have tickets for and
// nothing else. The interesting recommendation is always the one you did not
// know about, and that needs two things per artist playing in Denmark:
//
//   TAGS      what kind of music it is        (MusicBrainz)
//   SIMILAR   who else a listener of them plays (ListenBrainz)
//
// Both are free, keyless and open. Spotify's Related Artists endpoint was
// closed to new applications in November 2024, so this is not a second-best
// route, it is the only route that does not require somebody's credentials.
//
// The cache is the point. MusicBrainz asks for one request a second, and a
// thousand artists is a twenty-minute run. Enriching only what is new keeps the
// weekly job to a couple of minutes.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { politeFetch } from './lib/http.mjs'
import { keysFor, foldName, looksLikeTribute } from '../src/text.mjs'

const CACHE = 'data/artist-cache.json'
const OUT = 'data/artists.json'
const MB_DELAY = 1100 // MusicBrainz asks for <= 1 req/s. Be slower than asked.
const CACHE_TTL_DAYS = 90

// ListenBrainz has moved this endpoint before. Rather than pin one guess, try
// the known shapes and record which answered, so a future run can see what
// worked rather than rediscovering it.
const SIMILAR_ENDPOINTS = [
  (mbid) =>
    `https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=${mbid}&algorithm=session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30`,
  (mbid) =>
    `https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=${mbid}&algorithm=session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30`,
  (mbid) => `https://api.listenbrainz.org/1/lb-radio/artist/${mbid}?mode=easy`,
]

// A hard backstop on what may ever become a "taste" dimension. Even a correct
// match should not turn a political label into something the engine matches
// people on, and a wrong match must never be able to.
const BANNED_TAGS = [
  /nsbm/i, /national socialist/i, /\bnazi/i, /white power/i, /rac\b/i,
  /fascist/i, /supremac/i,
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stats = { mbHits: 0, mbMiss: 0, ambiguous: 0, simHits: 0, simMiss: 0, cached: 0, errors: 0 }

let firstFailureReported = false

async function musicbrainzLookup(name) {
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)
  const url = `https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=5`
  const res = await politeFetch(url, { accept: 'application/json', delay: MB_DELAY })
  if (!res?.ok) {
    // Say what happened the FIRST time, loudly. The previous version resolved
    // nothing for 900 artists in a row and reported it as one bland count.
    if (!firstFailureReported) {
      firstFailureReported = true
      // status 0 means the request never completed — DNS, TLS, timeout, reset.
      // The reason lives in res.error and NOT printing it cost a whole run: the
      // 2026-08-24 harvest reported only "HTTP 0" and left the cause unknowable
      // from the log, on a run where all 3022 requests to the venues succeeded.
      const why =
        res === null
          ? 'politeFetch returned null (robots or skip)'
          : res.status === 0
            ? `no response after retries — ${res.error || 'reason not recorded'}`
            : `HTTP ${res.status}`
      console.error(`  first MusicBrainz failure: ${why} for "${name}"\n  ${url}`)
      if (res && res.text) console.error('  body: ' + res.text.slice(0, 200))
    }
    return null
  }
  let data
  try {
    data = JSON.parse(res.text)
  } catch {
    return null
  }
  const list = data?.artists || []
  if (!list.length) return null

  // Identity, and why this is fussier than it looks.
  //
  // The first version accepted any exact name match. That resolved 53 of 389
  // artists to a foreign act that merely shares the name: "Madsen" became a
  // German indie band, "Rosa" a Puerto Rican salsa singer, and "Absurd" a
  // German NSBM band whose tags would then have shaped somebody's
  // recommendations. A wrong identity is worse than no identity, because it
  // produces confident nonsense instead of an honest gap.
  //
  // So: an exact name match is necessary, never sufficient. Where several
  // artists share a name, the one from Denmark wins — every event in this
  // corpus is a Danish booking, which is real evidence about who is playing.
  // Where the name is short or generic and no Danish candidate exists, the
  // identity stays unresolved.
  const target = foldName(name)
  const exact = list.filter((a) => foldName(a.name) === target)
  const pool = exact.length ? exact : list.filter((a) => (a.score ?? 0) >= 95)
  if (!pool.length) return null

  const countryOf = (a) => a.country || a.area?.['iso-3166-1-codes']?.[0] || null
  const danish = pool.filter((a) => countryOf(a) === 'DK')
  const nordic = pool.filter((a) => ['SE', 'NO', 'FI', 'IS'].includes(countryOf(a)))

  let best = null
  if (danish.length) best = danish[0]
  else if (pool.length === 1) best = pool[0]
  else if (nordic.length === 1) best = nordic[0]

  // Ambiguous, and nothing local to break the tie.
  if (!best) return { ambiguous: true, candidates: pool.length }

  // A short name that resolved to a foreign artist is the exact shape of the
  // failure above, so it needs more than a name match to be believed.
  const isShort = target.replace(/\s/g, '').length <= 8
  if (isShort && countryOf(best) !== 'DK' && pool.length > 1) {
    return { ambiguous: true, candidates: pool.length }
  }

  const tags = (best.tags || [])
    .filter((t) => (t.count ?? 1) > 0)
    .sort((a, b) => (b.count ?? 1) - (a.count ?? 1))
    .slice(0, 12)
    .map((t) => ({ name: String(t.name).toLowerCase(), count: t.count ?? 1 }))
    .filter((t) => !BANNED_TAGS.some((rx) => rx.test(t.name)))

  return {
    mbid: best.id,
    mbName: best.name,
    country: countryOf(best),
    type: best.type || null,
    disambiguation: best.disambiguation || null,
    score: best.score ?? null,
    candidates: pool.length,
    tags,
  }
}

async function similarArtists(mbid, endpointIndex) {
  for (let i = endpointIndex.value; i < SIMILAR_ENDPOINTS.length; i++) {
    const res = await politeFetch(SIMILAR_ENDPOINTS[i](mbid), { accept: 'application/json', delay: 900 })
    if (!res?.ok) continue
    let data
    try {
      data = JSON.parse(res.text)
    } catch {
      continue
    }
    // Shapes differ between the labs API and the main one; both end up as a
    // list of objects carrying a name and a score somewhere.
    const rows = Array.isArray(data)
      ? Array.isArray(data[data.length - 1])
        ? data[data.length - 1]
        : data
      : data?.payload?.artists || data?.artists || []
    const out = []
    for (const r of rows) {
      const n = r?.artist_name || r?.name || r?.comment
      if (!n) continue
      const raw = Number(r?.score ?? r?.similarity ?? 0)
      out.push({ name: String(n), raw })
    }
    if (out.length) {
      endpointIndex.value = i // remember which one works for the rest of the run
      const max = Math.max(...out.map((o) => o.raw), 1)
      return out
        .slice(0, 60)
        .map((o) => ({ name: o.name, score: Math.max(0.25, Math.min(1, o.raw / max)) }))
    }
  }
  return []
}

const isFresh = (entry) =>
  entry?.checkedAt && Date.now() - Date.parse(entry.checkedAt) < CACHE_TTL_DAYS * 86_400_000

// The shipped index: keyed by every spelling of the name the matcher might
// see, so "MØ", "MO" and "Moe" all land on the same entry. Always written in
// the same breath as the cache it is derived from.
async function persist(cache, names) {
  const index = {}
  let withTags = 0
  let withSimilar = 0
  for (const name of names) {
    const entry = cache[foldName(name)]
    if (!entry || entry.notFound) continue
    const value = {
      name: entry.mbName || entry.name,
      country: entry.country || null,
      tags: (entry.tags || []).map((t) => ({ name: t.name, count: t.count })),
      similar: (entry.similar || []).map((s) => ({ name: s.name, score: Math.round(s.score * 100) / 100 })),
    }
    if (value.tags.length) withTags++
    if (value.similar.length) withSimilar++
    for (const k of keysFor(name)) index[k] = value
  }
  const json = JSON.stringify(index)
  await mkdir('data', { recursive: true })
  await writeFile(CACHE, JSON.stringify(cache, null, 0))
  await writeFile(OUT, json)
  return { index, withTags, withSimilar, size: json.length }
}

async function main() {
  const events = JSON.parse(await readFile('data/events.json', 'utf8'))
  const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {}

  // Every artist billed anywhere in the corpus, most-billed first so a run that
  // runs out of time has still done the artists that matter most.
  const counts = new Map()
  for (const e of events) {
    for (const a of e.artists || []) {
      // "0" was in the index as a Japanese microsound act. A name that is only
      // digits or punctuation is a parsing artefact, not an artist.
      if (!a || a.length < 2 || looksLikeTribute(a)) continue
      if (!/[a-zA-ZÆØÅæøå]/.test(a)) continue
      counts.set(a, (counts.get(a) || 0) + 1)
    }
  }
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)

  const budget = Number(process.env.ENRICH_LIMIT || 0) || names.length
  const todo = names.filter((n) => !isFresh(cache[foldName(n)]))
  console.log(`${names.length} distinct artists; ${todo.length} need enriching; budget ${budget}`)

  // A control that must fire before the run commits to twenty minutes of
  // lookups: resolve one artist we know MusicBrainz has. If this fails, the
  // route is broken and every subsequent "not found" would be a lie.
  const probe = await musicbrainzLookup('Iceage')
  if (!probe) {
    console.error('\nFAIL: the MusicBrainz probe for a known artist returned nothing.')
    console.error('Enrichment would resolve nothing and the site would fall back to exact-name matching.')
    process.exit(4)
  }
  console.log(`probe ok: Iceage -> ${probe.mbid} (${probe.country}) tags=${probe.tags.map((t) => t.name).slice(0, 4).join(', ')}`)

  const endpointIndex = { value: 0 }
  let done = 0
  for (const name of todo.slice(0, budget)) {
    const key = foldName(name)
    try {
      const mb = await musicbrainzLookup(name)
      if (!mb) {
        stats.mbMiss++
        cache[key] = { name, checkedAt: new Date().toISOString(), notFound: true }
        continue
      }
      if (mb.ambiguous) {
        stats.ambiguous++
        cache[key] = { name, checkedAt: new Date().toISOString(), notFound: true, ambiguous: mb.candidates }
        continue
      }
      stats.mbHits++
      const sim = await similarArtists(mb.mbid, endpointIndex)
      if (sim.length) stats.simHits++
      else stats.simMiss++
      cache[key] = { name, checkedAt: new Date().toISOString(), ...mb, similar: sim }
    } catch (err) {
      stats.errors++
      console.error(`  ${name}: ${err.message}`)
    }
    // Checkpoint both files together, never one without the other. The cache
    // stamps every entry with checkedAt and the TTL is 90 days, so a run that
    // saved the cache and died before rebuilding the index would leave those
    // artists cached-but-unindexed until November: never re-fetched, never
    // shipped. Writing the pair keeps them at most 25 artists apart on any
    // exit path.
    if (++done % 25 === 0) {
      console.log(`  ${done}/${Math.min(todo.length, budget)}  mb ${stats.mbHits}/${stats.mbHits + stats.mbMiss}  similar ${stats.simHits}`)
      await persist(cache, names)
    }
  }

  const { index, withTags, withSimilar, size } = await persist(cache, names)

  console.log(
    `\nartists.json: ${Object.keys(index).length} keys, ${withTags} with tags, ${withSimilar} with similar artists, ${(size / 1024).toFixed(0)} KB`
  )
  console.log(
    `musicbrainz resolved ${stats.mbHits}, not found ${stats.mbMiss}, ` +
      `left unresolved because the name was ambiguous ${stats.ambiguous}, errors ${stats.errors}`
  )
  console.log(`similar-artists endpoint in use: ${endpointIndex.value} of ${SIMILAR_ENDPOINTS.length}`)

  // A control that must fire. If enrichment produced nothing usable, the site
  // silently degrades to exact-name matching only and still looks fine, which
  // is exactly the failure that would never be noticed.
  if (names.length > 50 && withTags === 0 && withSimilar === 0) {
    console.error('\nFAIL: enrichment resolved nothing. The engine would fall back to exact-name matching.')
    process.exit(3)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
