// Name matching, which in this project is most of the accuracy.
//
// Everything downstream depends on deciding that the "MØ" in someone's Spotify
// export and the "MO" on a venue's programme page are the same artist, while
// "The Doors" and "The Doors Alive" are not. Both mistakes are expensive: the
// first loses a recommendation the person would have loved, the second
// recommends a tribute band as the real thing.

/**
 * Fold a name to a comparable key.
 *
 * Danish is the reason this is not just toLowerCase(). Ø, Æ and Å survive
 * inconsistently through venue CMSs, ticketing systems and Spotify exports, and
 * the conventional transliterations (ø->oe, å->aa) compete with the lazy ones
 * (ø->o, å->a). We generate the lazy fold as the primary key and keep the
 * conventional one as an alias, so both spellings collide on purpose.
 */
export function foldName(input) {
  if (!input) return ''
  return String(input)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents: é -> e
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .replace(/å/gi, 'a')
    .replace(/ß/gi, 'ss')
    .replace(/[''`´]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The conventional Danish transliteration, kept as a second key. */
export function foldNameNordic(input) {
  if (!input) return ''
  return foldName(
    String(input)
      .replace(/ø/g, 'oe')
      .replace(/Ø/g, 'Oe')
      .replace(/æ/g, 'ae')
      .replace(/Æ/g, 'Ae')
      .replace(/å/g, 'aa')
      .replace(/Å/g, 'Aa')
  )
}

const LEADING_ARTICLES = /^(the|de|det|den|la|le|les|los|el|der|die|das)\s+/

/** Drop a leading article so "The xx" and "xx" collide. */
export function foldLoose(input) {
  const f = foldName(input)
  return f.replace(LEADING_ARTICLES, '')
}

export function keysFor(name) {
  const a = foldName(name)
  const b = foldNameNordic(name)
  const c = foldLoose(name)
  return [...new Set([a, b, c].filter(Boolean))]
}

// Credit separators. A listening export gives "Artist feat. Guest" or
// "A & B" as one string; a venue bill gives "A + B + C" as one string. Both
// need splitting into the artists a person would recognise.
const SPLIT_RX =
  /\s+(?:feat\.?|featuring|ft\.?|med|with|w\/|vs\.?|versus|x|og|and|&|\+|,|·|•|\/)\s+/gi

/**
 * Split a credit string into candidate artist names.
 *
 * Deliberately conservative: "Simon & Garfunkel" and "Nick Cave and the Bad
 * Seeds" must NOT split, so a part shorter than 2 characters or matching a
 * known-inseparable pattern collapses back. Getting this wrong invents artists
 * that do not exist, which then fail to match anything and quietly cost recall.
 */
export function splitCredits(raw) {
  if (!raw) return []
  const s = String(raw).trim()
  if (!s) return []

  // Bands whose names contain a separator. A split here is always wrong.
  if (/\b(?:and|&)\s+the\s+/i.test(s)) return [s]
  if (/^(?:earth,\s*wind|crosby,\s*stills|emerson,\s*lake|blood,\s*sweat)/i.test(s)) return [s]

  const parts = s
    .split(SPLIT_RX)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2)

  if (parts.length <= 1) return [s]
  // If splitting produced fragments that are mostly tiny, distrust it.
  const avg = parts.reduce((n, p) => n + p.length, 0) / parts.length
  if (avg < 3) return [s]
  return [...new Set([s, ...parts])]
}

/** The name a human would call the act, from a credit string. */
export function primaryArtist(raw) {
  const parts = splitCredits(raw)
  return parts.length ? parts[parts.length > 1 ? 1 : 0] : String(raw || '')
}

// Tribute, covers and karaoke acts. Songkick is full of these and they are the
// most annoying possible false positive: the user sees a name they love, and it
// is four strangers playing the hits.
//
// Danish and English both, because a Copenhagen venue will bill "Rammstein
// Tribute" and "Hyldest til Kim Larsen" in the same programme.
const TRIBUTE_PATTERNS = [
  /\btribute\b/i,
  /\btributes?\s+to\b/i,
  /\bhyldest\b/i,
  /\bcover(?:s|band|-band)?\b/i,
  /\bkaraoke\b/i,
  /\bexperience\b(?!\s*(?:hendrix)\b)/i,
  /\bperforms?\s+the\s+music\s+of\b/i,
  /\bplays?\s+the\s+music\s+of\b/i,
  /\bsings?\s+the\s+songs\s+of\b/i,
  /\ba\s+celebration\s+of\b/i,
  /\bin\s+memory\s+of\b/i,
  /\bthe\s+music\s+of\b/i,
  /\bsymphonic\s+tribute\b/i,
  /\bby\s+candlelight\b/i,
  /\bcandlelight\b/i,
  /\bbootleg\b/i,
  /\b(?:uk|danish|dansk|nordic|scandinavian)\s+.*\b(?:tribute|experience|show)\b/i,
  /\bre-?live\b/i,
  /\bthe\s+ultimate\b.*\bshow\b/i,
  /\bjukebox\b/i,
  /\bstars\s+of\b/i,
  /\bcopycats?\b/i,
]

export function looksLikeTribute(name) {
  const s = String(name || '')
  return TRIBUTE_PATTERNS.some((rx) => rx.test(s))
}

/**
 * "X Alive", "X Mania", "Bjorn Again"-style acts: a real artist name plus a
 * suffix that means "not them". Checked separately because the suffix only
 * signals a tribute when it trails a name, not when it is the whole name.
 */
const TRIBUTE_SUFFIX =
  /\b(alive|mania|maniacs|forever|reloaded|revival|reborn|again|story|legacy|nights?|night)\s*$/i

export function looksLikeTributeSuffix(name, knownArtistKeys) {
  const s = String(name || '').trim()
  if (!TRIBUTE_SUFFIX.test(s)) return false
  const stem = s.replace(TRIBUTE_SUFFIX, '').trim()
  if (stem.length < 3) return false
  // Only a tribute if the stem is itself an artist we know about.
  return knownArtistKeys ? keysFor(stem).some((k) => knownArtistKeys.has(k)) : false
}

/** Levenshtein, capped: we only care whether two names are within a hair. */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < best) best = cur[j]
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/**
 * Near-match, used only as a last resort and only for names long enough that a
 * one-character difference is almost certainly a typo rather than a different
 * band. "Mew" and "Men" are three letters apart in meaning and one in spelling,
 * so short names get exact matching only.
 */
export function nearlyEqual(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.length < 7 || b.length < 7) return false
  return editDistance(a, b, 1) <= 1
}
