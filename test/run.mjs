#!/usr/bin/env node
// Unit tests for the parts where being subtly wrong is invisible.
//
// Name folding, credit splitting, tribute detection, Danish dates and the zip
// reader all fail quietly: they produce a plausible answer that is wrong, and
// the only symptom is a slightly worse recommendation nobody can trace. So they
// get tested directly rather than through the page.

import { deflateRawSync } from 'node:zlib'
import {
  foldName, foldNameNordic, foldLoose, keysFor, splitCredits,
  looksLikeTribute, nearlyEqual, editDistance,
} from '../src/text.mjs'
import { importListening, parseCsv, aggregate } from '../src/taste.mjs'
import { openZip } from '../src/unzip.mjs'
import { buildTaste, scoreEvent, recommend, usableTag, tasteTagVector } from '../src/recommend.mjs'
import { bestEventDate, findDanishDates } from '../pipeline/lib/dkdate.mjs'
import { cleanTitle, detectStatus, looksNonMusical, parseDate } from '../pipeline/lib/normalize.mjs'
import { eventsFromHtml } from '../pipeline/lib/jsonld.mjs'

let pass = 0
const fails = []
function is(actual, expected, name) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) pass++
  else fails.push(`${name}\n      got      ${a}\n      expected ${b}`)
}
function ok(cond, name, detail = '') {
  if (cond) pass++
  else fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}

// ------------------------------------------------------------- name folding

is(foldName('MØ'), 'mo', 'fold: Ø becomes o')
is(foldNameNordic('MØ'), 'moe', 'fold: Ø also becomes oe')
is(foldName('Sigur Rós'), 'sigur ros', 'fold: strips accents')
is(foldName('Trentemøller'), 'trentemoller', 'fold: Danish ø mid-word')
is(foldName('Blur & Oasis'), 'blur and oasis', 'fold: & becomes and')
is(foldLoose('The xx'), 'xx', 'fold: drops leading article')
ok(keysFor('Skråen').includes('skraaen'), 'keys: å yields the aa spelling')
ok(keysFor('MØ').includes('mo') && keysFor('MØ').includes('moe'), 'keys: both Ø spellings')

// The whole point of folding: two real spellings of the same act collide.
ok(keysFor('MØ').some((k) => keysFor('MO').includes(k)), 'MØ and MO collide')
ok(!keysFor('Mew').some((k) => keysFor('Men').includes(k)), 'Mew and Men do NOT collide')

// ---------------------------------------------------------- credit splitting

ok(splitCredits('Iceage + Lower').includes('Lower'), 'split: plus separates a bill')
ok(splitCredits('COFFINS + DEAD VOID').includes('DEAD VOID'), 'split: real Loppen billing')
is(splitCredits('Nick Cave and the Bad Seeds'), ['Nick Cave and the Bad Seeds'], 'split: "and the" never splits')
is(splitCredits('Simon & Garfunkel').length > 1, true, 'split: ampersand does split (accepted cost)')
ok(splitCredits('Earth, Wind & Fire')[0] === 'Earth, Wind & Fire', 'split: known comma bands stay whole')
ok(splitCredits('MØ feat. Diplo').includes('Diplo'), 'split: feat.')

// ------------------------------------------------------------------ tributes

for (const t of ['The Bowie Tribute', 'Amy Winehouse Tribute', 'George Michael Experience', 'Hyldest til Kim Larsen', 'ABBA Karaoke', 'The Music of Hans Zimmer', 'Creedence Experience'])
  ok(looksLikeTribute(t), `tribute: "${t}"`)
for (const t of ['Iceage', 'The Minds of 99', 'Jimi Hendrix Experience', 'Efterklang', 'BAEST'])
  ok(!looksLikeTribute(t), `not a tribute: "${t}"`)

// ------------------------------------------------------------- near matching

ok(nearlyEqual('efterklang', 'efterklung'), 'near: one letter in a long name')
ok(!nearlyEqual('mew', 'men'), 'near: refuses short names')
ok(!nearlyEqual('blur', 'blue'), 'near: refuses short names even at distance 1')
is(editDistance('abc', 'abd', 2), 1, 'edit distance')

// --------------------------------------------------------------- danish dates

const TODAY = new Date('2026-08-12T00:00:00Z')
is(bestEventDate('Onsdag 11. november 2026', { today: TODAY })?.date, '2026-11-11', 'date: named month with year')
is(bestEventDate('Den 27. august', { today: TODAY })?.date, '2026-08-27', 'date: no year guesses forward')
is(bestEventDate('Koncert 3. februar', { today: TODAY })?.date, '2027-02-03', 'date: no year rolls into next year')
is(bestEventDate('11.11.26', { today: TODAY })?.date, '2026-11-11', 'date: dd.mm.yy Danish order')
is(bestEventDate('11.11.26', { today: TODAY })?.time, null, 'date: does not read a time out of the date digits')
is(bestEventDate('4. september kl. 20.00', { today: TODAY })?.time, '20:00', 'date: time after a clock word')
is(bestEventDate('2026-09-11T20:30', { today: TODAY })?.time, '20:30', 'date: ISO time')
is(
  bestEventDate('Vi spillede her 4. maj 2019, og nu kommer vi igen 2. oktober', { today: TODAY })?.date,
  '2026-10-02',
  'date: prefers the future date over a past one in the same sentence'
)
ok(findDanishDates('13/32/2026', { today: TODAY }).length === 0, 'date: refuses an impossible day')
is(parseDate('2026-08-13T20:30')?.time, '20:30', 'normalize: naive datetime keeps the venue local time')

// ------------------------------------------------------------ title cleaning

is(cleanTitle('UDSOLGT: The Minds of 99'), 'The Minds of 99', 'title: strips sold-out prefix')
is(cleanTitle('EKSTRAKONCERT - Efterklang'), 'Efterklang', 'title: strips extra-concert prefix')
is(detectStatus('AFLYST: Bikstok'), 'cancelled', 'status: AFLYST means cancelled')
is(detectStatus('Iceage'), 'scheduled', 'status: default scheduled')
ok(looksNonMusical('Kassettebåndsmusikquiz'), 'non-music: Danish compound with quiz inside')
ok(looksNonMusical('Fyraftenssang i Toldkammergården'), 'non-music: community singing')
ok(!looksNonMusical('Jazzkoncert med Cæcilie Norby'), 'non-music: a real jazz concert survives')
ok(!looksNonMusical('Efterklang'), 'non-music: a band name survives')

// ------------------------------------------------------------------- json-ld

const LD = `<html><script type="application/ld+json">[{"@context":"https://schema.org","@type":"MusicEvent","name":"COFFINS + DEAD VOID","startDate":"2026-08-13T20:30","location":{"@type":"Place","name":"Musik Loppen"},"offers":{"@type":"Offer","url":"https://x/t","price":"175"}}]</script></html>`
const found = eventsFromHtml(LD)
is(found.nodes.length, 1, 'json-ld: finds the event')
is(found.nodes[0].name, 'COFFINS + DEAD VOID', 'json-ld: reads the name')
const BROKEN = `<script type="application/ld+json">{"@type":"MusicEvent","name":"X","startDate":"2026-08-13",}</script>`
is(eventsFromHtml(BROKEN).nodes.length, 1, 'json-ld: repairs a trailing comma')

// ----------------------------------------------------------------- zip reader

function makeZip(files) {
  // Minimal writer, only so the reader can be tested against real bytes.
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const comp = deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, comp)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + comp.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}
function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = []
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })())
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

await (async () => {
  const history = JSON.stringify([
    { ts: '2026-06-01T20:00:00Z', ms_played: 210000, master_metadata_album_artist_name: 'Iceage', master_metadata_track_name: 'Catch It' },
    { ts: '2026-06-02T20:00:00Z', ms_played: 200000, master_metadata_album_artist_name: 'MØ', master_metadata_track_name: 'Final Song' },
  ])
  const zip = makeZip([
    ['Spotify Extended Streaming History/Streaming_History_Audio_2026_0.json', history],
    ['README.txt', 'ignore me'],
  ])
  const entries = openZip(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength))
  ok(entries.length === 2, 'zip: lists both entries', `${entries.length}`)
  const text = await entries[0].read()
  is(JSON.parse(text).length, 2, 'zip: inflates the json')

  const imported = await importListening(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength))
  is(imported.artists.length, 2, 'zip: import reads both artists')
  ok(imported.artists.some((a) => a.name === 'MØ'), 'zip: keeps the Danish letter intact')

  // Adversarial: things a person will actually drop in.
  let threw = null
  try {
    const junk = Buffer.from('this is not a zip file at all')
    openZip(junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.byteLength))
  } catch (e) {
    threw = e
  }
  ok(threw && /not a zip/i.test(threw.message), 'zip: a non-zip fails with a readable message')

  const empty = await importListening([{ name: 'x.json', text: '{}' }])
  is(empty.artists.length, 0, 'import: empty json yields nothing, no crash')
  const junk = await importListening([{ name: 'x.json', text: '{"nope": [1,2,3]}' }])
  is(junk.artists.length, 0, 'import: unrecognised json yields nothing, no crash')
  const broken = await importListening([{ name: 'x.json', text: '{"unclosed": ' }])
  ok(broken.stats.problems.length === 1, 'import: malformed json is reported, not thrown')
})()

// ---------------------------------------------------------------------- csv

is(parseCsv('a,b\n1,"two, three"')[1][1], 'two, three', 'csv: quoted comma')
is(parseCsv('a;b\n1;2')[1][1], '2', 'csv: semicolon delimiter')
is(parseCsv('a,b\n1,"he said ""hi"""')[1][1], 'he said "hi"', 'csv: escaped quotes')

// ------------------------------------------------------------------ weights

const agg = aggregate([
  { artist: 'Recent', ms: 200000, at: '2026-08-01T00:00:00Z' },
  { artist: 'Old', ms: 200000, at: '2022-08-01T00:00:00Z' },
], { now: Date.parse('2026-08-12T00:00:00Z') })
ok(agg.artists[0].name === 'Recent', 'weights: recent listening outranks old listening')
const skip = aggregate([{ artist: 'Skipped', ms: 5000, at: '2026-08-01T00:00:00Z' }], {})
is(skip.artists.length, 0, 'weights: a five-second play is not a preference')

// ---------------------------------------------------------------- the engine

const taste = buildTaste([{ name: 'Iceage', rank: 0 }, { name: 'Lower', rank: 1 }])
const ev = { id: 'e', title: 'Iceage', artists: ['Iceage'], startDate: '2027-01-08', status: 'scheduled', venue: { id: 'v', name: 'V', country: 'DK' } }
const scored = scoreEvent(ev, taste, new Map(), new Map())
ok(scored && scored.best.kind === 'direct', 'engine: a direct match scores as direct')
ok(scored.score > 0.5, 'engine: a direct match on the top artist scores high', String(scored?.score))

const noMatch = scoreEvent({ ...ev, artists: ['Someone Else'], title: 'Someone Else' }, taste, new Map(), new Map())
is(noMatch, null, 'engine: no evidence means no score, never a default')

// Similar-artist evidence, which is where most of the value should come from.
const index = new Map([['communions', { name: 'Communions', tags: [], similar: [{ name: 'Iceage', score: 0.9 }] }]])
const simScored = scoreEvent(
  { id: 'e2', title: 'Communions', artists: ['Communions'], startDate: '2027-01-09', status: 'scheduled', venue: { id: 'v', name: 'V', country: 'DK' } },
  taste, index, new Map()
)
ok(simScored && simScored.best.kind === 'similar', 'engine: similar-artist evidence is found')
is(simScored.best.via, 'Iceage', 'engine: the explanation names the artist the user actually listens to')

// ------------------------------------------------- tags nobody gets matched on
//
// The artist resolver once matched a Danish booking called "Absurd" to a German
// NSBM band that merely shares the name, and its tags would then have become a
// dimension the engine matched people on. Two things now stop that: the resolver
// refuses an identity it cannot corroborate, and the engine refuses the tag even
// if a bad index reaches it. Only the second is testable from here, and until
// now nothing asserted it — so a future edit could have deleted the backstop in
// silence. These tests fail if it goes.

for (const t of ['nsbm', 'national socialist black metal', 'nazi punk', 'white power', 'fascist', 'white supremacist'])
  is(usableTag(t), null, `backstop: "${t}" can never become a taste dimension`)
is(usableTag('black metal'), 'black metal', 'backstop: the genre standing next to it is untouched')
is(usableTag('hardcore punk'), 'hardcore punk', 'backstop: ordinary tags pass through')

// The guarantee that matters is not that one string is filtered, it is that a
// banned tag cannot be the thing connecting a listener to a concert. Here it is
// the ONLY thing the two acts share, and it is the heaviest tag on both.
// The other tag on each side is a real genre and the two are unrelated, so with
// the backstop in place there is nothing left to connect them. Take the
// backstop out and the banned tag — the heaviest on both — matches them.
const poisoned = new Map([
  ['listener band', { name: 'Listener Band', tags: [{ name: 'nsbm', count: 9 }, { name: 'shoegaze', count: 1 }], similar: [] }],
  ['playing band', { name: 'Playing Band', tags: [{ name: 'nsbm', count: 9 }, { name: 'doom metal', count: 1 }], similar: [] }],
])
const poisonTaste = buildTaste([{ name: 'Listener Band', rank: 0 }])
const poisonUserTags = tasteTagVector(poisonTaste, poisoned)
ok(!poisonUserTags.has('nsbm'), 'backstop: a banned tag never enters the listener profile')
ok(poisonUserTags.has('shoegaze'), 'backstop: the rest of the profile survives the filter')
is(
  scoreEvent(
    { id: 'p', title: 'Playing Band', artists: ['Playing Band'], startDate: '2027-02-01', status: 'scheduled', venue: { id: 'v', name: 'V', country: 'DK' } },
    poisonTaste, poisoned, poisonUserTags
  ),
  null,
  'backstop: two acts sharing only a banned tag are not a match'
)

// The cap is a hard promise.
const many = Array.from({ length: 200 }, (_, i) => ({
  id: 'x' + i, title: 'Band ' + i, artists: ['Band ' + i], startDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
  status: 'scheduled', venue: { id: 'v' + (i % 9), name: 'V', country: 'DK' },
}))
const bigTaste = buildTaste(many.map((m, i) => ({ name: m.artists[0], rank: i })))
for (const n of [5, 12, 20]) {
  const r = recommend({ taste: bigTaste, events: many, artistIndex: new Map(), options: { count: n, countries: ['DK'], from: '2026-01-01' } })
  ok(r.picks.length <= n, `engine: never exceeds a cap of ${n}`, `${r.picks.length}`)
}
const over = recommend({ taste: bigTaste, events: many, artistIndex: new Map(), options: { count: 999, countries: ['DK'], from: '2026-01-01' } })
ok(over.picks.length <= 20, 'engine: a cap above 20 is clamped to 20', `${over.picks.length}`)

// ---------------------------------------------------------------------- done

console.log(`${pass} passed, ${fails.length} failed`)
if (fails.length) {
  console.log('\nFAILED:')
  for (const f of fails) console.log('  ' + f)
  process.exit(1)
}
