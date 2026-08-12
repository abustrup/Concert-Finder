#!/usr/bin/env node
// Recon, not harvest.
//
// The sandbox this project was built in has no outbound network: every CONNECT
// to a public host answered 403, and the summarising fetch tool was blocked too.
// A GitHub runner has full network. So this script runs THERE and brings back
// the one thing that cannot be guessed: what these sites actually serve.
//
// It writes raw responses to recon/raw/ and a machine-readable summary to
// recon/report.json. Scrapers are then written against real markup instead of
// against a model's memory of what a Danish venue site probably looks like.
//
// Politeness is not decoration here. This runs against small venues' servers:
// one request at a time, a delay between them, a User-Agent that says who we
// are and links to the repo, robots.txt fetched first and obeyed for every
// content path.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const UA =
  'ConcertFinderBot/0.1 (+https://github.com/abustrup/Concert-Finder; personal non-commercial concert recommender; contact via GitHub issues)'

const OUT = 'recon'
const RAW = join(OUT, 'raw')
const MAX_BODY = 400_000 // bytes kept per response
const DELAY_MS = 900 // between requests to the SAME host
const HOST_CONCURRENCY = 6 // distinct hosts in flight
const TIMEOUT_MS = 25_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, { method = 'GET' } = {}) {
  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'da,en;q=0.8',
      },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    return {
      ok: true,
      status: res.status,
      finalUrl: res.url,
      contentType: res.headers.get('content-type') || '',
      bytes: buf.length,
      body: buf.subarray(0, MAX_BODY).toString('utf8'),
      truncated: buf.length > MAX_BODY,
      ms: Date.now() - started,
    }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

// Deliberately small and strict. When in doubt this returns "disallowed",
// because the failure we care about is hammering someone who said no.
function parseRobots(txt) {
  const groups = []
  let current = null
  for (const rawLine of String(txt).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const field = m[1].toLowerCase()
    const value = m[2].trim()
    if (field === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value })
    }
  }
  return groups
}

function robotsAllows(groups, path) {
  if (!groups.length) return true
  const star = groups.filter((g) => g.agents.includes('*'))
  const rules = (star.length ? star : []).flatMap((g) => g.rules)
  if (!rules.length) return true
  let best = null
  for (const r of rules) {
    if (r.path === '') continue
    const pattern = r.path
    // Only the two wildcards robots.txt actually defines.
    const rx = new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\\\$$/, '$') +
        (pattern.endsWith('$') ? '' : '')
    )
    if (rx.test(path)) {
      if (!best || pattern.length > best.path.length) best = r
    }
  }
  return best ? best.allow : true
}

// What a scraper author needs to know at a glance: which machine-readable
// surface, if any, this site already exposes.
function detect(body, contentType) {
  const hay = body.slice(0, 400_000)
  const signals = []
  const has = (re, name) => {
    if (re.test(hay)) signals.push(name)
  }
  has(/wp-content|wp-includes|\/wp-json/i, 'wordpress')
  has(/tribe-events|the-events-calendar|tribe_events/i, 'the-events-calendar')
  has(/squarespace/i, 'squarespace')
  has(/cdn\.shopify|Shopify\.theme/i, 'shopify')
  has(/drupal/i, 'drupal')
  has(/umbraco/i, 'umbraco')
  has(/__NEXT_DATA__/i, 'nextjs')
  has(/nuxt|__NUXT__/i, 'nuxt')
  has(/ticketmaster/i, 'ticketmaster-links')
  has(/billetlugen/i, 'billetlugen-links')
  has(/billetto/i, 'billetto-links')
  has(/eventim/i, 'eventim-links')
  has(/safeticket/i, 'safeticket-links')
  has(/ticketbutler/i, 'ticketbutler-links')
  has(/venuepoint|billetsalg/i, 'venuepoint-links')

  // The prize: schema.org Event JSON-LD. Stable, standard, and if a site
  // publishes it there is no HTML parsing to do at all.
  const ld = []
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = rx.exec(hay))) ld.push(m[1])
  let jsonLdEvents = 0
  let jsonLdTypes = new Set()
  for (const block of ld) {
    try {
      const parsed = JSON.parse(block.trim())
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk)
        if (!node || typeof node !== 'object') return
        const t = node['@type']
        const types = Array.isArray(t) ? t : t ? [t] : []
        for (const ty of types) {
          jsonLdTypes.add(String(ty))
          if (/Event$/i.test(String(ty))) jsonLdEvents++
        }
        for (const v of Object.values(node)) walk(v)
      }
      walk(parsed)
    } catch {
      /* a malformed block is itself worth knowing about, but not fatal */
    }
  }
  if (ld.length) signals.push(`json-ld:${ld.length}`)
  if (jsonLdEvents) signals.push(`json-ld-events:${jsonLdEvents}`)

  return {
    signals,
    jsonLdBlocks: ld.length,
    jsonLdEvents,
    jsonLdTypes: [...jsonLdTypes].slice(0, 25),
    isJson: /json/i.test(contentType),
  }
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'root'

async function probeHost(entry, kind) {
  const { id, host } = entry
  const base = `https://${host}`
  const result = {
    id,
    kind,
    name: entry.name,
    city: entry.city || null,
    host,
    robots: null,
    probes: [],
  }

  const rb = await get(`${base}/robots.txt`)
  let groups = []
  if (rb.ok && rb.status === 200 && /text|plain/i.test(rb.contentType)) {
    groups = parseRobots(rb.body)
    await writeFile(join(RAW, `${id}__robots.txt`), rb.body).catch(() => {})
  }
  result.robots = {
    status: rb.status,
    error: rb.error || null,
    hasRules: groups.length > 0,
    crawlDelay: (rb.body || '').match(/crawl-delay\s*:\s*([\d.]+)/i)?.[1] || null,
  }
  await sleep(DELAY_MS)

  // Content paths from the candidate list, plus the machine-readable endpoints
  // worth a shot on any site. Cheap to ask, decisive when they answer.
  const paths = [
    ...(entry.paths || ['/']),
    '/wp-json/tribe/events/v1/events?per_page=5',
    '/wp-json/wp/v2/types',
    '/events.ics',
    '/sitemap.xml',
  ]

  for (const p of paths) {
    const pathOnly = p.split('?')[0]
    if (!robotsAllows(groups, pathOnly)) {
      result.probes.push({ path: p, skipped: 'robots-disallow' })
      continue
    }
    const res = await get(base + p)
    const rec = {
      path: p,
      status: res.status,
      error: res.error || null,
      contentType: res.contentType || null,
      bytes: res.bytes || 0,
      truncated: !!res.truncated,
      finalUrl: res.finalUrl || null,
      ms: res.ms,
    }
    if (res.ok && res.body) {
      Object.assign(rec, detect(res.body, res.contentType))
      const file = `${id}__${slug(p)}.txt`
      await writeFile(join(RAW, file), res.body).catch(() => {})
      rec.raw = `recon/raw/${file}`
    }
    result.probes.push(rec)
    await sleep(DELAY_MS)
  }
  return result
}

async function probeUrl(entry, kind) {
  const res = await get(entry.url)
  const rec = {
    id: entry.id,
    kind,
    url: entry.url,
    note: entry.note || null,
    status: res.status,
    error: res.error || null,
    contentType: res.contentType || null,
    bytes: res.bytes || 0,
    ms: res.ms,
  }
  if (res.ok && res.body) {
    const file = `api__${entry.id}.txt`
    await writeFile(join(RAW, file), res.body).catch(() => {})
    rec.raw = `recon/raw/${file}`
    rec.preview = res.body.slice(0, 1200)
  }
  return rec
}

async function pool(items, worker, size) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        try {
          out[i] = await worker(items[i], i)
        } catch (err) {
          out[i] = { error: String(err?.message || err), item: items[i] }
        }
      }
    })
  )
  return out
}

// The full raw capture is tens of megabytes and belongs in an Actions artifact,
// not in git forever. What git keeps is the report plus the handful of bodies a
// scraper actually gets written against: anything that returned JSON, published
// schema.org Events, or is the front page of a reachable venue.
async function prune(report) {
  const { readdir, rm, readFile: rf, stat } = await import('node:fs/promises')
  const KEEP_BYTES = 120_000
  const keep = new Set()
  for (const h of report.hosts) {
    let kept = 0
    const ranked = (h.probes || [])
      .filter((p) => p.raw && p.status === 200)
      .sort(
        (a, b) =>
          (b.jsonLdEvents || 0) - (a.jsonLdEvents || 0) ||
          (b.isJson ? 1 : 0) - (a.isJson ? 1 : 0) ||
          (b.bytes || 0) - (a.bytes || 0)
      )
    for (const p of ranked) {
      if (kept >= 3) break
      keep.add(p.raw.replace('recon/raw/', ''))
      kept++
    }
  }
  for (const a of report.apis) if (a.raw) keep.add(a.raw.replace('recon/raw/', ''))

  let removed = 0
  let trimmed = 0
  for (const f of await readdir(RAW)) {
    if (f.endsWith('robots.txt')) continue
    if (!keep.has(f)) {
      await rm(join(RAW, f), { force: true })
      removed++
      continue
    }
    const s = await stat(join(RAW, f))
    if (s.size > KEEP_BYTES) {
      const body = await rf(join(RAW, f), 'utf8')
      await writeFile(join(RAW, f), body.slice(0, KEEP_BYTES) + '\n<!-- TRIMMED BY recon.mjs -->\n')
      trimmed++
    }
  }
  console.log(`pruned raw capture: kept ${keep.size}, removed ${removed}, trimmed ${trimmed}`)
}

async function main() {
  await mkdir(RAW, { recursive: true })
  const cfg = JSON.parse(await (await import('node:fs/promises')).readFile('pipeline/sources/candidates.json', 'utf8'))

  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : null

  const hostGroups = [
    ['venue', cfg.venues_dk],
    ['festival', cfg.festivals_dk],
    ['aggregator', cfg.aggregators],
    ['venue-eu', cfg.venues_eu || []],
  ].filter(([kind]) => !only || only === kind)

  const report = {
    generatedAt: new Date().toISOString(),
    userAgent: UA,
    runner: process.env.GITHUB_RUN_ID ? `github-actions run ${process.env.GITHUB_RUN_ID}` : 'local',
    hosts: [],
    apis: [],
  }

  for (const [kind, list] of hostGroups) {
    console.log(`\n=== ${kind}: ${list.length} hosts ===`)
    const res = await pool(list, (e) => probeHost(e, kind), HOST_CONCURRENCY)
    for (const r of res) {
      const best = (r.probes || []).filter((p) => p.status === 200)
      const jsonld = Math.max(0, ...(r.probes || []).map((p) => p.jsonLdEvents || 0))
      console.log(
        `${(r.id || '?').padEnd(26)} robots=${r.robots?.status ?? '-'} ok=${best.length}/${(r.probes || []).length} json-ld-events=${jsonld}`
      )
      report.hosts.push(r)
    }
  }

  if (!only) {
    console.log(`\n=== keyless + keyed API probes ===`)
    const apis = [
      ...cfg.keyless_apis.map((a) => [a, 'keyless']),
      ...cfg.keyed_apis_probe_only.map((a) => [a, 'keyed-probe']),
    ]
    for (const [a, kind] of apis) {
      const r = await probeUrl(a, kind)
      console.log(`${a.id.padEnd(26)} ${r.status} ${r.contentType || ''} ${r.bytes}b`)
      report.apis.push(r)
      await sleep(1100) // MusicBrainz asks for <= 1 req/s. Give everyone the same.
    }
  }

  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  await prune(report)

  const okHosts = report.hosts.filter((h) => (h.probes || []).some((p) => p.status === 200))
  const withLd = report.hosts.filter((h) => (h.probes || []).some((p) => (p.jsonLdEvents || 0) > 0))
  console.log(
    `\nreachable hosts: ${okHosts.length}/${report.hosts.length}   with schema.org Event JSON-LD: ${withLd.length}`
  )
  console.log(`wrote ${OUT}/report.json`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
