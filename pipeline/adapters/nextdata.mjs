// Reading events out of a Next.js hydration payload.
//
// VEGA, Roskilde and Ideal Bar render client-side: their event pages carry no
// schema.org markup at all, and the first harvest read zero events from
// sitemaps listing hundreds of shows. But the data is right there in
// __NEXT_DATA__, and it is better than the JSON-LD other venues publish —
// VEGA's includes the ticket link, the price, the genre, the support act, and a
// status field that says when a show has been moved.
//
// The extractor is shape-driven rather than site-specific: it walks the whole
// payload looking for objects that look like an event. That way one adapter
// covers sites whose internal field names we have never seen, and a site
// redesign that renames a route does not break it.

import { politeFetch } from './../lib/http.mjs'
import { collectSitemapUrls, urlMatcher } from '../lib/sitemap.mjs'
import { stableId, cleanTitle, detectStatus, looksNonMusical } from '../lib/normalize.mjs'
import { looksLikeTribute, splitCredits } from '../../src/text.mjs'

const NEXT_RX = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i

const TITLE_KEYS = ['title', 'name', 'heading', 'fullTitle', 'resolvedTitle', 'artistName']
const DATE_KEYS = ['date', 'startDate', 'firstDate', 'start', 'startsAt', 'eventDate', 'datetime', 'when']
const TICKET_KEYS = ['purchaseAtHref', 'ticketUrl', 'ticketLink', 'buyUrl', 'href', 'url', 'link']

const isIsoish = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) return v.name.trim()
  }
  return null
}

function pickTicket(obj) {
  for (const k of TICKET_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.trim()
  }
  return null
}

/**
 * Does this object describe an event?
 *
 * Deliberately strict. A payload contains navigation entries, media records and
 * SEO metadata that all have a "title", and admitting them would fill the
 * corpus with things like "Cookie policy" dated today.
 */
function eventDates(obj) {
  const out = []
  if (Array.isArray(obj.dates)) {
    for (const d of obj.dates) {
      if (!d || typeof d !== 'object') continue
      const iso = DATE_KEYS.map((k) => d[k]).find(isIsoish)
      if (iso) out.push({ iso, node: d })
    }
  }
  if (!out.length) {
    const iso = DATE_KEYS.map((k) => obj[k]).find(isIsoish)
    if (iso) out.push({ iso, node: obj })
  }
  return out
}

function harvestNode(obj, source, pageUrl, seen) {
  const title = pickString(obj, TITLE_KEYS)
  if (!title || title.length < 2 || title.length > 160) return []
  const dates = eventDates(obj)
  if (!dates.length) return []

  // An object with a date and a title but no sign of being a show — no venue,
  // no ticket, no price, no genre — is more likely an article than a concert.
  const supporting =
    (obj.venue ? 1 : 0) +
    (obj.price != null ? 1 : 0) +
    (obj.genre || obj.genres ? 1 : 0) +
    (obj.slug ? 1 : 0) +
    (dates.some((d) => pickTicket(d.node)) ? 1 : 0)
  if (supporting < 2) return []

  const clean = cleanTitle(title)
  if (!clean || looksNonMusical(clean)) return []

  const out = []
  for (const { iso, node } of dates) {
    const date = iso.slice(0, 10)
    const time = /T(\d{2}):(\d{2})/.test(iso) ? iso.slice(11, 16) : null

    // VEGA marks a moved or cancelled show in dates[].state.name. Missing this
    // is how a show that is not happening reaches the top of a list.
    const stateName = node?.state?.name || obj?.state?.name || ''
    let status = detectStatus(`${title} ${stateName}`)
    if (/flyttet|moved|udskudt/i.test(stateName)) status = 'postponed'
    if (/aflyst|cancel/i.test(stateName)) status = 'cancelled'

    const venueName = pickString(obj.venue || {}, ['name']) || source.name
    const key = `${venueName}|${date}|${clean.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    // Support acts are billed separately in this payload, and they are exactly
    // the kind of act a good recommendation surfaces.
    const support = obj?.contributor?.contributor || obj?.support || null
    const billed = [...splitCredits(clean), ...(support ? splitCredits(String(support)) : [])]
    const artists = [...new Set(billed.map((a) => a.trim()).filter((a) => a.length >= 2))]

    const genres = [obj.genre, obj.secondaryGenre]
      .map((g) => (typeof g === 'string' ? g : g?.name || g?.title))
      .filter(Boolean)

    out.push({
      id: stableId([source.id, date, clean.toLowerCase()]),
      title: clean,
      rawTitle: clean !== title ? title : undefined,
      artists,
      headliner: artists[0] || clean,
      startDate: date,
      startTime: time,
      status,
      venue: {
        id: source.id,
        name: venueName,
        city: source.city,
        country: source.country || 'DK',
        address: null,
      },
      url: obj.slug ? `https://${source.config.host}/${source.config.slugPrefix || 'event'}/${obj.slug}` : pageUrl,
      ticketUrl: pickTicket(node) || pickTicket(obj),
      price: typeof obj.price === 'number' ? { amount: obj.price, currency: 'DKK' } : null,
      image: null,
      tags: genres,
      isTribute: looksLikeTribute(clean),
      isFestival: !!source.isFestival,
      source: {
        adapter: 'next-data',
        sourceUrl: pageUrl,
        method: 'next-data',
        fetchedAt: new Date().toISOString(),
      },
    })
  }
  return out
}

function walk(node, source, pageUrl, seen, acc, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return acc
  if (Array.isArray(node)) {
    for (const n of node) walk(n, source, pageUrl, seen, acc, depth + 1)
    return acc
  }
  acc.push(...harvestNode(node, source, pageUrl, seen))
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walk(v, source, pageUrl, seen, acc, depth + 1)
  }
  return acc
}

export function eventsFromNextData(html, source, pageUrl, seen = new Set()) {
  const m = html.match(NEXT_RX)
  if (!m) return []
  let data
  try {
    data = JSON.parse(m[1])
  } catch {
    return []
  }
  return walk(data?.props?.pageProps ?? data, source, pageUrl, seen, [])
}

export async function nextData(source) {
  const cfg = source.config
  const rejects = {}
  const seen = new Set()
  const events = []
  let fetched = 0

  const tally = (r) => (rejects[r] = (rejects[r] || 0) + 1)

  // Index pages first: one fetch that yields the whole programme beats several
  // hundred fetches that each yield one show.
  for (const path of cfg.pages || []) {
    const url = path.startsWith('http') ? path : `https://${cfg.host}${path}`
    const res = await politeFetch(url)
    if (!res) {
      tally('robots-disallow')
      continue
    }
    if (!res.ok) {
      tally(`http-${res.status}`)
      continue
    }
    fetched++
    const found = eventsFromNextData(res.text, source, url, seen)
    if (!found.length) tally('no-next-events')
    events.push(...found)
  }

  // Fall back to walking the sitemap only when the index pages did not carry
  // the programme.
  const minFromIndex = cfg.minFromIndex ?? 25
  let discovered = 0
  if (events.length < minFromIndex && (cfg.sitemap || cfg.urlPattern)) {
    const urls = await collectSitemapUrls(cfg.sitemap || `https://${cfg.host}/sitemap.xml`, {
      match: urlMatcher(cfg.urlPattern),
      maxUrls: cfg.limit ?? 300,
    })
    discovered = urls.length
    for (const url of urls.slice(0, cfg.limit ?? 300)) {
      const res = await politeFetch(url)
      if (!res) {
        tally('robots-disallow')
        continue
      }
      if (!res.ok) {
        tally(`http-${res.status}`)
        continue
      }
      fetched++
      const found = eventsFromNextData(res.text, source, url, seen)
      if (!found.length) tally('no-next-events')
      events.push(...found)
    }
  }

  return { events, rejects, fetched, discovered }
}
