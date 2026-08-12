// The big rooms.
//
// Royal Arena, Parken, DR Koncerthuset, Amager Bio, Pumpehuset — the venues
// where most people's concerts actually happen — publish no schema.org markup,
// no Next.js payload and no REST API. The first four adapters covered fourteen
// smaller venues and none of the ones a normal person goes to, which made the
// corpus quietly unrepresentative.
//
// So this reads the page the way a person does: one event per page, the title
// in the <title>/og:title, the date somewhere in the text.
//
// That is less reliable than structured data, and the guard is precision rather
// than recall: a page whose date cannot be read CONFIDENTLY — with an explicit
// year, or in ISO form — is rejected rather than guessed at. Putting a wrong
// date in front of someone planning an evening is the worst thing this project
// can do, so this adapter would rather cover less.

import { politeFetch } from '../lib/http.mjs'
import { eventsFromHtml } from '../lib/jsonld.mjs'
import { normalizeEvent, stableId, cleanTitle, detectStatus, looksNonMusical } from '../lib/normalize.mjs'
import { bestEventDate } from '../lib/dkdate.mjs'
import { collectSitemapUrls, urlMatcher } from '../lib/sitemap.mjs'
import { looksLikeTribute, splitCredits } from '../../src/text.mjs'

const TICKET_HOSTS = [
  'billetlugen', 'ticketmaster', 'eventim', 'billetto', 'safeticket', 'ticketbutler',
  'billetten', 'livenation', 'dice.fm', 'billetsalg', 'place2book', 'kulturbillet',
  'ticketco', 'nemtilmeld', 'billet.dk', 'tikster',
]

// Titles that are a section of the site rather than a concert.
const NOT_AN_EVENT =
  /^(?:program|kalender|calendar|events?|koncerter|alle\s|forside|home|nyheder|news|billetter|tickets|om\s|about|kontakt|contact|praktisk|faq|privatliv|cookie)/i

const stripTags = (html) =>
  String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    // Hex entities matter more than decimal ones here: Danish venues emit ø as
    // &#xF8; constantly, and leaving it encoded turns "Sønderborg" into
    // gibberish that matches nothing.
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&(?:quot|apos|#39);/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function metaOf(html, names) {
  for (const n of names) {
    const rx = new RegExp(
      `<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']*)["']`,
      'i'
    )
    const m = html.match(rx) || html.match(
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${n}["']`, 'i')
    )
    if (m && m[1].trim()) return m[1].trim()
  }
  return null
}

/** "Iceage | VEGA" and "Iceage - Royal Arena" are both just "Iceage". */
function titleOf(html, venueName) {
  const raw =
    metaOf(html, ['og:title', 'twitter:title']) ||
    (html.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i)?.[1] ?? '') ||
    (html.match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i)?.[1] ?? '')
  let t = stripTags(raw)
  if (!t) return null
  // Drop a trailing site name, however it is separated.
  const parts = t.split(/\s+[|·»–—-]\s+/)
  if (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase()
    const venue = String(venueName || '').toLowerCase()
    if (venue && (last.includes(venue.split(' ')[0]) || venue.includes(last.split(' ')[0]))) {
      t = parts.slice(0, -1).join(' - ')
    }
  }
  return cleanTitle(t)
}

function ticketOf(html) {
  const links = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1])
  for (const l of links) {
    const low = l.toLowerCase()
    if (TICKET_HOSTS.some((h) => low.includes(h))) return l
  }
  return null
}

/** Links off a listing page, when the venue publishes no sitemap. */
function linksFrom(html, base, pattern) {
  const out = new Set()
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    let href = m[1]
    if (href.startsWith('//')) href = 'https:' + href
    else if (href.startsWith('/')) href = base + href
    else if (!/^https?:/i.test(href)) continue
    if (!href.startsWith(base)) continue
    if (pattern && !pattern.some((p) => href.includes(p))) continue
    out.add(href.split('?')[0])
  }
  return [...out]
}

export async function htmlEvent(source) {
  const cfg = source.config
  const base = `https://${cfg.host}`
  const rejects = {}
  const tally = (r, sample) => {
    rejects[r] = (rejects[r] || 0) + 1
    if (sample) {
      rejects._samples = rejects._samples || {}
      const l = (rejects._samples[r] = rejects._samples[r] || [])
      if (l.length < 5) l.push(String(sample).slice(0, 70))
    }
  }

  // --- discover event pages -------------------------------------------------
  let urls = []
  if (cfg.sitemap || cfg.urlPattern) {
    urls = await collectSitemapUrls(cfg.sitemap || `${base}/sitemap.xml`, {
      match: urlMatcher(cfg.urlPattern),
      maxUrls: cfg.limit ?? 300,
    })
  }
  if (!urls.length && cfg.listingPages?.length) {
    for (const path of cfg.listingPages) {
      const res = await politeFetch(path.startsWith('http') ? path : base + path)
      if (!res?.ok) {
        tally(`listing-http-${res?.status ?? 0}`)
        continue
      }
      urls.push(...linksFrom(res.text, base, cfg.linkPattern))
    }
    urls = [...new Set(urls)]
  }
  if (!urls.length) return { events: [], rejects: { 'no-event-pages-found': 1 }, fetched: 0, discovered: 0 }

  // --- read each page -------------------------------------------------------
  const events = []
  const seen = new Set()
  let fetched = 0

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

    // If the page happens to carry JSON-LD after all, prefer it — it is always
    // better than reading prose.
    const ld = eventsFromHtml(res.text)
    if (ld.nodes.length) {
      for (const node of ld.nodes) {
        const r = normalizeEvent(node, {
          venueId: source.id, venueName: source.name, city: source.city,
          country: source.country || 'DK', isFestival: !!source.isFestival,
          adapter: 'html-event', pageUrl: url, method: 'json-ld',
          fetchedAt: new Date().toISOString(),
        })
        if (r.event) {
          const key = `${r.event.startDate}|${r.event.title.toLowerCase()}`
          if (!seen.has(key)) {
            seen.add(key)
            events.push(r.event)
          }
        } else tally(r.rejected)
      }
      continue
    }

    const title = titleOf(res.text, source.name)
    if (!title || title.length < 2) {
      tally('no-title')
      continue
    }
    if (NOT_AN_EVENT.test(title)) {
      tally('section-page', title)
      continue
    }
    if (looksNonMusical(title)) {
      tally('non-musical', title)
      continue
    }

    const text = stripTags(res.text).slice(0, 8000)
    // Some venues leave past events on the site and say so in words. Trust the
    // words: it is a stronger signal than any date we could parse.
    if (/\b(?:event er afholdt|afholdt|har fundet sted|this event has passed)\b/i.test(text.slice(0, 1200))) {
      tally('already-happened', title)
      continue
    }
    const when = bestEventDate(text, { title })
    if (!when) {
      tally('no-date', title)
      continue
    }
    // The precision guard. A date with no explicit year was inferred, and on a
    // page that might be an archive that inference is a coin flip.
    if ((when.confidence ?? 0) < 0.85) {
      tally('date-not-confident', `${title} → ${when.date} (${when.confidence})`)
      continue
    }

    const key = `${when.date}|${title.toLowerCase()}`
    if (seen.has(key)) {
      tally('duplicate')
      continue
    }
    seen.add(key)

    const billed = splitCredits(title).slice(0, 6)
    events.push({
      id: stableId([source.id, when.date, title.toLowerCase()]),
      title,
      artists: [...new Set(billed.map((a) => a.trim()).filter((a) => a.length >= 2))],
      headliner: billed[0] || title,
      startDate: when.date,
      startTime: when.time,
      status: detectStatus(title),
      venue: {
        id: source.id, name: source.name, city: source.city,
        country: source.country || 'DK', address: null,
      },
      url,
      ticketUrl: ticketOf(res.text),
      price: null,
      image: metaOf(res.text, ['og:image']),
      isTribute: looksLikeTribute(title),
      isFestival: !!source.isFestival,
      source: {
        adapter: 'html-event',
        sourceUrl: url,
        method: 'html-heuristic',
        fetchedAt: new Date().toISOString(),
      },
    })
  }

  return { events, rejects, fetched, discovered: urls.length }
}
