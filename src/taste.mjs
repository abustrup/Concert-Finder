// Reading a listening history.
//
// Detection is by SHAPE, not by filename. Spotify has changed its export layout
// several times, people upload the zip whole or one file out of it, and a
// four-year-old export is still a perfectly good description of someone's
// taste. Sniffing the fields means every one of those works, and means a
// renamed file is not a failure.
//
// Two judgements are baked in and worth stating:
//   - Time listened beats times played. Thirty seconds of a track you skipped
//     is not evidence you want to stand in a room and hear it.
//   - Recent listening counts for more. What you had on repeat in 2019 says
//     less about which concert you would buy a ticket to this autumn. The
//     half-life is 18 months, which is long enough that a favourite band you
//     have not played this year still comfortably survives.

import { openZip } from './unzip.mjs'

const HALF_LIFE_DAYS = 548 // 18 months
const MIN_MS = 30_000 // Spotify's own threshold for "a play"

// ------------------------------------------------------------------ detection

const SHAPES = [
  {
    id: 'spotify-extended',
    label: 'Spotify extended streaming history',
    test: (o) => 'ms_played' in o && ('master_metadata_album_artist_name' in o || 'master_metadata_track_name' in o),
    read: (o) => ({
      artist: o.master_metadata_album_artist_name,
      track: o.master_metadata_track_name,
      ms: Number(o.ms_played) || 0,
      at: o.ts || o.offline_timestamp || null,
    }),
  },
  {
    id: 'spotify-classic',
    label: 'Spotify streaming history',
    test: (o) => 'msPlayed' in o && 'artistName' in o,
    // endTime is "2020-01-09 15:15": UTC, but with no marker, so JavaScript
    // reads it as LOCAL time and every play lands one or two hours out for a
    // Danish user. Only matters at the margin of the recency decay, and it is
    // one line to be right.
    read: (o) => ({
      artist: o.artistName,
      track: o.trackName,
      ms: Number(o.msPlayed) || 0,
      at: typeof o.endTime === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(o.endTime)
        ? o.endTime.replace(' ', 'T') + ':00Z'
        : o.endTime || null,
    }),
  },
  {
    id: 'spotify-marquee',
    label: 'Spotify artists you follow closely',
    test: (o) => 'artistName' in o && 'segment' in o,
    read: (o) => ({ artist: o.artistName, ms: 4 * 60_000, at: null }),
  },
  {
    id: 'listenbrainz',
    label: 'ListenBrainz listens',
    test: (o) => o.track_metadata && (o.track_metadata.artist_name || o.track_metadata.artist_credit_name),
    read: (o) => ({
      artist: o.track_metadata.artist_name || o.track_metadata.artist_credit_name,
      track: o.track_metadata.track_name,
      ms: 3.5 * 60_000,
      at: o.listened_at ? new Date(o.listened_at * 1000).toISOString() : null,
    }),
  },
  {
    id: 'generic-artist-object',
    label: 'artist list',
    test: (o) => ('artist' in o || 'artistName' in o || 'name' in o) && !('ms_played' in o) && !('msPlayed' in o),
    read: (o) => ({
      artist: o.artist || o.artistName || o.name,
      track: o.track || o.trackName || o.title || null,
      ms: Number(o.ms_played ?? o.msPlayed ?? 0) || 3 * 60_000,
      at: o.ts || o.endTime || o.date || null,
      plays: Number(o.playcount ?? o.plays ?? 0) || null,
    }),
  },
]

function detectShape(sample) {
  for (const s of SHAPES) {
    try {
      if (s.test(sample)) return s
    } catch {
      /* a shape whose test throws simply does not match */
    }
  }
  return null
}

// ---------------------------------------------------------------- CSV parsing

/** RFC4180-ish: handles quoted fields, embedded commas and doubled quotes. */
export function parseCsv(text, limit = 400_000) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const delimiter = guessDelimiter(text)

  while (i < text.length && rows.length < limit) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += c
    i++
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function guessDelimiter(text) {
  const head = text.slice(0, 4000)
  const counts = [
    [',', (head.match(/,/g) || []).length],
    [';', (head.match(/;/g) || []).length],
    ['\t', (head.match(/\t/g) || []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

const ARTIST_HEADERS = [
  'artist name', 'artist', 'artistname', 'album artist', 'artist_name',
  'kunstner', 'container artist name', 'song artist',
]
const TRACK_HEADERS = ['song name', 'track name', 'track', 'title', 'song', 'track_name']
const MS_HEADERS = ['play duration milliseconds', 'ms_played', 'msplayed', 'milliseconds played', 'duration ms']
const DATE_HEADERS = ['event start timestamp', 'timestamp', 'date played', 'ts', 'end time', 'date', 'play date time', 'last played date']
const PLAYS_HEADERS = ['plays', 'playcount', 'play count', 'count']
// Apple's daily-tracks export packs "Artist - Song" into one column.
const COMBINED_HEADERS = ['track description', 'description']

function findCol(header, names) {
  const lower = header.map((h) => String(h).trim().toLowerCase().replace(/^"|"$/g, ''))
  for (const n of names) {
    const i = lower.indexOf(n)
    if (i >= 0) return i
  }
  for (let i = 0; i < lower.length; i++) {
    if (names.some((n) => lower[i].includes(n))) return i
  }
  return -1
}

function parseCsvPlays(text) {
  const rows = parseCsv(text)
  if (rows.length < 2) return []
  const header = rows[0]
  const iArtist = findCol(header, ARTIST_HEADERS)
  const iCombined = findCol(header, COMBINED_HEADERS)
  if (iArtist < 0 && iCombined < 0) return []
  const iTrack = findCol(header, TRACK_HEADERS)
  const iMs = findCol(header, MS_HEADERS)
  const iDate = findCol(header, DATE_HEADERS)
  const iPlays = findCol(header, PLAYS_HEADERS)

  const out = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.length < 2) continue
    let artist = iArtist >= 0 ? row[iArtist] : null
    let track = iTrack >= 0 ? row[iTrack] : null
    if (!artist && iCombined >= 0) {
      const combined = String(row[iCombined] || '')
      const dash = combined.indexOf(' - ')
      if (dash > 0) {
        artist = combined.slice(0, dash)
        track = track || combined.slice(dash + 3)
      }
    }
    if (!artist || !String(artist).trim()) continue
    const plays = iPlays >= 0 ? Number(row[iPlays]) || null : null
    const ms = iMs >= 0 ? Number(row[iMs]) || 0 : plays ? plays * 3.5 * 60_000 : 3.5 * 60_000
    out.push({ artist: String(artist).trim(), track, ms, at: iDate >= 0 ? row[iDate] : null, plays })
  }
  return out
}

// --------------------------------------------------------------- JSON reading

function collectFromJson(data, plays, notes) {
  // Spotify's library and playlist files are objects wrapping arrays.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (Array.isArray(data.artists)) {
      for (const a of data.artists) {
        const name = typeof a === 'string' ? a : a?.name
        if (name) plays.push({ artist: name, ms: 6 * 60_000, at: null, from: 'library-artist' })
      }
      notes.add('followed artists')
    }
    if (Array.isArray(data.tracks)) {
      for (const t of data.tracks) {
        if (t?.artist) plays.push({ artist: t.artist, track: t.track, ms: 4 * 60_000, at: null, from: 'library-track' })
      }
      notes.add('saved tracks')
    }
    if (Array.isArray(data.albums)) {
      for (const t of data.albums) {
        if (t?.artist) plays.push({ artist: t.artist, ms: 5 * 60_000, at: null, from: 'library-album' })
      }
      notes.add('saved albums')
    }
    if (Array.isArray(data.playlists)) {
      for (const p of data.playlists) {
        for (const item of p?.items || []) {
          const tr = item?.track
          if (tr?.artistName) plays.push({ artist: tr.artistName, track: tr.trackName, ms: 2.5 * 60_000, at: item.addedDate || null, from: 'playlist' })
        }
      }
      notes.add('playlists')
    }
    // Anything else: look one level down for an array of listen-shaped objects.
    for (const v of Object.values(data)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') collectFromJson(v, plays, notes)
    }
    return
  }

  if (!Array.isArray(data) || !data.length) return
  const sample = data.find((x) => x && typeof x === 'object')
  if (!sample) return
  const shape = detectShape(sample)
  if (!shape) return
  notes.add(shape.label)
  for (const o of data) {
    if (!o || typeof o !== 'object') continue
    const rec = shape.read(o)
    if (rec.artist) plays.push({ ...rec, from: shape.id })
  }
}

// -------------------------------------------------------------------- weights

function decayFor(at, now) {
  if (!at) return 0.55 // undated evidence: real, but not fresh
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return 0.55
  const days = (now - t) / 86_400_000
  if (days < 0) return 1
  return Math.pow(0.5, days / HALF_LIFE_DAYS)
}

/**
 * Fold raw plays into ranked artists.
 *
 * The output is deliberately small: a few hundred artists with weights, which
 * is all the recommender needs and all that should ever exist in memory.
 */
export function aggregate(plays, { now = Date.now(), maxArtists = 600 } = {}) {
  const byArtist = new Map()
  let counted = 0
  let skippedShort = 0

  for (const p of plays) {
    const name = String(p.artist || '').trim()
    if (!name || name.length > 120) continue
    const ms = Number(p.ms) || 0
    // A skip is not a preference. Library and playlist entries carry a
    // synthetic duration and are never below the threshold.
    if (ms > 0 && ms < MIN_MS && p.from !== 'library-artist') {
      skippedShort++
      continue
    }
    const w = (ms || 3 * 60_000) * decayFor(p.at, now)
    const cur = byArtist.get(name) || { name, ms: 0, weightedMs: 0, plays: 0, lastAt: null }
    cur.ms += ms
    cur.weightedMs += w
    cur.plays += p.plays || 1
    if (p.at && (!cur.lastAt || p.at > cur.lastAt)) cur.lastAt = p.at
    byArtist.set(name, cur)
    counted++
  }

  const artists = [...byArtist.values()]
    .sort((a, b) => b.weightedMs - a.weightedMs)
    .slice(0, maxArtists)
    .map((a, i) => ({
      name: a.name,
      // Weighted minutes, kept unrounded: rounding to whole minutes collapsed
      // every long-decayed artist to zero and threw away the ordering of the
      // tail, which is exactly where the interesting recommendations live.
      plays: a.weightedMs / 60_000,
      rawPlays: a.plays,
      minutes: Math.round(a.ms / 60_000),
      lastAt: a.lastAt,
      rank: i,
    }))

  return { artists, counted, skippedShort, distinct: byArtist.size }
}

// ----------------------------------------------------------------------- main

/**
 * Read whatever the user gave us.
 * Accepts: a zip (ArrayBuffer), or a list of {name, text} files.
 */
export async function importListening(input, { now = Date.now() } = {}) {
  const plays = []
  const notes = new Set()
  const filesRead = []
  const problems = []

  let files = []
  let fromZip = false
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    fromZip = true
    const buf = input instanceof ArrayBuffer ? input : input.buffer
    const entries = openZip(buf)
    // Only the files that can possibly carry listening data, so a 300MB export
    // does not get inflated in full to read four of its files.
    const wanted = entries.filter(
      (e) =>
        /\.(json|csv|txt)$/i.test(e.name) &&
        !/__MACOSX|Technical|Identity|Payments|Inferences|SearchQueries|Userdata|Address|Voice/i.test(e.name)
    )
    for (const e of wanted) {
      try {
        files.push({ name: e.name, text: await e.read() })
      } catch (err) {
        problems.push(`${e.name}: ${err.message}`)
      }
    }
    if (!wanted.length) problems.push('The zip contained no .json or .csv files that could hold listening data.')
  } else {
    files = Array.isArray(input) ? input : [input]
  }

  for (const f of files) {
    const before = plays.length
    const text = f.text
    if (!text || !text.trim()) continue
    const trimmed = text.trimStart()
    try {
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        collectFromJson(JSON.parse(text), plays, notes)
      } else if (/[,;\t]/.test(text.slice(0, 500)) && text.includes('\n')) {
        const rows = parseCsvPlays(text)
        if (rows.length) {
          notes.add('spreadsheet export')
          plays.push(...rows.map((r) => ({ ...r, from: 'csv' })))
        }
      } else if (fromZip) {
        // Inside an export, a .txt file is a readme or a licence, never a list
        // of artists. Treating one as taste added "ignore me" to a library.
        continue
      } else {
        // A plain list of artist names, one per line. The manual path.
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && l.length < 120)
        if (lines.length) {
          notes.add('typed artist list')
          lines.forEach((name, i) =>
            plays.push({ artist: name, ms: 5 * 60_000 * (1 / (1 + Math.log2(i + 2))) * 10, at: null, from: 'manual' })
          )
        }
      }
    } catch (err) {
      problems.push(`${f.name}: ${err.message}`)
    }
    if (plays.length > before) filesRead.push({ name: f.name, records: plays.length - before })
  }

  const agg = aggregate(plays, { now })

  return {
    artists: agg.artists,
    stats: {
      filesConsidered: files.length,
      filesUsed: filesRead.length,
      records: agg.counted,
      distinctArtists: agg.distinct,
      skippedShortPlays: agg.skippedShort,
      kinds: [...notes],
      files: filesRead.slice(0, 40),
      problems,
    },
  }
}
