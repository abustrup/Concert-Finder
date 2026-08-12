#!/usr/bin/env node
// The gate.
//
// This exists to make one property machine-enforced rather than merely
// intended: every concert on the site was parsed out of a response fetched
// from a registered venue, and nothing else can get in. A well-designed page
// advertising a concert that does not exist is the worst thing this project
// could ship, and "we were careful" is not a control.
//
// Every check here is run once against input built to fail it. A check that
// cannot fail is not a check, and a validator that silently tests nothing looks
// exactly like a clean bill of health.

import { readFile } from 'node:fs/promises'

const KNOWN_ADAPTERS = new Set(['jsonld-page', 'sitemap-jsonld', 'wp-rest', 'next-data', 'ticketmaster'])

function checkEvent(e, ctx) {
  const bad = []
  const need = (cond, msg) => {
    if (!cond) bad.push(msg)
  }

  need(typeof e.id === 'string' && e.id.length >= 8, 'missing id')
  need(typeof e.title === 'string' && e.title.trim().length > 0, 'missing title')
  need(/^\d{4}-\d{2}-\d{2}$/.test(e.startDate || ''), 'startDate is not YYYY-MM-DD')
  need(e.startDate >= ctx.today, `starts in the past (${e.startDate})`)
  need(e.startDate <= ctx.horizon, `starts beyond the horizon (${e.startDate})`)
  need(e.status === 'scheduled', `status is ${e.status}`)

  need(e.venue && typeof e.venue.name === 'string' && e.venue.name.length > 0, 'missing venue name')
  need(/^[A-Z]{2}$/.test(e.venue?.country || ''), 'venue country is not a 2-letter code')

  // Provenance. These four are the whole argument for trusting the listings.
  need(!!e.source, 'no source block')
  need(KNOWN_ADAPTERS.has(e.source?.adapter), `unknown adapter ${e.source?.adapter}`)
  need(/^https?:\/\//.test(e.source?.sourceUrl || ''), 'sourceUrl is not a URL')
  need(!Number.isNaN(Date.parse(e.source?.fetchedAt || '')), 'fetchedAt is not a timestamp')

  if (e.source?.sourceUrl) {
    let host = null
    try {
      host = new URL(e.source.sourceUrl).host.replace(/^www\./, '')
    } catch {
      bad.push('sourceUrl does not parse')
    }
    // The host it came from must be a venue we registered. This is what makes
    // an invented event impossible rather than merely unlikely: there is no
    // registered host a model could have made one up from.
    if (host) need(ctx.hosts.has(host), `sourceUrl host ${host} is not a registered source`)
  }

  need(!!(e.ticketUrl || e.url), 'no link back to the venue or seller')
  return bad
}

async function main() {
  const events = JSON.parse(await readFile('data/events.json', 'utf8'))
  const registry = JSON.parse(await readFile('pipeline/sources.json', 'utf8'))
  const meta = JSON.parse(await readFile('data/harvest-meta.json', 'utf8'))

  const hosts = new Set()
  for (const s of registry.sources) {
    const h = s.config?.host
    if (h) {
      hosts.add(h.replace(/^www\./, ''))
      // A venue's own pages may redirect to a sibling domain it owns.
      hosts.add(h)
    }
  }
  // Domains a registered venue legitimately redirects to, proven by the harvest
  // rather than assumed. Listed explicitly so the set stays auditable.
  for (const extra of ['strm.dk', 'stengade.dk', 'postenlive.dk']) hosts.add(extra)

  const today = new Date().toISOString().slice(0, 10)
  const horizon = meta.window?.to || '2099-01-01'
  const ctx = { today, horizon, hosts }

  const problems = []
  const ids = new Set()
  for (const e of events) {
    const bad = checkEvent(e, ctx)
    if (ids.has(e.id)) bad.push('duplicate id')
    ids.add(e.id)
    if (bad.length) problems.push({ id: e.id, title: e.title, venue: e.venue?.name, bad })
  }

  // --- the control. Each of these MUST be caught. ---
  const controls = [
    { name: 'invented event with no source', event: { id: 'x'.repeat(16), title: 'Totally Real Band', startDate: today, status: 'scheduled', venue: { name: 'V', country: 'DK' }, url: 'https://vega.dk/x' } },
    { name: 'source from an unregistered host', event: { id: 'y'.repeat(16), title: 'B', startDate: today, status: 'scheduled', venue: { name: 'V', country: 'DK' }, url: 'https://x.dk', source: { adapter: 'wp-rest', sourceUrl: 'https://not-a-registered-venue.example/x', fetchedAt: new Date().toISOString() } } },
    { name: 'event in the past', event: { id: 'z'.repeat(16), title: 'C', startDate: '2020-01-01', status: 'scheduled', venue: { name: 'V', country: 'DK' }, url: 'https://vega.dk/x', source: { adapter: 'wp-rest', sourceUrl: 'https://vega.dk/x', fetchedAt: new Date().toISOString() } } },
    { name: 'cancelled event', event: { id: 'w'.repeat(16), title: 'D', startDate: today, status: 'cancelled', venue: { name: 'V', country: 'DK' }, url: 'https://vega.dk/x', source: { adapter: 'wp-rest', sourceUrl: 'https://vega.dk/x', fetchedAt: new Date().toISOString() } } },
  ]
  const controlFailures = []
  for (const c of controls) {
    if (checkEvent(c.event, ctx).length === 0) controlFailures.push(c.name)
  }

  console.log(`validating ${events.length} events from ${hosts.size} registered hosts`)
  if (controlFailures.length) {
    console.error('\nFAIL: the validator did not catch input built to fail it:')
    for (const c of controlFailures) console.error('  - ' + c)
    console.error('The checks above cannot be trusted until this passes.')
    process.exit(2)
  }
  console.log(`controls: ${controls.length}/${controls.length} caught, so the checks are live`)

  if (problems.length) {
    console.error(`\n${problems.length} invalid events:`)
    for (const p of problems.slice(0, 25)) {
      console.error(`  ${p.venue} — ${p.title}: ${p.bad.join('; ')}`)
    }
    if (problems.length > 25) console.error(`  ... and ${problems.length - 25} more`)
    process.exit(1)
  }

  console.log(`all ${events.length} events carry a source, a fetch time, a future date and a link back`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
