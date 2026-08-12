// The adapters.
//
// Three of them cover almost every Danish venue we found, which is the whole
// argument for this shape: adding a venue is normally a line of data in
// sources.json, not new code.
//
//   jsonld-page    one page already lists many schema.org events
//   sitemap-jsonld the sitemap enumerates event pages; each page has JSON-LD
//   wp-rest        WordPress REST API exposes an event post type
//
// Every adapter returns events that carry where they came from and when. An
// event that cannot say that does not get to exist.

import { politeFetch, fetchJson } from '../lib/http.mjs'
import { eventsFromHtml, asText } from '../lib/jsonld.mjs'
import { normalizeEvent, parseDate, cleanTitle, detectStatus, looksNonMusical, stableId } from '../lib/normalize.mjs'
import { collectSitemapUrls, urlMatcher } from '../lib/sitemap.mjs'
import { looksLikeTribute, splitCredits } from '../../src/text.mjs'

const nowIso = () => new Date().toISOString()

function ctxFor(source, pageUrl, method) {
  return {
    venueId: source.id,
    venueName: source.name,
    city: source.city,
    country: source.country || 'DK',
    isFestival: !!source.isFestival,
    adapter: source.adapter,
    pageUrl,
    method,
    fetchedAt: nowIso(),
  }
}

function tally(rejects, reason) {
  rejects[reason] = (rejects[reason] || 0) + 1
}

// ---------------------------------------------------------------- jsonld-page

async function jsonldPage(source) {
  const rejects = {}
  const events = []
  const pages = source.config.pages || ['/']
  let fetched = 0

  for (const path of pages) {
    const url = path.startsWith('http') ? path : `https://${source.config.host}${path}`
    const res = await politeFetch(url)
    if (!res) {
      tally(rejects, 'robots-disallow')
      continue
    }
    if (!res.ok) {
      tally(rejects, `http-${res.status}`)
      continue
    }
    fetched++
    const { nodes } = eventsFromHtml(res.text)
    for (const node of nodes) {
      const r = normalizeEvent(node, ctxFor(source, res.url || url, 'json-ld'))
      if (r.rejected) tally(rejects, r.rejected)
      else events.push(r.event)
    }
  }
  return { events, rejects, fetched }
}

// ------------------------------------------------------------ sitemap-jsonld

async function sitemapJsonld(source) {
  const rejects = {}
  const events = []
  const cfg = source.config
  const sitemap = cfg.sitemap || `https://${cfg.host}/sitemap.xml`

  const urls = await collectSitemapUrls(sitemap, {
    match: urlMatcher(cfg.urlPattern),
    maxChildren: cfg.maxChildren ?? 25,
    maxUrls: cfg.limit ?? 400,
  })

  if (!urls.length) return { events, rejects: { 'sitemap-empty': 1 }, fetched: 0, discovered: 0 }

  let fetched = 0
  for (const url of urls.slice(0, cfg.limit ?? 400)) {
    const res = await politeFetch(url)
    if (!res) {
      tally(rejects, 'robots-disallow')
      continue
    }
    if (!res.ok) {
      tally(rejects, `http-${res.status}`)
      continue
    }
    fetched++
    const { nodes } = eventsFromHtml(res.text)
    if (!nodes.length) {
      tally(rejects, 'no-jsonld-event')
      continue
    }
    for (const node of nodes) {
      const r = normalizeEvent(node, ctxFor(source, url, 'json-ld'))
      if (r.rejected) tally(rejects, r.rejected)
      else events.push(r.event)
    }
  }
  return { events, rejects, fetched, discovered: urls.length }
}

// ------------------------------------------------------------------- wp-rest

// WordPress gives us structured posts but not structured events: the date and
// the ticket link live wherever the theme's author put them. So we read the
// obvious fields, then fall back to the rendered content, and finally to the
// post's own JSON-LD if it has any.
const WP_DATE_KEYS = [
  'event_date', 'eventDate', 'date_start', 'start_date', 'startDate', 'dato',
  'koncert_dato', 'event_start', 'start', 'spilledato', 'showtime', 'show_date',
]
const WP_TICKET_KEYS = ['ticket_url', 'ticketUrl', 'billet_url', 'billetlink', 'buy_url', 'link_til_billetter', 'ticket_link']

function digForDate(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  for (const k of WP_DATE_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.length >= 8) {
      const d = parseDate(v)
      if (d) return d
    }
    if (typeof v === 'number' && v > 1e9) {
      const d = parseDate(new Date(v * (v > 1e12 ? 1 : 1000)).toISOString())
      if (d) return d
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const d = digForDate(v, depth + 1)
      if (d) return d
    }
  }
  return null
}

function digForTicket(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null
  for (const k of WP_TICKET_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const t = digForTicket(v, depth + 1)
      if (t) return t
    }
  }
  return null
}

const stripTags = (html) =>
  String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

const DK_MONTHS = {
  januar: 1, februar: 2, marts: 3, april: 4, maj: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
}

/** "14. november 2026" and "14. nov" — the way a Danish venue writes a date. */
function danishDate(text, fallbackYear) {
  const m = String(text).match(
    /(\d{1,2})\.?\s*(januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december|jan|feb|mar|apr|jun|jul|aug|sep|okt|nov|dec)\.?\s*(\d{4})?/i
  )
  if (!m) return null
  const day = String(m[1]).padStart(2, '0')
  const mon = DK_MONTHS[m[2].toLowerCase()]
  if (!mon) return null
  const year = m[3] || fallbackYear
  return { date: `${year}-${String(mon).padStart(2, '0')}-${day}`, time: null }
}

async function wpRest(source) {
  const rejects = {}
  const events = []
  const cfg = source.config
  const base = `https://${cfg.host}/wp-json/wp/v2/${cfg.postType}`
  const perPage = cfg.perPage || 100
  const maxPages = cfg.maxPages || 5
  const thisYear = new Date().getUTCFullYear()

  let fetched = 0
  for (let page = 1; page <= maxPages; page++) {
    const list = await fetchJson(`${base}?per_page=${perPage}&page=${page}&_embed=1`)
    if (!Array.isArray(list) || !list.length) break
    fetched += list.length

    for (const post of list) {
      const rawTitle = asText(post?.title?.rendered ?? post?.title ?? '')
      const title = cleanTitle(stripTags(rawTitle))
      if (!title) {
        tally(rejects, 'no-title')
        continue
      }
      if (looksNonMusical(title)) {
        tally(rejects, 'non-musical')
        continue
      }

      // The post's own page often carries proper JSON-LD; the API rarely does.
      let when = digForDate(post)
      const contentText = stripTags(post?.content?.rendered) + ' ' + stripTags(post?.excerpt?.rendered)
      if (!when) when = danishDate(contentText.slice(0, 400), thisYear)
      if (!when && post.date) {
        // Last resort: the publish date is NOT the event date, so we refuse
        // rather than invent one. Recording the reason keeps the gap visible.
        tally(rejects, 'no-event-date')
        continue
      }
      if (!when) {
        tally(rejects, 'no-event-date')
        continue
      }

      const ticketUrl = digForTicket(post)
      const link = asText(post.link) || null
      const billed = splitCredits(title).slice(0, 6)

      events.push({
        id: stableId([source.id, when.date, title.toLowerCase()]),
        title,
        artists: [...new Set(billed.map((a) => a.trim()).filter((a) => a.length >= 2))],
        headliner: billed[0] || title,
        startDate: when.date,
        startTime: when.time,
        status: detectStatus(rawTitle),
        venue: {
          id: source.id,
          name: source.name,
          city: source.city,
          country: source.country || 'DK',
          address: null,
        },
        url: link,
        ticketUrl,
        price: null,
        image: asText(post?._embedded?.['wp:featuredmedia']?.[0]?.source_url) || null,
        isTribute: looksLikeTribute(title),
        isFestival: !!source.isFestival,
        source: {
          adapter: 'wp-rest',
          sourceUrl: `${base}?page=${page}`,
          method: 'wp-rest',
          fetchedAt: nowIso(),
        },
      })
    }
    if (list.length < perPage) break
  }
  return { events, rejects, fetched }
}

export const ADAPTERS = {
  'jsonld-page': jsonldPage,
  'sitemap-jsonld': sitemapJsonld,
  'wp-rest': wpRest,
}

export async function runAdapter(source) {
  const fn = ADAPTERS[source.adapter]
  if (!fn) return { events: [], rejects: { 'unknown-adapter': 1 }, fetched: 0 }
  return fn(source)
}
