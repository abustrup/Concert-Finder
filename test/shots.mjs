#!/usr/bin/env node
// Drive the real page in a real browser and photograph it.
//
// This is the check that catches what unit tests never do: whether the thing
// a person opens actually works and actually looks like something. It clicks
// through the real import flow with a real taste, and it fails on a console
// error rather than quietly producing a screenshot of a broken page.

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

// This machine ships Chromium at a fixed path and forbids downloading another.
// Point at it when it is there, and fall back to whatever Playwright manages
// so the same script still runs on a normal laptop.
const BUNDLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const launchOpts = existsSync(BUNDLED) ? { executablePath: BUNDLED } : {}

const OUT = 'docs/screenshots'
const PAGE = 'file://' + resolve('docs/index.html')

const TASTE = [
  'Iceage', 'The Minds of 99', 'MØ', 'Efterklang', 'Trentemøller',
  'Erika de Casier', 'Nick Cave and the Bad Seeds', 'Sleaford Mods',
  'Kwamie Liv', 'Lowly', 'Fine Glindvad', 'Baby in Vain',
  'Girl in Red', 'Gilli', 'Big Thief', 'Amyl and the Sniffers',
]

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch(launchOpts)
  const problems = []
  const shots = []

  async function shoot(page, name, opts = {}) {
    const file = `${OUT}/${name}.png`
    await page.screenshot({ path: file, fullPage: opts.full ?? false })
    shots.push(file)
    console.log(`  shot  ${file}`)
  }

  for (const [device, size] of [
    ['desktop', { width: 1440, height: 960 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 2,
        colorScheme: theme,
      })
      const page = await ctx.newPage()

      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`[${device}/${theme}] console: ${m.text()}`)
      })
      page.on('pageerror', (e) => problems.push(`[${device}/${theme}] pageerror: ${e.message}`))
      // Nothing on this page should ever reach the network. If anything does,
      // the privacy claim on the front is false and this must fail.
      page.on('request', (r) => {
        if (!r.url().startsWith('file://') && !r.url().startsWith('data:')) {
          problems.push(`[${device}/${theme}] NETWORK REQUEST: ${r.method()} ${r.url()}`)
        }
      })

      await page.goto(PAGE, { waitUntil: 'load' })
      await page.evaluate((t) => localStorage.setItem('tolv-theme', t), theme)
      await page.reload({ waitUntil: 'load' })
      await page.waitForTimeout(350)

      await shoot(page, `${device}-${theme}-1-landing`)

      // Walk the real import path rather than injecting state.
      await page.click('#way-type')
      await page.waitForSelector('#type-in')
      await page.fill('#type-in', TASTE.join('\n'))
      await page.click('#type-go')
      await page.waitForSelector('#results:not([hidden])', { timeout: 15000 })
      await page.waitForTimeout(500)

      const count = await page.$eval('#result-count', (el) => el.textContent.trim())
      const picks = await page.$$eval('.pick', (els) => els.length)
      const withWhy = await page.$$eval('.why', (els) => els.filter((e) => e.textContent.trim()).length)
      console.log(`  ${device}/${theme}: headline=${count} picks=${picks} explained=${withWhy}`)
      if (String(picks) !== count) problems.push(`[${device}/${theme}] headline says ${count} but ${picks} cards rendered`)
      if (picks && withWhy !== picks) problems.push(`[${device}/${theme}] ${picks - withWhy} picks have no reason shown`)

      await shoot(page, `${device}-${theme}-2-results`)
      if (device === 'desktop') {
        await page.click('#toggle-method')
        await page.waitForTimeout(250)
        await shoot(page, `${device}-${theme}-3-method`)
        await shoot(page, `${device}-${theme}-4-full`, { full: true })
      } else {
        await shoot(page, `${device}-${theme}-4-full`, { full: true })
      }

      await ctx.close()
    }
  }

  await browser.close()

  await writeFile(
    `${OUT}/report.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), shots, problems }, null, 2)
  )

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`)
    for (const p of problems) console.error('  ' + p)
    process.exit(1)
  }
  console.log(`\n${shots.length} screenshots, no console errors, no network requests.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
