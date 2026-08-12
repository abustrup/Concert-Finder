// schema.org Event extraction.
//
// This is the highest-value harvest surface we found: a venue that publishes
// JSON-LD has already done the structured-data work, and reading it beats
// parsing their HTML on every axis — it survives redesigns, it carries the
// ticket link and the price, and it is published precisely so that machines
// will read it.
//
// Reality still intrudes: plenty of sites emit JSON-LD that is not valid JSON.
// We attempt one conservative repair, and record when we did.

const SCRIPT_RX =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

/** Strip the two things that most often make real-world JSON-LD unparseable. */
function repair(raw) {
  return raw
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // raw control chars
    .replace(/,\s*([}\]])/g, '$1') // trailing commas
}

export function extractJsonLdBlocks(html) {
  const out = []
  let m
  SCRIPT_RX.lastIndex = 0
  while ((m = SCRIPT_RX.exec(html))) {
    const raw = m[1].trim()
    if (!raw) continue
    try {
      out.push({ data: JSON.parse(raw), repaired: false })
    } catch {
      try {
        out.push({ data: JSON.parse(repair(raw)), repaired: true })
      } catch {
        out.push({ data: null, repaired: true, failed: true })
      }
    }
  }
  return out
}

const isEventType = (t) => {
  const types = Array.isArray(t) ? t : t ? [t] : []
  return types.some((x) => /(^|\/)([A-Za-z]*Event)$/.test(String(x)))
}

/** Walk any JSON-LD payload and yield every node that is an Event. */
export function findEventNodes(data, acc = []) {
  if (Array.isArray(data)) {
    for (const d of data) findEventNodes(d, acc)
    return acc
  }
  if (!data || typeof data !== 'object') return acc
  if (data['@graph']) findEventNodes(data['@graph'], acc)
  if (isEventType(data['@type'])) acc.push(data)
  for (const [k, v] of Object.entries(data)) {
    if (k === '@graph') continue
    if (v && typeof v === 'object') findEventNodes(v, acc)
  }
  return acc
}

export function eventsFromHtml(html) {
  const blocks = extractJsonLdBlocks(html)
  const nodes = []
  let repaired = 0
  let failed = 0
  for (const b of blocks) {
    if (b.failed) {
      failed++
      continue
    }
    if (b.repaired) repaired++
    findEventNodes(b.data, nodes)
  }
  // A page can list the same event in more than one block. Dedupe on the
  // fields that identify it rather than on object identity.
  const seen = new Set()
  const unique = []
  for (const n of nodes) {
    const key = `${str(n.name)}|${str(n.startDate)}|${str(n.url)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(n)
  }
  return { nodes: unique, blocks: blocks.length, repaired, failed }
}

const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? str(v.name ?? v['@value'] ?? '') : String(v))

export const asText = str

export function firstOf(v) {
  return Array.isArray(v) ? v[0] : v
}

export function asArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}
