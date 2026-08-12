// Europe and the world, behind one free key.
//
// The Danish adapters read venues' own websites, which is what makes the Danish
// half good. That approach does not scale to "every country" — nobody is going
// to register three hundred European venues by hand. Ticketmaster's Discovery
// API is the one source in the whole landscape that is free, self-service,
// worldwide, and explicitly covers DK/SE/NO/DE at once.
//
// IT IS OFF UNTIL SOMEONE TURNS IT ON, and turning it on is a decision rather
// than a setting:
//
//   1. A free key from developer.ticketmaster.com, stored as the GitHub Actions
//      secret TICKETMASTER_API_KEY. It must never appear in this public repo or
//      in the published page — the build-time architecture gives that for free.
//   2. A repository variable ENABLE_TICKETMASTER = true.
//   3. A read of Ticketmaster's Terms of Use, specifically the caching section,
//      BEFORE the first run. Their terms limit how long event content may be
//      stored, and a public repository is durable republication rather than a
//      cache. That is a judgement call about someone else's terms, so it is the
//      repository owner's to make, not this file's.
//
// Untested: the sandbox this was written in had no key and no network, so this
// adapter has never executed. Run it once with a small --limit and read the
// output before trusting a schedule.

import { fetchJson } from '../lib/http.mjs'
import { stableId, cleanTitle, looksNonMusical, parseDate } from '../lib/normalize.mjs'
import { looksLikeTribute, splitCredits } from '../../src/text.mjs'

const BASE = 'https://app.ticketmaster.com/discovery/v2/events.json'
const PAGE_SIZE = 199 // 200 is the documented max; stay a hair under it
const DEEP_PAGE_CAP = 1000 // the API refuses to page past this within one query

const pad = (n) => String(n).padStart(2, '0')

/**
 * Month-sized windows.
 *
 * Deep paging stops at 1000 results per query, so a whole year of one country
 * silently truncates. Partitioning by month keeps every partition under the cap
 * and makes the truncation visible when it does happen.
 */
function monthWindows(from, months) {
  const out = []
  const start = new Date(from + 'T00:00:00Z')
  for (let i = 0; i < months; i++) {
    const a = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
    const b = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 1))
    out.push({
      from: `${a.getUTCFullYear()}-${pad(a.getUTCMonth() + 1)}-01T00:00:00Z`,
      to: `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-01T00:00:00Z`,
    })
  }
  return out
}

function normalize(ev, source, country) {
  const rawTitle = String(ev.name || '')
  const title = cleanTitle(rawTitle)
  if (!title || looksNonMusical(title)) return null

  const local = ev.dates?.start?.localDate
  const when = local ? parseDate(local) : null
  if (!when) return null

  const status = ev.dates?.status?.code
  if (status && status !== 'onsale' && status !== 'offsale') return null

  const venue = ev._embedded?.venues?.[0] || {}
  const attractions = (ev._embedded?.attractions || []).map((a) => a.name).filter(Boolean)
  const billed = attractions.length ? attractions : splitCredits(title)
  const artists = [...new Set(billed.map((a) => String(a).trim()).filter((a) => a.length >= 2))]

  const priceRange = (ev.priceRanges || [])[0]
  const genres = (ev.classifications || [])
    .flatMap((c) => [c.genre?.name, c.subGenre?.name])
    .filter((g) => g && g !== 'Undefined')

  const venueId = `tm-${venue.id || 'unknown'}`
  return {
    id: stableId([venueId, when.date, title.toLowerCase()]),
    title,
    artists,
    headliner: artists[0] || title,
    startDate: when.date,
    startTime: ev.dates?.start?.localTime ? String(ev.dates.start.localTime).slice(0, 5) : null,
    status: 'scheduled',
    venue: {
      id: venueId,
      name: venue.name || 'Unknown venue',
      city: venue.city?.name || null,
      country: String(venue.country?.countryCode || country || '').toUpperCase().slice(0, 2),
      address: venue.address?.line1 || null,
    },
    url: ev.url || null,
    ticketUrl: ev.url || null,
    price: priceRange?.min != null ? { amount: priceRange.min, currency: priceRange.currency || null } : null,
    image: (ev.images || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null,
    tags: genres,
    isTribute: looksLikeTribute(title),
    isFestival: false,
    source: {
      adapter: 'ticketmaster',
      // The query, not the key. The key must never reach a committed file.
      sourceUrl: `${BASE}?countryCode=${country}&classificationName=music`,
      method: 'discovery-api',
      fetchedAt: new Date().toISOString(),
    },
  }
}

export async function ticketmaster(source) {
  const rejects = {}
  const tally = (r) => (rejects[r] = (rejects[r] || 0) + 1)

  const key = process.env.TICKETMASTER_API_KEY
  if (!key) return { events: [], rejects: { 'no-api-key': 1 }, fetched: 0, disabled: true }

  const cfg = source.config || {}
  const countries = cfg.countries || ['DK']
  const months = cfg.months || 12
  const from = new Date().toISOString().slice(0, 10)
  const events = []
  let fetched = 0
  let truncated = 0

  for (const country of countries) {
    for (const w of monthWindows(from, months)) {
      for (let page = 0; page < Math.ceil(DEEP_PAGE_CAP / PAGE_SIZE); page++) {
        const url =
          `${BASE}?apikey=${encodeURIComponent(key)}&countryCode=${country}` +
          `&classificationName=music&size=${PAGE_SIZE}&page=${page}` +
          `&startDateTime=${w.from}&endDateTime=${w.to}&sort=date,asc`
        // 2 requests a second is the conservative reading of two conflicting
        // numbers in their docs; being slower than asked costs nothing here.
        const data = await fetchJson(url, { delay: 550 })
        if (!data) {
          tally('request-failed')
          break
        }
        const batch = data._embedded?.events || []
        fetched += batch.length
        for (const ev of batch) {
          const e = normalize(ev, source, country)
          if (e) events.push(e)
          else tally('rejected')
        }
        const totalPages = data.page?.totalPages ?? 0
        const totalElements = data.page?.totalElements ?? 0
        if (totalElements > DEEP_PAGE_CAP) truncated++
        if (page + 1 >= totalPages) break
      }
    }
  }

  // No silent caps: if a month-country partition really held more than the API
  // will page through, the report says so rather than quietly dropping the tail.
  if (truncated) rejects['partition-over-1000-truncated'] = truncated

  return { events, rejects, fetched }
}
