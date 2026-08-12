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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stats = { mbHits: 0, mbMiss: 0, simHits: 0, simMiss: 0, cached: 0, errors: 0 }

async function musicbrainzLookup(name) {
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)
  const url = `https://musicbrainz.org/ws/2/artist?query=${q}&fmt=json&limit=5`
  const res = await politeFetch(url, { accept: 'application/json', delay: MB_DELAY })
  if (!res?.ok) return null
  let data
  try {
    data = JSON.parse(res.text)
  } catch {
    return null
  }
  const list = data?.artists || []
  if (!list.length) return null

  // Take the top hit only when MusicBrainz is confident and the name really
  // matches. A loose match here quietly attaches the wrong genre to an artist
  // and then recommends the wrong concerts, which is worse than no tags.
  const target = foldName(name)
  const best = list.find((a) => foldName(a.name) === target) || (list[0]?.score >= 95 ? list[0] : null)
  if (!best) return null

  const tags = (best.tags || [])
    .filter((t) => (t.count ?? 1) > 0)
    .sort((a, b) => (b.count ?? 1) - (a.count ?? 1))
    .slice(0, 12)
    .map((t) => ({ name: String(t.name).toLowerCase(), count: t.count ?? 1 }))

  return {
    mbid: best.id,
    mbName: best.name,
    country: best.country || best.area?.['iso-3166-1-codes']?.[0] || null,
    type: best.type || null,
    disambiguation: best.disambiguation || null,
    score: best.score ?? null,
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

async function main() {
  const events = JSON.parse(await readFile('data/events.json', 'utf8'))
  const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {}

  // Every artist billed anywhere in the corpus, most-billed first so a run that
  // runs out of time has still done the artists that matter most.
  const counts = new Map()
  for (const e of events) {
    for (const a of e.artists || []) {
      if (!a || a.length < 2 || looksLikeTribute(a)) continue
      counts.set(a, (counts.get(a) || 0) + 1)
    }
  }
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)

  const budget = Number(process.env.ENRICH_LIMIT || 0) || names.length
  const todo = names.filter((n) => !isFresh(cache[foldName(n)]))
  console.log(`${names.length} distinct artists; ${todo.length} need enriching; budget ${budget}`)

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
      stats.mbHits++
      const sim = await similarArtists(mb.mbid, endpointIndex)
      if (sim.length) stats.simHits++
      else stats.simMiss++
      cache[key] = { name, checkedAt: new Date().toISOString(), ...mb, similar: sim }
    } catch (err) {
      stats.errors++
      console.error(`  ${name}: ${err.message}`)
    }
    if (++done % 25 === 0) {
      console.log(`  ${done}/${Math.min(todo.length, budget)}  mb ${stats.mbHits}/${stats.mbHits + stats.mbMiss}  similar ${stats.simHits}`)
      await writeFile(CACHE, JSON.stringify(cache, null, 0)) // survive a timeout
    }
  }

  await mkdir('data', { recursive: true })
  await writeFile(CACHE, JSON.stringify(cache, null, 0))

  // The shipped index: keyed by every spelling of the name the matcher might
  // see, so "MØ", "MO" and "Moe" all land on the same entry.
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

  await writeFile(OUT, JSON.stringify(index))
  const size = JSON.stringify(index).length

  console.log(
    `\nartists.json: ${Object.keys(index).length} keys, ${withTags} with tags, ${withSimilar} with similar artists, ${(size / 1024).toFixed(0)} KB`
  )
  console.log(`musicbrainz resolved ${stats.mbHits}/${stats.mbHits + stats.mbMiss}, errors ${stats.errors}`)
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
