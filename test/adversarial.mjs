#!/usr/bin/env node
// Try to break it.
//
// The other tests check that the thing works. This one assumes it does and goes
// looking for the ways a real visitor, or a hostile one, makes it stop. It runs
// against the built page in a real browser, because most of these failures only
// exist once there is a DOM.

import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const BUNDLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const PAGE = 'file://' + resolve('docs/index.html')

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`)
}

async function main() {
  const browser = await chromium.launch(existsSync(BUNDLED) ? { executablePath: BUNDLED } : {})
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()

  const errors = []
  const network = []
  const dialogs = []
  page.on('pageerror', (e) => errors.push(String(e.message)))
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()))
  page.on('request', (r) => {
    if (!r.url().startsWith('file://') && !r.url().startsWith('data:')) network.push(r.url())
  })
  page.on('dialog', async (d) => {
    dialogs.push(d.message())
    await d.dismiss()
  })

  await page.goto(PAGE, { waitUntil: 'load' })

  // ---------------------------------------------------------------- injection
  console.log('\n── script injection through the fields a visitor controls ──')
  const XSS = `<img src=x onerror="window.__pwned=1">`
  const XSS2 = `"><script>window.__pwned=2</script>`
  await page.click('#way-type')
  await page.fill('#type-in', [XSS, XSS2, 'Iceage', `<b>Lowly</b>`].join('\n'))
  await page.click('#type-go')
  await page.waitForTimeout(900)
  check('a script tag in a typed artist name does not execute', !(await page.evaluate(() => window.__pwned)))
  check('no alert or prompt was raised', dialogs.length === 0, dialogs.join('; '))
  const rendered = await page.evaluate(() => document.querySelector('#results')?.innerHTML || '')
  check('injected markup is escaped in the DOM', !rendered.includes('<img src=x'), '')

  // A hostile event in the corpus is the other direction: if a venue ever put
  // markup in a title, the page must not run it.
  await page.evaluate((x) => {
    window.__TOLV__.events.push({
      id: 'evil', title: x, artists: [x], startDate: '2027-01-15', status: 'scheduled',
      venue: { id: 'v', name: x, city: x, country: 'DK' }, url: 'javascript:window.__pwned=3',
      src: { host: x, at: '2026-08-12' },
    })
  }, XSS)
  await page.click('#way-type').catch(() => {})
  await page.evaluate(() => document.querySelector('#restart')?.click())
  await page.click('#way-type')
  await page.fill('#type-in', XSS)
  await page.click('#type-go')
  await page.waitForTimeout(700)
  check('a hostile event title does not execute', !(await page.evaluate(() => window.__pwned)))

  // ------------------------------------------------------------------- volume
  console.log('\n── volume ──')
  await page.evaluate(() => document.querySelector('#restart')?.click())
  await page.click('#way-type')
  const many = Array.from({ length: 8000 }, (_, i) => `Band Number ${i}`).join('\n')
  const t0 = Date.now()
  // page.fill() types character by character and times out on 8,000 lines.
  // Setting the value directly is what a paste actually does anyway.
  await page.evaluate((v) => {
    const el = document.querySelector('#type-in')
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, many)
  await page.click('#type-go')
  await page.waitForSelector('#results:not([hidden])', { timeout: 30000 })
  await page.waitForTimeout(400)
  const ms = Date.now() - t0
  check('8,000 typed artists still returns a list', true, `${ms}ms`)
  check('8,000 artists does not blow the cap', (await page.$$eval('.pick', (e) => e.length)) <= 12)
  check('8,000 artists stays under 20 seconds', ms < 20000, `${ms}ms`)

  // ------------------------------------------------------------------ oddities
  console.log('\n── names that are not names ──')
  const ODD = ['', '   ', '🎸🎸🎸', '𝕴𝖈𝖊𝖆𝖌𝖊', 'a'.repeat(500), '...', '///', 'NULL', 'undefined', '0', '"; DROP TABLE events; --']
  await page.evaluate(() => document.querySelector('#restart')?.click())
  await page.click('#way-type')
  await page.fill('#type-in', ODD.join('\n'))
  await page.click('#type-go')
  await page.waitForTimeout(700)
  check('junk artist names do not crash the page', errors.length === 0, errors.slice(0, 2).join('; '))

  // ------------------------------------------------------------------ controls
  console.log('\n── the controls, hammered ──')
  await page.evaluate(() => document.querySelector('#restart')?.click())
  await page.click('#way-type')
  await page.fill('#type-in', ['Iceage', 'Lowly', 'BAEST', 'Carpark North', 'Efterklang', 'MØ'].join('\n'))
  await page.click('#type-go')
  await page.waitForSelector('#results:not([hidden])')

  let capOk = true
  for (const n of [5, 8, 12, 16, 20, 5]) {
    await page.evaluate((v) => {
      const el = document.querySelector('#count')
      el.value = String(v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, n)
    await page.waitForTimeout(220)
    const picks = await page.$$eval('.pick', (e) => e.length)
    if (picks > n) capOk = false
  }
  check('every slider position respects its cap', capOk)

  // Every region option must render without throwing, including ones with no
  // data behind them — that is the honest empty state, not a crash.
  const regions = await page.$$eval('#region option', (els) => els.map((e) => e.value))
  let regionOk = true
  for (const r of regions) {
    await page.selectOption('#region', r)
    await page.waitForTimeout(160)
    const hasResultsBlock = await page.evaluate(() => !!document.querySelector('#spine'))
    if (!hasResultsBlock) regionOk = false
  }
  check(`all ${regions.length} region filters render`, regionOk && errors.length === 0)

  await page.selectOption('#region', regions[0])
  await page.selectOption('#room', 'intimate')
  await page.waitForTimeout(200)
  check('room preference does not break the list', errors.length === 0)

  // Language and theme, mid-results.
  await page.click('#lang')
  await page.waitForTimeout(250)
  const daText = await page.$eval('.summary .said', (e) => e.textContent)
  check('switching to Danish re-renders the results', /koncerter|aftener/i.test(daText), daText.slice(0, 50))
  await page.click('#theme')
  await page.waitForTimeout(200)
  await page.click('#lang')
  await page.waitForTimeout(200)

  // --------------------------------------------------------------- bad uploads
  console.log('\n── files a person will actually drop in ──')
  const badFiles = [
    { name: 'not-a-zip.zip', mime: 'application/zip', body: 'this is plainly not a zip' },
    { name: 'empty.json', mime: 'application/json', body: '' },
    { name: 'array-of-nothing.json', mime: 'application/json', body: '[]' },
    { name: 'truncated.json', mime: 'application/json', body: '[{"ts":"2026-01-01","ms_played":' },
    { name: 'proto.json', mime: 'application/json', body: '[{"__proto__":{"polluted":1},"artistName":"X","msPlayed":99999}]' },
    { name: 'huge-numbers.json', mime: 'application/json', body: '[{"artistName":"Y","msPlayed":1e308,"endTime":"9999-99-99"}]' },
    { name: 'wrong.csv', mime: 'text/csv', body: 'a,b,c\n1,2,3\n' },
  ]
  for (const f of badFiles) {
    errors.length = 0
    await page.evaluate(() => document.querySelector('#restart')?.click())
    await page.click('#way-file')
    await page.waitForSelector('#file-input', { state: 'attached' })
    await page.setInputFiles('#file-input', {
      name: f.name,
      mimeType: f.mime,
      buffer: Buffer.from(f.body),
    })
    await page.waitForTimeout(600)
    const status = await page.evaluate(() => document.querySelector('#file-status')?.textContent?.trim() || '')
    const crashed = errors.filter((e) => !/Failed to load resource/i.test(e))
    check(`${f.name}: handled with a message, not a crash`, crashed.length === 0 && status.length > 0, status.slice(0, 60))
  }
  check('prototype pollution did not take', !(await page.evaluate(() => ({}).polluted)))

  // ------------------------------------------------------------------- privacy
  console.log('\n── the promise on the front page ──')
  check('nothing left the page, at any point', network.length === 0, network.slice(0, 3).join(' '))

  await browser.close()

  await writeFile(
    'docs/screenshots/adversarial.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)
  )

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} adversarial checks passed`)
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED: ${f.name} ${f.detail}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
