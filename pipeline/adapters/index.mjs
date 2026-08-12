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
import { bestEventDate } from '../lib/dkdate.mjs'
import { looksLikeTribute, splitCredits } from '../../src/text.mjs'
import { nextData } from './nextdata.mjs'

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

function tally(rejects, reason, sample) {
  rejects[reason] = (rejects[reason] || 0) + 1
  // Keep a few examples of everything discarded. A filter that quietly eats
  // real concerts looks exactly like a filter that is working.
  if (sample) {
    rejects._samples = rejects._samples || {}
    const list = (rejects._samples[reason] = rejects._samples[reason] || [])
    if (list.length < 5) list.push(String(sample).slice(0, 70))
  }
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

async function wpRest(source) {
  const rejects = {}
  const events = []
  const cfg = source.config
  const base = `https://${cfg.host}/wp-json/wp/v2/${cfg.postType}`
  const perPage = cfg.perPage || 100
  const maxPages = cfg.maxPages || 5

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
        tally(rejects, 'non-musical', title)
        continue
      }

      // Where the date actually lives, in order of how much we trust it.
      let when = digForDate(post)
      const contentText = stripTags(post?.content?.rendered) + ' ' + stripTags(post?.excerpt?.rendered)
      if (!when) when = bestEventDate(contentText, { title })

      let ticketUrl = digForTicket(post)
      const link = asText(post.link) || null
      let pageImage = null

      // Some venues expose the post but keep the date on the rendered page
      // (skraaen and dexter return no content field at all). One extra request
      // per undated event is worth it: the alternative is dropping the venue.
      if ((!when || !ticketUrl) && link && cfg.followLinks !== false) {
        const page = await politeFetch(link)
        if (page?.ok && page.text) {
          const { nodes } = eventsFromHtml(page.text)
          if (nodes.length) {
            const r = normalizeEvent(nodes[0], ctxFor(source, link, 'wp-rest+json-ld'))
            if (r.event) {
              if (!when) when = { date: r.event.startDate, time: r.event.startTime }
              ticketUrl = ticketUrl || r.event.ticketUrl
              pageImage = r.event.image
            }
          }
          if (!when) {
            const text = stripTags(page.text).slice(0, 6000)
            when = bestEventDate(text, { title })
          }
        }
      }

      if (!when) {
        // The publish date is NOT the event date, so we refuse rather than
        // invent one. Counting the refusal keeps the gap visible.
        tally(rejects, 'no-event-date')
        continue
      }
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
        image: asText(post?._embedded?.['wp:featuredmedia']?.[0]?.source_url) || pageImage || null,
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
  'next-data': nextData,
  'jsonld-page': jsonldPage,
  'sitemap-jsonld': sitemapJsonld,
  'wp-rest': wpRest,
}

export async function runAdapter(source) {
  const fn = ADAPTERS[source.adapter]
  if (!fn) return { events: [], rejects: { 'unknown-adapter': 1 }, fetched: 0 }
  return fn(source)
}
