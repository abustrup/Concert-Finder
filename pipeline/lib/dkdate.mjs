// Reading a Danish date out of prose.
//
// The WordPress venues do not publish a date field. They publish a page that
// says "Onsdag 11. november 2026" or "(ons.) 11.11.26" or "Den 27. august", and
// the date is only ever in the words. Eleven venues depend on this file.
//
// The rule that matters: when a year is missing, guess FORWARD. A venue's
// programme page is advertising something that has not happened yet, so
// "27. august" seen in December means next August, not the one just gone.

const MONTHS = {
  januar: 1, jan: 1,
  februar: 2, feb: 2,
  marts: 3, mar: 3,
  april: 4, apr: 4,
  maj: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
  // English, because bilingual venue sites are common
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10,
}

const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')

const pad = (n) => String(n).padStart(2, '0')

function iso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const s = `${y}-${pad(m)}-${pad(d)}`
  const check = new Date(`${s}T12:00:00Z`)
  if (Number.isNaN(check.valueOf()) || check.getUTCDate() !== d) return null
  return s
}

/** Two-digit years are this century. A venue is not advertising 1926. */
function fullYear(y) {
  const n = Number(y)
  if (n >= 1000) return n
  return 2000 + n
}

function forwardYear(month, day, today) {
  const y = today.getUTCFullYear()
  const candidate = iso(y, month, day)
  if (candidate && candidate >= today.toISOString().slice(0, 10)) return y
  return y + 1
}

/**
 * Find every date-looking thing in a string, most explicit first.
 * Returns [{date, time, confidence, matched}].
 */
export function findDanishDates(text, { today = new Date() } = {}) {
  const s = String(text || '').replace(/ /g, ' ')
  const out = []
  const push = (date, time, confidence, matched, index) => {
    if (date) out.push({ date, time: time || null, confidence, matched, index })
  }

  // 2026-11-11, optionally with a time
  for (const m of s.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2})[:.](\d{2}))?/g)) {
    push(iso(+m[1], +m[2], +m[3]), m[4] ? `${pad(+m[4])}:${m[5]}` : null, 1.0, m[0], m.index)
  }

  // 11. november 2026 / 11 november 2026 / onsdag den 11. november 2026
  const named = new RegExp(
    `\\b(\\d{1,2})\\.?\\s*(${MONTH_ALT})\\.?\\s*(\\d{4})?`,
    'gi'
  )
  for (const m of s.matchAll(named)) {
    const day = +m[1]
    const month = MONTHS[m[2].toLowerCase()]
    if (!month) continue
    const year = m[3] ? +m[3] : forwardYear(month, day, today)
    push(iso(year, month, day), null, m[3] ? 0.95 : 0.7, m[0], m.index)
  }

  // 11.11.26 / 11.11.2026 / 11-11-2026 / 11/11/2026  (Danish order: day first)
  for (const m of s.matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b/g)) {
    const day = +m[1]
    const month = +m[2]
    if (month > 12) continue // clearly not day-first; refuse rather than guess
    push(iso(fullYear(m[3]), month, day), null, 0.85, m[0], m.index)
  }

  return out.sort((a, b) => b.confidence - a.confidence || a.index - b.index)
}

const LABELS = /(?:^|\b)(?:dato|date|spilledato|koncertdato|når|when|tid|dag)\b/gi

/**
 * The single best date for an event, given its title and body text.
 *
 * Preference order, and each step exists because of a real failure seen in the
 * harvest: a date next to a "Dato"/"Date" label beats one buried in a
 * paragraph; an explicit year beats an inferred one; and a date in the future
 * beats one in the past, because a past date in a programme page is almost
 * always a mention of a previous edition rather than the event on sale.
 */
export function bestEventDate(text, { today = new Date(), title = '' } = {}) {
  // ONE string for everything. Candidate indices are offsets into the searched
  // text, so searching the title-prefixed string and then slicing the bare one
  // shifts every window by the length of the prefix — which silently ate the
  // "k" of "kl. 20.00" and lost every doors time on the site.
  const hay = `${title} ${String(text || '')}`
  const candidates = findDanishDates(hay, { today })
  if (!candidates.length) return null

  const todayIso = today.toISOString().slice(0, 10)
  const labelPositions = [...hay.matchAll(LABELS)].map((m) => m.index)

  const scored = candidates.map((c) => {
    let score = c.confidence
    if (c.date >= todayIso) score += 0.5
    else score -= 0.35
    for (const lp of labelPositions) {
      const d = Math.abs(c.index - lp)
      if (d < 60) {
        score += 0.4 * (1 - d / 60)
        break
      }
    }
    // Earlier in the document is more likely to be the event's own date than a
    // date mentioned deep in a description.
    score += Math.max(0, 0.2 * (1 - c.index / 1500))
    return { ...c, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const winner = scored[0]

  // A time, if one sits near the winning date — but never read it out of the
  // date's own digits. "11.11.26" was being parsed as 11:11, which is how the
  // first pass gave a November concert a doors time of eleven in the morning.
  let time = winner.time
  if (!time) {
    const start = Math.max(0, winner.index - 140)
    const before = hay.slice(start, winner.index)
    const after = hay.slice(winner.index + (winner.matched?.length || 0), winner.index + 240)
    const near = `${before}  ${after}`
    // A colon is unambiguous. A dot only counts when a Danish clock word says
    // so, because dots are also how Danes write dates.
    const t =
      near.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/) ||
      near.match(/\b(?:kl\.?|klokken|doors?|dørene?|start)\s*([01]?\d|2[0-3])[.:]([0-5]\d)\b/i)
    if (t) time = `${pad(+t[1])}:${t[2]}`
  }

  return { date: winner.date, time, confidence: winner.confidence, matched: winner.matched }
}
