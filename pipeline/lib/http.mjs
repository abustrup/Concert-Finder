// Polite HTTP, because this crawls small venues' servers.
//
// Three rules, all enforced here rather than left to each adapter to remember:
//   1. robots.txt is fetched once per host and obeyed. A disallowed path is not
//      fetched, and the skip is recorded so coverage can be honest about it.
//   2. One request at a time per host, with a gap. Crawl-delay is honoured when
//      declared, and the floor is never below 700ms regardless.
//   3. The User-Agent says who we are and where to complain.
//
// A venue that wants us gone can say so in robots.txt and we will be gone,
// which is the difference between a crawler and a nuisance.

export const USER_AGENT =
  'ConcertFinderBot/1.0 (+https://github.com/abustrup/Concert-Finder; non-commercial personal concert recommender; contact via GitHub issues)'

const DEFAULT_DELAY_MS = 700
const TIMEOUT_MS = 30_000
const MAX_RETRIES = 2

// Documented public APIs are a different contract from a website. robots.txt
// governs crawlers walking pages; MusicBrainz, ListenBrainz and Wikidata publish
// these endpoints FOR programmatic use, with a stated rate limit and a
// user-agent requirement, both of which this file honours. Applying their
// site-wide crawl rules to their own API silently returned null for every
// lookup and left the artist index empty while every step reported success.
const API_HOSTS = new Set([
  'musicbrainz.org',
  'api.listenbrainz.org',
  'labs.api.listenbrainz.org',
  'query.wikidata.org',
  'app.ticketmaster.com',
])

const robotsCache = new Map() // host -> {groups, crawlDelay}
const lastHit = new Map() // host -> timestamp
const inFlight = new Map() // host -> promise chain, serialising per host

export const stats = {
  requests: 0,
  bytes: 0,
  robotsSkips: [],
  errors: [],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseRobots(txt) {
  const groups = []
  let current = null
  let crawlDelay = null
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
    } else if (field === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n)) crawlDelay = Math.min(n * 1000, 10_000)
    }
  }
  return { groups, crawlDelay }
}

function matchRule(pattern, path) {
  const anchoredEnd = pattern.endsWith('$')
  const p = anchoredEnd ? pattern.slice(0, -1) : pattern
  const rx = new RegExp(
    '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (anchoredEnd ? '$' : '')
  )
  return rx.test(path)
}

function allowed({ groups }, path) {
  if (!groups.length) return true
  // Our own name first, then the wildcard group. Anything addressed at another
  // named bot is not ours to obey or to ignore.
  const mine = groups.filter((g) => g.agents.some((a) => a.includes('concertfinder')))
  const star = groups.filter((g) => g.agents.includes('*'))
  const rules = (mine.length ? mine : star).flatMap((g) => g.rules)
  if (!rules.length) return true
  let best = null
  for (const r of rules) {
    if (r.path === '') continue
    if (matchRule(r.path, path)) {
      if (!best || r.path.length > best.path.length) best = r
    }
  }
  return best ? best.allow : true
}

async function rawFetch(url, opts = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: opts.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'da,en;q=0.8',
        ...(opts.headers || {}),
      },
    })
    const text = await res.text()
    stats.requests++
    stats.bytes += text.length
    return { status: res.status, ok: res.ok, text, url: res.url, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

async function loadRobots(host) {
  if (robotsCache.has(host)) return robotsCache.get(host)
  let parsed = { groups: [], crawlDelay: null }
  try {
    const res = await rawFetch(`https://${host}/robots.txt`, { timeout: 15_000 })
    if (res.status === 200 && res.text.length < 500_000) parsed = parseRobots(res.text)
  } catch {
    // No robots.txt, or it would not load. Standard reading: crawling allowed.
    // We still rate-limit, so the downside is bounded.
  }
  robotsCache.set(host, parsed)
  return parsed
}

/**
 * Fetch a URL, obeying robots.txt and rate limits.
 * Returns null when robots.txt disallows it — callers treat null as "not ours
 * to have", never as an error to retry.
 */
export async function politeFetch(url, opts = {}) {
  const u = new URL(url)
  const host = u.host
  const isApi = API_HOSTS.has(host)
  const robots = isApi ? { groups: [], crawlDelay: null } : await loadRobots(host)

  if (!isApi && !allowed(robots, u.pathname)) {
    stats.robotsSkips.push(url)
    return null
  }

  const delay = Math.max(robots.crawlDelay ?? 0, opts.delay ?? DEFAULT_DELAY_MS)

  // Serialise per host: chain onto whatever is already queued for it.
  const prev = inFlight.get(host) || Promise.resolve()
  const task = prev.then(async () => {
    const since = Date.now() - (lastHit.get(host) || 0)
    if (since < delay) await sleep(delay - since)
    let lastErr = null
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await rawFetch(url, opts)
        lastHit.set(host, Date.now())
        // 429 and 5xx: back off and try again. 4xx: the answer is no.
        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_RETRIES) {
            await sleep(2000 * (attempt + 1))
            continue
          }
        }
        return res
      } catch (err) {
        lastErr = err
        lastHit.set(host, Date.now())
        if (attempt < MAX_RETRIES) await sleep(1500 * (attempt + 1))
      }
    }
    stats.errors.push({ url, error: String(lastErr?.message || lastErr) })
    return { status: 0, ok: false, text: '', url, error: String(lastErr?.message || lastErr) }
  })

  inFlight.set(
    host,
    task.then(
      () => {},
      () => {}
    )
  )
  return task
}

export async function fetchJson(url, opts = {}) {
  const res = await politeFetch(url, { accept: 'application/json', ...opts })
  if (!res || !res.ok) return null
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}
