#!/usr/bin/env node
// Build one file.
//
// docs/index.html ends up self-contained: the corpus, the engine, the styles
// and the typeface all inline. Two reasons, and the second is the real one.
//
//   It works from file:// with no server. Someone can double-click it.
//   It has nothing to fetch, so the privacy promise on the front page is
//   structural rather than a claim. A page that loads no third-party anything
//   cannot leak the file you just dropped into it.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'

// Order matters: dependencies first. These are the same modules the tests run
// against, so what ships is what was tested.
const MODULES = ['src/text.mjs', 'src/unzip.mjs', 'src/taste.mjs', 'src/recommend.mjs']

/** Flatten an ES module for inlining: drop its imports, unwrap its exports. */
function flatten(source, file) {
  const lines = source.split('\n')
  const out = []
  for (const line of lines) {
    if (/^\s*import\s.*\sfrom\s+['"][^'"]+['"];?\s*$/.test(line)) continue
    if (/^\s*import\s+['"][^'"]+['"];?\s*$/.test(line)) continue
    if (/^\s*export\s+\{[^}]*\}\s*;?\s*$/.test(line)) continue
    out.push(line.replace(/^(\s*)export\s+(?=(const|let|var|function|class|async)\b)/, '$1'))
  }
  const flat = out.join('\n')
  if (/^\s*(import|export)\s/m.test(flat)) {
    throw new Error(`${file}: an import or export survived flattening; the bundler needs to handle it`)
  }
  return flat
}

async function main() {
  const events = JSON.parse(await readFile('data/events.json', 'utf8'))
  const harvestMeta = JSON.parse(await readFile('data/harvest-meta.json', 'utf8'))
  const registry = JSON.parse(await readFile('pipeline/sources.json', 'utf8'))
  const artists = existsSync('data/artists.json')
    ? JSON.parse(await readFile('data/artists.json', 'utf8'))
    : {}

  const meta = {
    generatedAt: harvestMeta.generatedAt,
    window: harvestMeta.window,
    counts: harvestMeta.counts,
    perSource: harvestMeta.perSource.map((s) => ({ id: s.id, name: s.name, city: s.city, kept: s.kept })),
    notYetCovered: registry.notYetCovered || [],
    excluded: registry.excluded || [],
    artistIndexSize: Object.keys(artists).length,
  }

  // The page never needs every field the harvest keeps. Shipping only what is
  // rendered keeps the file small enough to open instantly on a phone.
  const slim = events.map((e) => ({
    id: e.id,
    title: e.title,
    artists: e.artists,
    startDate: e.startDate,
    startTime: e.startTime || null,
    status: e.status,
    venue: {
      id: e.venue.id,
      name: e.venue.name,
      city: e.venue.city,
      country: e.venue.country,
      sizeClass: e.venue.sizeClass || null,
    },
    url: e.url || null,
    ticketUrl: e.ticketUrl || null,
    price: e.price || null,
    tags: e.tags?.length ? e.tags : undefined,
    isTribute: e.isTribute || undefined,
    isFestival: e.isFestival || undefined,
  }))

  const css = await readFile('site/style.css', 'utf8')
  const app = await readFile('site/app.js', 'utf8')
  let html = await readFile('site/index.html', 'utf8')

  const fontPath = 'docs/fonts/SpaceGrotesk-var.woff2'
  let fontCss = ''
  if (existsSync(fontPath)) {
    const b64 = (await readFile(fontPath)).toString('base64')
    fontCss = `@font-face{font-family:'Space Grotesk';src:url(data:font/woff2;base64,${b64}) format('woff2-variations');font-weight:300 700;font-style:normal;font-display:swap}\n`
  }

  const engine = []
  for (const m of MODULES) engine.push(`/* === ${m} === */\n` + flatten(await readFile(m, 'utf8'), m))

  // Replacement values are passed as FUNCTIONS, never as strings. A replacement
  // STRING treats $$, $&, $` and $' as substitution patterns, and app.js
  // defines a helper called $$ — which silently became $ and collided with the
  // other helper, so the whole page died on "Identifier '$' has already been
  // declared". A function replacer is inserted verbatim.
  const put = (marker, value) => {
    if (!html.includes(marker)) throw new Error(`template is missing ${marker}`)
    html = html.replace(marker, () => value)
  }

  put('<!--STYLE-->', `<style>\n${fontCss}${css}\n</style>`)
  put(
    '<!--DATA-->',
    `<script id="tolv-data" type="application/json">${JSON.stringify({ events: slim, artists, meta }).replace(
      /</g,
      '\\u003c'
    )}</script>`
  )
  put(
    '<!--SCRIPT-->',
    `<script>\nwindow.__TOLV__ = JSON.parse(document.getElementById('tolv-data').textContent);\n${engine.join(
      '\n'
    )}\n/* === site/app.js === */\n${app}\n</script>`
  )

  await mkdir('docs', { recursive: true })
  await writeFile('docs/index.html', html)
  await writeFile('docs/.nojekyll', '')

  const size = (await stat('docs/index.html')).size
  console.log(
    `docs/index.html  ${(size / 1024).toFixed(0)} KB  ` +
      `${slim.length} events, ${meta.counts.venues} venues, ${meta.artistIndexSize} artists indexed`
  )
  if (size > 6_000_000) {
    console.error('FAIL: page is over 6 MB. Trim what is inlined before shipping this.')
    process.exit(2)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
