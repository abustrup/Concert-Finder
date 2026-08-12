#!/usr/bin/env node
// Look at one page properly.
//
// The first harvest found zero events on eight venue sites whose sitemaps list
// hundreds of event pages, all rejected as "no-jsonld-event". That is a claim
// about our extractor, not about the sites: JSON-LD is one of at least four
// places a modern site keeps its structured event data. This dumps all of them
// so the next extractor is written against what is actually served.

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { politeFetch } from './lib/http.mjs'
import { eventsFromHtml } from './lib/jsonld.mjs'

const OUT = 'recon/inspect'

function surfaces(html) {
  const found = {}

  const { nodes, blocks, repaired, failed } = eventsFromHtml(html)
  found.jsonLd = { blocks, eventNodes: nodes.length, repaired, failed, sample: nodes[0] || null }

  // Next.js hydration payload — usually the richest source when present.
  const next = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (next) {
    try {
      const d = JSON.parse(next[1])
      found.nextData = {
        present: true,
        topKeys: Object.keys(d),
        pagePropsKeys: d?.props?.pageProps ? Object.keys(d.props.pageProps) : null,
        bytes: next[1].length,
      }
    } catch (e) {
      found.nextData = { present: true, parseError: String(e.message) }
    }
  }

  const nuxt = html.match(/window\.__NUXT__\s*=\s*/i)
  if (nuxt) found.nuxt = { present: true }

  // Any other big inline JSON that mentions a date-looking string.
  const apollo = html.match(/__APOLLO_STATE__|__INITIAL_STATE__|window\.__data/i)
  if (apollo) found.otherState = apollo[0]

  const meta = {}
  const metaRx = /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi
  let m
  while ((m = metaRx.exec(html))) {
    if (/^(og:|twitter:|event|description|title)/i.test(m[1])) meta[m[1]] = m[2].slice(0, 200)
  }
  found.meta = meta

  // Microdata
  const itemprops = [...html.matchAll(/itemprop=["']([^"']+)["']/gi)].map((x) => x[1])
  if (itemprops.length) found.microdata = [...new Set(itemprops)].slice(0, 20)

  // Any ISO date on the page at all — if there is none, the date is rendered
  // client-side and no static extractor will ever find it.
  const isoDates = [...new Set([...html.matchAll(/\b(20\d{2}-\d{2}-\d{2})/g)].map((x) => x[1]))].slice(0, 10)
  found.isoDatesOnPage = isoDates

  return found
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const listFile = process.argv[2] || '.github/inspect-urls'
  const raw = await readFile(listFile, 'utf8')
  const urls = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  const report = { generatedAt: new Date().toISOString(), pages: [] }

  for (const url of urls) {
    const res = await politeFetch(url)
    if (!res) {
      report.pages.push({ url, skipped: 'robots' })
      console.log(`ROBOTS  ${url}`)
      continue
    }
    const entry = { url, status: res.status, finalUrl: res.url, bytes: res.text.length }
    if (res.ok && res.text) {
      const looksJson = res.text.trim().startsWith('{') || res.text.trim().startsWith('[')
      if (looksJson) {
        try {
          const d = JSON.parse(res.text)
          const first = Array.isArray(d) ? d[0] : d
          entry.json = {
            isArray: Array.isArray(d),
            length: Array.isArray(d) ? d.length : null,
            keys: first && typeof first === 'object' ? Object.keys(first) : null,
          }
          // Keep one whole record: field names alone do not show where a date hides.
          await writeFile(
            `${OUT}/${slug(url)}.sample.json`,
            JSON.stringify(Array.isArray(d) ? d.slice(0, 2) : d, null, 1).slice(0, 200_000)
          )
        } catch {
          entry.json = { parseError: true }
        }
      } else {
        entry.surfaces = surfaces(res.text)
        await writeFile(`${OUT}/${slug(url)}.html`, res.text.slice(0, 250_000))
      }
    }
    report.pages.push(entry)
    console.log(
      `${res.status}  ${url}\n      ${
        entry.json
          ? `JSON ${entry.json.isArray ? `[${entry.json.length}]` : 'obj'} keys=${(entry.json.keys || []).slice(0, 14).join(',')}`
          : `jsonld=${entry.surfaces?.jsonLd.eventNodes} next=${!!entry.surfaces?.nextData} dates=${(entry.surfaces?.isoDatesOnPage || []).slice(0, 3).join(' ')}`
      }`
    )
  }

  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${OUT}/report.json`)
}

const slug = (u) =>
  u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 90)

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
