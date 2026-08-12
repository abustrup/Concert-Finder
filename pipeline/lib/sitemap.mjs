// Sitemap walking.
//
// A sitemap is the one part of a website that exists specifically so machines
// can find its pages. Where a venue publishes one, using it is both the most
// reliable way to enumerate their event pages and the most polite: we ask for
// the index they wrote for us rather than guessing at their URL scheme.

import { politeFetch } from './http.mjs'

const LOC_RX = /<loc>\s*([^<]+?)\s*<\/loc>/gi
const LASTMOD_RX = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi

function parseLocs(xml) {
  const locs = []
  let m
  LOC_RX.lastIndex = 0
  while ((m = LOC_RX.exec(xml))) locs.push(decodeEntities(m[1]))
  return locs
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
}

const isIndex = (xml) => /<sitemapindex/i.test(xml)

/**
 * Collect page URLs from a sitemap, following index files one level deep.
 * `match` filters which URLs are worth having; `maxChildren` bounds how many
 * child sitemaps we will open, so a site with 900 of them cannot run away
 * with the whole job.
 */
export async function collectSitemapUrls(sitemapUrl, { match, maxChildren = 25, maxUrls = 2000 } = {}) {
  const seen = new Set()
  const out = []
  const visitedSitemaps = new Set()

  async function visit(url, depth) {
    if (out.length >= maxUrls) return
    if (visitedSitemaps.has(url) || visitedSitemaps.size > maxChildren + 4) return
    visitedSitemaps.add(url)

    const res = await politeFetch(url, { accept: 'application/xml,text/xml,*/*' })
    if (!res || !res.ok || !res.text) return
    const xml = res.text

    if (isIndex(xml) && depth < 2) {
      const children = parseLocs(xml)
      // Prefer children whose own filename hints at events, then take the rest.
      const ranked = [
        ...children.filter((c) => /(event|koncert|show|program|arrangement|kalender)/i.test(c)),
        ...children.filter((c) => !/(event|koncert|show|program|arrangement|kalender)/i.test(c)),
      ]
      for (const child of ranked.slice(0, maxChildren)) {
        await visit(child, depth + 1)
        if (out.length >= maxUrls) return
      }
      return
    }

    for (const loc of parseLocs(xml)) {
      if (seen.has(loc)) continue
      seen.add(loc)
      if (match && !match(loc)) continue
      out.push(loc)
      if (out.length >= maxUrls) return
    }
  }

  await visit(sitemapUrl, 0)
  return out
}

export function urlMatcher(patterns) {
  const list = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean)
  if (!list.length) return () => true
  return (u) => list.some((p) => u.includes(p))
}
