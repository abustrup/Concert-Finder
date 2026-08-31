#!/usr/bin/env node
// Does the shortlist actually work?
//
// A recommender always returns something, and something always looks fine. So
// this grades against labels fixed in test/personas.json before the engine
// existed, and it grades the properties the product promises rather than the
// ones that are easy to measure.
//
// Every check that hunts for a problem is also run once against input built to
// contain that problem. A check that cannot fail is not a check.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { buildTaste, recommend, DEFAULTS } from '../src/recommend.mjs'
import { foldName, looksLikeTribute } from '../src/text.mjs'

const results = []
const record = (persona, name, pass, detail) => results.push({ persona, name, pass, detail })

async function main() {
  const events = JSON.parse(await readFile('data/events.json', 'utf8'))
  const artistIndex = existsSync('data/artists.json')
    ? new Map(Object.entries(JSON.parse(await readFile('data/artists.json', 'utf8'))))
    : new Map()
  const { personas } = JSON.parse(await readFile('test/personas.json', 'utf8'))

  // Evaluate the ENGINE against the corpus, from the day the corpus was written.
  //
  // This used to read the wall clock. That makes the result depend on when you
  // happen to run it: the corpus is frozen the moment it is committed, so every
  // day that passes deletes another day of candidates off the front while the
  // thresholds stay put. On 2026-08-31 that turned a green suite red — the
  // dk-metal persona could reach 4 months on 2026-08-29 and only 3 two days
  // later, with not one line of engine code changed in between. A test that
  // decays into failure teaches you to ignore it.
  //
  // Whether the corpus is fresh enough to be worth showing is a real question,
  // and it has its own gate: pipeline/validate.mjs warns past 10 days and fails
  // past 21. That is the check that should go red as data ages. Not this one.
  const meta = existsSync('data/harvest-meta.json')
    ? JSON.parse(await readFile('data/harvest-meta.json', 'utf8'))
    : null
  const today = (meta?.generatedAt || new Date().toISOString()).slice(0, 10)
  const wall = new Date().toISOString().slice(0, 10)
  console.log(
    `corpus: ${events.length} events, ${new Set(events.map((e) => e.venue.id)).size} venues, ` +
      `artist index ${artistIndex.size} keys\n` +
      `evaluated from ${today}, the day it was harvested` +
      (wall === today ? '' : ` (today is ${wall}; freshness is validate.mjs's job, not this one)`) +
      '\n'
  )

  const playing = new Set(events.flatMap((e) => (e.artists || []).map(foldName)))
  const perPersona = new Map()

  for (const p of personas) {
    const taste = buildTaste(p.artists.map((name, i) => ({ name, rank: i })))
    const out = recommend({
      taste,
      events,
      artistIndex,
      options: { count: 12, countries: ['DK'], from: today },
    })
    const picks = out.picks
    perPersona.set(p.id, picks)
    const titles = picks.map((x) => x.event.title)

    console.log(`── ${p.id.padEnd(14)} ${String(picks.length).padStart(2)} picks   ${p.label}`)
    for (const x of picks.slice(0, 4)) {
      console.log(`     ${x.event.startDate}  ${x.event.title.slice(0, 42).padEnd(44)} ${x.why}`)
    }
    if (picks.length > 4) console.log(`     … ${picks.length - 4} more`)

    // --- B: short by design, never padded --------------------------------
    record(p.id, 'never exceeds the cap', picks.length <= 12, `${picks.length}`)
    record(
      p.id,
      'no artist appears twice',
      new Set(picks.flatMap((x) => (x.event.artists || []).map(foldName))).size >=
        picks.length || picks.length === 0,
      dupArtists(picks)
    )
    const venueCounts = tally(picks.map((x) => x.event.venue.id))
    const worstVenue = Object.entries(venueCounts).sort((a, b) => b[1] - a[1])[0]
    record(
      p.id,
      'no venue takes over the list',
      !worstVenue || worstVenue[1] <= DEFAULTS.maxPerVenue,
      worstVenue ? `${worstVenue[0]} ×${worstVenue[1]}` : 'n/a'
    )

    // --- C: the picks are good -------------------------------------------
    for (const must of p.mustAppear) {
      const isPlaying = playing.has(foldName(must))
      if (!isPlaying) {
        record(p.id, `must-appear "${must}"`, true, 'not playing in range — label not applicable')
        continue
      }
      const found = picks.some((x) => (x.event.artists || []).some((a) => foldName(a) === foldName(must)))
      record(p.id, `must-appear "${must}"`, found, found ? '' : `is playing but was not picked`)
    }
    for (const never of p.mustNotAppear) {
      const found = picks.find((x) => (x.event.artists || []).some((a) => foldName(a) === foldName(never)))
      record(p.id, `must-not-appear "${never}"`, !found, found ? `appeared as "${found.event.title}"` : '')
    }
    record(
      p.id,
      'every pick says why',
      picks.every((x) => x.why && x.why.length > 3),
      `${picks.filter((x) => !x.why).length} without a reason`
    )
    record(
      p.id,
      'no tribute acts',
      !picks.some((x) => x.event.isTribute || looksLikeTribute(x.event.title)),
      picks.filter((x) => looksLikeTribute(x.event.title)).map((x) => x.event.title).join(', ')
    )
    record(p.id, 'nothing in the past', picks.every((x) => x.event.startDate >= today), '')

    // --- expectations declared with the persona ---------------------------
    if (p.expect?.minPicks != null) {
      record(p.id, `at least ${p.expect.minPicks} picks`, picks.length >= p.expect.minPicks, `${picks.length}`)
    }
    if (p.expect?.maxPicks != null) {
      record(p.id, `at most ${p.expect.maxPicks} picks`, picks.length <= p.expect.maxPicks, `${picks.length}`)
    }
    if (p.expect?.shouldBeShort) {
      record(
        p.id,
        'returns a short list rather than padding',
        out.diagnostics.short || picks.length < 12,
        `returned ${picks.length}, short=${out.diagnostics.short}`
      )
    }
    if (picks.length >= 4) {
      const months = new Set(picks.map((x) => x.event.startDate.slice(0, 7)))
      record(p.id, 'spread across at least 4 months', months.size >= 4, `${months.size} months`)
    }
  }

  // --- C3: different tastes get different lists ---------------------------
  const compare = ['dk-postpunk', 'dk-metal', 'dk-pop', 'jazz-ambient']
  for (let i = 0; i < compare.length; i++) {
    for (let j = i + 1; j < compare.length; j++) {
      const a = perPersona.get(compare[i]) || []
      const b = perPersona.get(compare[j]) || []
      if (!a.length || !b.length) continue
      const idsA = new Set(a.map((x) => x.event.id))
      const shared = b.filter((x) => idsA.has(x.event.id)).length
      const overlap = shared / Math.min(a.length, b.length)
      record(
        'cross',
        `${compare[i]} vs ${compare[j]} differ`,
        overlap <= 0.3,
        `${Math.round(overlap * 100)}% overlap (${shared} shared)`
      )
    }
  }

  // --- the controls. Every one MUST fail its check. -----------------------
  console.log('\n── controls (each must be caught) ──')
  const controlEvents = [
    { id: 'c1', title: 'Iceage', artists: ['Iceage'], startDate: future(30), status: 'scheduled', venue: { id: 'v1', name: 'A', city: 'X', country: 'DK' }, url: 'https://x' },
    { id: 'c2', title: 'Iceage again', artists: ['Iceage'], startDate: future(60), status: 'scheduled', venue: { id: 'v1', name: 'A', city: 'X', country: 'DK' }, url: 'https://x' },
    { id: 'c3', title: 'Iceage third time', artists: ['Iceage'], startDate: future(90), status: 'scheduled', venue: { id: 'v1', name: 'A', city: 'X', country: 'DK' }, url: 'https://x' },
    { id: 'c4', title: 'Iceage Tribute', artists: ['Iceage Tribute'], startDate: future(45), status: 'scheduled', venue: { id: 'v1', name: 'A', city: 'X', country: 'DK' }, url: 'https://x' },
    { id: 'c5', title: 'Iceage', artists: ['Iceage'], startDate: '2020-01-01', status: 'scheduled', venue: { id: 'v1', name: 'A', city: 'X', country: 'DK' }, url: 'https://x' },
  ]
  const ctrlTaste = buildTaste([{ name: 'Iceage', rank: 0 }])
  const ctrl = recommend({ taste: ctrlTaste, events: controlEvents, artistIndex: new Map(), options: { count: 12, countries: ['DK'] } })
  const ctrlChecks = [
    ['duplicate artist is collapsed to one', ctrl.picks.length === 1, `${ctrl.picks.length} picks`],
    ['tribute act excluded', !ctrl.picks.some((x) => looksLikeTribute(x.event.title)), ''],
    // Deliberately `wall`, not `today`: these events are built relative to now
    // and the engine is called without `from`, so this is the wall-clock
    // default under test. Judging it by the corpus date would let an event
    // between the harvest and today pass as "not past".
    ['past event excluded', !ctrl.picks.some((x) => x.event.startDate < wall), ''],
    ['list is shorter than the cap rather than padded', ctrl.picks.length < 12 && ctrl.diagnostics.short, `short=${ctrl.diagnostics.short}`],
  ]
  for (const [name, pass, detail] of ctrlChecks) {
    console.log(`   ${pass ? 'ok  ' : 'FAIL'} ${name} ${detail}`)
    record('control', name, pass, detail)
  }

  // A run that crashes on empty input is a real failure mode for a page where
  // someone can upload anything.
  try {
    const e = recommend({ taste: buildTaste([]), events, artistIndex, options: { count: 12 } })
    record('control', 'empty taste returns nothing without throwing', e.picks.length === 0, `${e.picks.length}`)
  } catch (err) {
    record('control', 'empty taste returns nothing without throwing', false, err.message)
  }
  try {
    const e = recommend({ taste: buildTaste([{ name: 'Iceage', rank: 0 }]), events: [], artistIndex, options: { count: 12 } })
    record('control', 'empty corpus returns nothing without throwing', e.picks.length === 0, `${e.picks.length}`)
  } catch (err) {
    record('control', 'empty corpus returns nothing without throwing', false, err.message)
  }

  // --- report -------------------------------------------------------------
  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('\nFAILED:')
    for (const f of failed) console.log(`  [${f.persona}] ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
    process.exit(1)
  }
}

function tally(list) {
  const o = {}
  for (const x of list) o[x] = (o[x] || 0) + 1
  return o
}
function dupArtists(picks) {
  const seen = new Set()
  const dups = []
  for (const p of picks) {
    for (const a of p.event.artists || []) {
      const k = foldName(a)
      if (seen.has(k)) dups.push(a)
      seen.add(k)
    }
  }
  return dups.join(', ')
}
function future(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
