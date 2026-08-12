#!/usr/bin/env node
// Harvest: run every adapter, merge, and write the corpus.
//
// Two rules this file exists to enforce.
//
// 1. Nothing enters the corpus that an adapter did not parse out of a fetched
//    response. There is no path in this program by which a model, or a human
//    editing a JSON file, can add an event. That is what makes the listings
//    trustworthy, and it is the single most important property of the project:
//    a beautiful page advertising a concert that does not exist is worse than
//    no page at all.
//
// 2. A run that finds nothing fails. Silence and success must not look alike.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { runAdapter } from './adapters/index.mjs'
import { stats } from './lib/http.mjs'

const CONCURRENCY = 6
const HORIZON_DAYS = 400

const today = () => new Date().toISOString().slice(0, 10)

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function pool(items, worker, size) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        try {
          out[i] = await worker(items[i])
        } catch (err) {
          out[i] = { error: String(err?.stack || err), events: [], rejects: { crashed: 1 } }
        }
      }
    })
  )
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1]?.split(',') : null
  const limitOverride = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : null
  const allowEmpty = argv.includes('--allow-empty')

  const registry = JSON.parse(await readFile('pipeline/sources.json', 'utf8'))
  let sources = registry.sources
  if (only) sources = sources.filter((s) => only.includes(s.id))
  if (limitOverride) {
    sources = sources.map((s) => ({ ...s, config: { ...s.config, limit: limitOverride, maxPages: 1 } }))
  }

  console.log(`harvesting ${sources.length} sources, concurrency ${CONCURRENCY}\n`)
  const started = Date.now()

  const results = await pool(
    sources,
    async (s) => {
      const t0 = Date.now()
      const r = await runAdapter(s)
      const secs = ((Date.now() - t0) / 1000).toFixed(0)
      const rej = Object.entries(r.rejects || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ')
      console.log(
        `${s.id.padEnd(20)} ${String(r.events.length).padStart(4)} events  ` +
          `(fetched ${r.fetched ?? 0}${r.discovered ? `/${r.discovered}` : ''}, ${secs}s)  ${rej}`
      )
      return { source: s, ...r }
    },
    CONCURRENCY
  )

  const from = today()
  const to = addDays(from, HORIZON_DAYS)

  const all = []
  const perSource = []
  const dropped = { past: 0, beyondHorizon: 0, cancelled: 0, duplicate: 0 }
  const seen = new Map()

  for (const r of results) {
    let kept = 0
    for (const e of r.events || []) {
      if (e.startDate < from) {
        dropped.past++
        continue
      }
      if (e.startDate > to) {
        dropped.beyondHorizon++
        continue
      }
      if (e.status === 'cancelled') {
        dropped.cancelled++
        continue
      }
      // Same venue, same night, same billing = one event, however many pages
      // described it.
      const key = `${e.venue.id}|${e.startDate}|${e.title.toLowerCase().replace(/\s+/g, ' ')}`
      if (seen.has(key)) {
        dropped.duplicate++
        const prev = seen.get(key)
        if (!prev.ticketUrl && e.ticketUrl) prev.ticketUrl = e.ticketUrl
        if (!prev.image && e.image) prev.image = e.image
        continue
      }
      const enriched = {
        ...e,
        venue: {
          ...e.venue,
          capacity: r.source.capacity ?? null,
          sizeClass: sizeClass(r.source.capacity),
        },
      }
      seen.set(key, enriched)
      all.push(enriched)
      kept++
    }
    perSource.push({
      id: r.source.id,
      name: r.source.name,
      city: r.source.city,
      adapter: r.source.adapter,
      host: r.source.config?.host || null,
      raw: (r.events || []).length,
      kept,
      fetched: r.fetched ?? 0,
      discovered: r.discovered ?? null,
      rejects: r.rejects || {},
      error: r.error || null,
    })
  }

  all.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title))

  const meta = {
    generatedAt: new Date().toISOString(),
    runner: process.env.GITHUB_RUN_ID ? `github-actions/${process.env.GITHUB_RUN_ID}` : 'local',
    window: { from, to, horizonDays: HORIZON_DAYS },
    counts: {
      events: all.length,
      sources: sources.length,
      sourcesWithEvents: perSource.filter((s) => s.kept > 0).length,
      artists: new Set(all.flatMap((e) => e.artists)).size,
      venues: new Set(all.map((e) => e.venue.id)).size,
      withTicketUrl: all.filter((e) => e.ticketUrl).length,
      tributeFlagged: all.filter((e) => e.isTribute).length,
    },
    dropped,
    http: { requests: stats.requests, bytes: stats.bytes, errors: stats.errors.length, robotsSkips: stats.robotsSkips.length },
    perSource,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
  }

  await mkdir('data', { recursive: true })
  await writeFile('data/events.json', JSON.stringify(all, null, 1))
  await writeFile('data/harvest-meta.json', JSON.stringify(meta, null, 2))

  console.log(
    `\n${all.length} events from ${meta.counts.sourcesWithEvents}/${sources.length} sources, ` +
      `${meta.counts.venues} venues, ${meta.counts.artists} artist names, ` +
      `${meta.counts.withTicketUrl} with a ticket link`
  )
  console.log(`dropped: ${JSON.stringify(dropped)}`)
  console.log(`http: ${stats.requests} requests, ${stats.errors.length} errors, ${stats.robotsSkips.length} robots skips`)

  if (!all.length && !allowEmpty) {
    console.error('\nFAIL: harvest produced no events. Refusing to ship an empty corpus silently.')
    process.exit(2)
  }
}

function sizeClass(cap) {
  if (!cap) return null
  if (cap >= 8000) return 'arena'
  if (cap >= 2000) return 'large'
  if (cap >= 700) return 'mid'
  return 'club'
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
