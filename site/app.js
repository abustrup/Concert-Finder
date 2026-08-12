// TOLV — the page.
//
// Everything below runs in the visitor's browser and talks to nothing. The one
// exception is the ListenBrainz lookup, which is a public read of a public
// profile the visitor typed in themselves, and it is announced before it runs.

const EVENTS = window.__TOLV__.events
const ARTIST_INDEX = new Map(Object.entries(window.__TOLV__.artists || {}))
const META = window.__TOLV__.meta

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]

// ---------------------------------------------------------------------- i18n

const STR = {
  en: {
    tagline: 'twelve nights a year',
    light: 'Light',
    dark: 'Dark',
    startOver: 'Start over',
    kicker: 'Denmark first · Europe and world on request',
    h1a: 'Twelve nights.',
    h1b: 'Not three hundred.',
    lede: 'Most people go to somewhere between five and ten concerts a year. So this does not hand you a listings page. Give it what you listen to and it returns a shortlist for the next twelve months, each one saying why it is there.',
    w1h: 'Drop in your Spotify data',
    w1p: 'The zip Spotify emails you when you ask for your data. Also reads Apple Music, Last.fm and ListenBrainz exports, and old Spotify exports going back years.',
    w1t: 'Best results · nothing is uploaded',
    w2h: 'Type a ListenBrainz name',
    w2p: 'ListenBrainz publishes listening stats openly, so a username is enough. No login, no password, no permissions to grant.',
    w2t: 'Ten seconds · needs a ListenBrainz account',
    w3h: 'Just name some bands',
    w3p: 'Twenty artists you like, typed in. Rougher than an export, and enough to be useful straight away.',
    w3t: 'No account of any kind',
    privH: 'Your listening history is read on your own device.',
    privP: 'This is a static page. There is no server to send anything to, no account, no analytics and no third-party script. The file you drop in is opened by code running in your browser and is gone when you close the tab.',
    cCount: 'Nights',
    cWhere: 'Where',
    cRoom: 'Rooms',
    rAny: 'Any size',
    rSmall: 'Prefer small',
    cMethod: 'How this was chosen',
    fData: 'The listings',
    fCover: 'Coverage',
    fHow: 'How it works',
    fHowP: "Every concert here was read from a venue's own website or programme feed, with the source and the date it was fetched recorded against it. Nothing is written by hand and nothing is generated.",
    fOpen: 'Open',
    fOpenP: 'Not affiliated with Spotify, Songkick, or any venue. No ads, no affiliate links.',
    dropHere: 'Drop the file here, or',
    choose: 'Choose a file',
    dropHint: 'A .zip from Spotify, or any .json / .csv from a music service. Nothing leaves this page.',
    lbHint: 'Reads the public listening stats for that ListenBrainz account. This is the one request this page makes, and only when you press the button.',
    lbGo: 'Get my nights',
    typeHint: 'One artist per line. The order matters a little: put the ones you listen to most at the top.',
    typeGo: 'Get my nights',
    reading: 'Reading',
    noArtists: 'No artist names could be read from that. Try a different file, or type some names instead.',
    lbFail: 'That ListenBrainz name did not return anything. Check the spelling, or that the account has listens.',
    picksFor: 'nights',
    saidOne: (n, m, a) => `${n} concerts from ${m} we think you would actually go to, out of ${a} on the calendar.`,
    whyShort: (n, code) =>
      code === 'variety-limit'
        ? `${n} rather than more, because the rest were the same artists and the same rooms again. Repeats would make the list longer, not better.`
        : `${n} rather than more. Nothing else on the calendar matches what you listen to closely enough to be worth an evening, and padding with weak guesses is how a shortlist stops being one.`,
    nothing: 'Nothing here matches yet',
    nothingP: 'None of the concerts we have on file match what you listen to closely enough to be worth your evening. That is a real answer, not an error.',
    methodH: 'How these were chosen',
    discovery: 'Discovery',
    festival: 'Festival',
    yourArtist: 'You listen to them',
    free: 'Free',
    tickets: 'Tickets',
    venuePage: 'Venue page',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    monthsLong: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    regionDK: 'Denmark',
    regionAll: 'Everywhere we cover',
  },
  da: {
    tagline: 'tolv aftener om året',
    light: 'Lys',
    dark: 'Mørk',
    startOver: 'Forfra',
    kicker: 'Danmark først · Europa og verden på forespørgsel',
    h1a: 'Tolv aftener.',
    h1b: 'Ikke tre hundrede.',
    lede: 'De fleste er til mellem fem og ti koncerter om året. Derfor får du ikke en programoversigt her. Fortæl hvad du lytter til, og du får en kort liste for de næste tolv måneder, hvor hver enkelt siger hvorfor den er der.',
    w1h: 'Læg dine Spotify-data ind',
    w1p: 'Den zip-fil Spotify sender, når du beder om dine data. Læser også eksport fra Apple Music, Last.fm og ListenBrainz, og gamle Spotify-eksporter mange år tilbage.',
    w1t: 'Bedste resultat · intet bliver uploadet',
    w2h: 'Skriv et ListenBrainz-navn',
    w2p: 'ListenBrainz offentliggør lyttestatistik åbent, så et brugernavn er nok. Ingen login, ingen adgangskode, ingen tilladelser.',
    w2t: 'Ti sekunder · kræver en ListenBrainz-konto',
    w3h: 'Nævn bare nogle bands',
    w3p: 'Tyve kunstnere du kan lide, skrevet ind. Grovere end en eksport, og nok til at være brugbart med det samme.',
    w3t: 'Ingen konto overhovedet',
    privH: 'Din lyttehistorik læses på din egen enhed.',
    privP: 'Det her er en statisk side. Der er ingen server at sende noget til, ingen konto, ingen analytics og ingen tredjepartsscripts. Filen du lægger ind, åbnes af kode i din browser og er væk, når du lukker fanen.',
    cCount: 'Aftener',
    cWhere: 'Hvor',
    cRoom: 'Rum',
    rAny: 'Alle størrelser',
    rSmall: 'Helst små',
    cMethod: 'Hvordan er de valgt',
    fData: 'Koncerterne',
    fCover: 'Dækning',
    fHow: 'Sådan virker det',
    fHowP: 'Hver koncert her er læst fra spillestedets eget site eller programfeed, med kilden og hentedatoen gemt sammen med den. Intet er skrevet i hånden, og intet er genereret.',
    fOpen: 'Åbent',
    fOpenP: 'Ikke tilknyttet Spotify, Songkick eller noget spillested. Ingen reklamer, ingen affiliate-links.',
    dropHere: 'Læg filen her, eller',
    choose: 'Vælg en fil',
    dropHint: 'En .zip fra Spotify, eller enhver .json / .csv fra en musiktjeneste. Intet forlader siden.',
    lbHint: 'Henter den offentlige lyttestatistik for den ListenBrainz-konto. Det er den eneste forespørgsel siden laver, og kun når du trykker.',
    lbGo: 'Find mine aftener',
    typeHint: 'En kunstner per linje. Rækkefølgen betyder lidt: sæt dem du hører mest øverst.',
    typeGo: 'Find mine aftener',
    reading: 'Læser',
    noArtists: 'Der kunne ikke læses nogen kunstnernavne. Prøv en anden fil, eller skriv nogle navne i stedet.',
    lbFail: 'Det ListenBrainz-navn gav ingenting. Tjek stavemåden, eller om kontoen har lyt.',
    picksFor: 'aftener',
    saidOne: (n, m, a) => `${n} koncerter fra ${m}, vi tror du faktisk ville tage til, ud af ${a} i kalenderen.`,
    whyShort: (n, code) =>
      code === 'variety-limit'
        ? `${n} og ikke flere, fordi resten var de samme kunstnere i de samme rum igen. Gentagelser ville gøre listen længere, ikke bedre.`
        : `${n} og ikke flere. Der er ikke andet i kalenderen, der ligner det du lytter til nok til at være en aften værd, og at fylde op med svage gæt er præcis dét, der ødelægger en kort liste.`,
    nothing: 'Ingenting passer endnu',
    nothingP: 'Ingen af de koncerter vi har, ligner det du lytter til nok til at være din aften værd. Det er et rigtigt svar, ikke en fejl.',
    methodH: 'Sådan blev de valgt',
    discovery: 'Nyt for dig',
    festival: 'Festival',
    yourArtist: 'Du lytter til dem',
    free: 'Gratis',
    tickets: 'Billetter',
    venuePage: 'Spillestedets side',
    months: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
    monthsLong: ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'],
    days: ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'],
    regionDK: 'Danmark',
    regionAll: 'Alt vi dækker',
  },
}

let lang = (navigator.language || 'en').toLowerCase().startsWith('da') ? 'da' : 'en'
const t = (k) => STR[lang][k]

function applyLang() {
  document.documentElement.lang = lang
  for (const el of $$('[data-i18n]')) {
    const v = STR[lang][el.dataset.i18n]
    if (typeof v === 'string') el.textContent = v
  }
  $('#lang').textContent = lang === 'da' ? 'EN' : 'DA'
  $('#lang').setAttribute('aria-label', lang === 'da' ? 'Switch to English' : 'Skift til dansk')
  $('#theme').querySelector('span').textContent =
    document.documentElement.dataset.theme === 'light' ? t('dark') : t('light')
  renderFooter()
  buildRegionOptions()
  if (state.result) render()
}

// --------------------------------------------------------------------- state

const state = {
  taste: null,
  importStats: null,
  result: null,
  options: { count: 12, roomPreference: 'any', countries: ['DK'] },
}

// ------------------------------------------------------------------- helpers

const fmtDate = (iso) => {
  const d = new Date(iso + 'T12:00:00Z')
  return { day: d.getUTCDate(), month: d.getUTCMonth(), year: d.getUTCFullYear(), dow: d.getUTCDay() }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const monthKey = (iso) => iso.slice(0, 7)

function relativeAge(iso) {
  if (!iso) return null
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000)
  if (days <= 0) return lang === 'da' ? 'i dag' : 'today'
  if (days === 1) return lang === 'da' ? 'i går' : 'yesterday'
  if (days < 14) return lang === 'da' ? `for ${days} dage siden` : `${days} days ago`
  const w = Math.floor(days / 7)
  return lang === 'da' ? `for ${w} uger siden` : `${w} weeks ago`
}

// ------------------------------------------------------------------ chrome

function initChrome() {
  const saved = localStorage.getItem('tolv-theme')
  if (saved) document.documentElement.dataset.theme = saved
  $('#theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    localStorage.setItem('tolv-theme', next)
    $('#theme').querySelector('span').textContent = next === 'light' ? t('dark') : t('light')
  })
  $('#lang').addEventListener('click', () => {
    lang = lang === 'da' ? 'en' : 'da'
    localStorage.setItem('tolv-lang', lang)
    applyLang()
  })
  const savedLang = localStorage.getItem('tolv-lang')
  if (savedLang) lang = savedLang

  $('#restart').addEventListener('click', () => {
    state.taste = null
    state.result = null
    $('#results').hidden = true
    $('#landing').hidden = false
    $('#restart').hidden = true
    $('#panel').hidden = true
    window.scrollTo(0, 0)
  })

  $('#count').addEventListener('input', (e) => {
    $('#count-out').textContent = e.target.value
    state.options.count = Number(e.target.value)
    run()
  })
  $('#region').addEventListener('change', (e) => {
    const v = e.target.value
    state.options.countries = v === 'ALL' ? null : v.split(',')
    run()
  })
  $('#room').addEventListener('change', (e) => {
    state.options.roomPreference = e.target.value
    run()
  })
  $('#toggle-method').addEventListener('click', () => {
    const m = $('#method')
    m.hidden = !m.hidden
  })
}

function buildRegionOptions() {
  const sel = $('#region')
  if (!sel) return
  const countries = [...new Set(EVENTS.map((e) => e.venue?.country).filter(Boolean))].sort()
  const NORDIC = ['DK', 'SE', 'NO', 'FI', 'IS']
  const EU = [...NORDIC, 'DE', 'NL', 'BE', 'FR', 'GB', 'PL', 'ES', 'IT', 'AT', 'CH', 'CZ', 'IE', 'PT']
  const NAMES = {
    DK: t('regionDK'), SE: lang === 'da' ? 'Sverige' : 'Sweden', NO: lang === 'da' ? 'Norge' : 'Norway',
    DE: lang === 'da' ? 'Tyskland' : 'Germany', GB: lang === 'da' ? 'Storbritannien' : 'United Kingdom',
    NL: lang === 'da' ? 'Holland' : 'Netherlands', FI: lang === 'da' ? 'Finland' : 'Finland',
  }
  const opts = [
    { v: 'DK', label: t('regionDK') },
    ...(countries.some((c) => NORDIC.includes(c) && c !== 'DK')
      ? [{ v: NORDIC.join(','), label: lang === 'da' ? 'Norden' : 'The Nordics' }]
      : []),
    ...(countries.some((c) => EU.includes(c) && c !== 'DK')
      ? [{ v: EU.join(','), label: lang === 'da' ? 'Europa' : 'Europe' }]
      : []),
    { v: 'ALL', label: t('regionAll') },
    ...countries.filter((c) => c !== 'DK').map((c) => ({ v: c, label: NAMES[c] || c })),
  ]
  const current = sel.value
  sel.innerHTML = opts.map((o) => `<option value="${o.v}">${esc(o.label)}</option>`).join('')
  if (current && opts.some((o) => o.v === current)) sel.value = current
}

// ------------------------------------------------------------------- import

function panel(html) {
  const p = $('#panel')
  p.hidden = false
  p.innerHTML = html
  p.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function initImport() {
  $('#way-file').addEventListener('click', showFilePanel)
  $('#way-name').addEventListener('click', showNamePanel)
  $('#way-type').addEventListener('click', showTypePanel)

  const input = $('#file-input')
  input.addEventListener('change', () => {
    if (input.files?.length) handleFiles([...input.files])
  })

  // Dropping on the page anywhere is friendlier than hunting for the target.
  document.addEventListener('dragover', (e) => {
    e.preventDefault()
    $('#drop')?.classList.add('over')
  })
  document.addEventListener('dragleave', () => $('#drop')?.classList.remove('over'))
  document.addEventListener('drop', (e) => {
    e.preventDefault()
    $('#drop')?.classList.remove('over')
    const files = [...(e.dataTransfer?.files || [])]
    if (files.length) {
      showFilePanel()
      handleFiles(files)
    }
  })
}

function showFilePanel() {
  panel(`
    <div class="drop" id="drop">
      <p style="font-size:17px;font-weight:600;margin-bottom:12px">${esc(t('dropHere'))}
        <button class="btn" type="button" id="pick">${esc(t('choose'))}</button>
      </p>
      <p style="font-size:13px;color:var(--ink-3);max-width:52ch;margin:0 auto">${esc(t('dropHint'))}</p>
      <div id="file-status" style="margin-top:16px;font-size:14px"></div>
    </div>`)
  $('#pick').addEventListener('click', () => $('#file-input').click())
}

function showNamePanel() {
  panel(`
    <div class="drop">
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;max-width:460px;margin:0 auto">
        <input class="field" id="lb-name" placeholder="ListenBrainz username" style="flex:1;min-width:200px" />
        <button class="btn" type="button" id="lb-go">${esc(t('lbGo'))}</button>
      </div>
      <p style="font-size:13px;color:var(--ink-3);max-width:52ch;margin:14px auto 0">${esc(t('lbHint'))}</p>
      <div id="file-status" style="margin-top:16px;font-size:14px"></div>
    </div>`)
  $('#lb-go').addEventListener('click', fetchListenBrainz)
  $('#lb-name').addEventListener('keydown', (e) => e.key === 'Enter' && fetchListenBrainz())
}

function showTypePanel() {
  panel(`
    <div class="drop" style="text-align:left">
      <textarea class="field" id="type-in" placeholder="Iceage&#10;MØ&#10;Efterklang&#10;The Minds of 99&#10;Erika de Casier"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:14px;flex-wrap:wrap">
        <p style="font-size:13px;color:var(--ink-3);max-width:46ch;margin:0">${esc(t('typeHint'))}</p>
        <button class="btn" type="button" id="type-go">${esc(t('typeGo'))}</button>
      </div>
      <div id="file-status" style="margin-top:16px;font-size:14px"></div>
    </div>`)
  $('#type-go').addEventListener('click', () => {
    const text = $('#type-in').value
    if (!text.trim()) return
    loadTaste(() => importListening([{ name: 'typed.txt', text }]))
  })
}

function status(msg, spin = false) {
  const el = $('#file-status')
  if (el) el.innerHTML = `${spin ? '<span class="pulse"></span> ' : ''}${esc(msg)}`
}

async function handleFiles(files) {
  status(`${t('reading')} ${files.map((f) => f.name).join(', ')}…`, true)
  await loadTaste(async () => {
    const zip = files.find((f) => /\.zip$/i.test(f.name))
    if (zip) return importListening(await zip.arrayBuffer())
    const texts = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
    return importListening(texts)
  })
}

async function fetchListenBrainz() {
  const name = $('#lb-name').value.trim()
  if (!name) return
  status(`${t('reading')} ${name}…`, true)
  try {
    const url = `https://api.listenbrainz.org/1/stats/user/${encodeURIComponent(name)}/artists?count=200&range=all_time`
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    const rows = data?.payload?.artists || []
    if (!rows.length) throw new Error('empty')
    state.taste = buildTaste(
      rows.map((a, i) => ({ name: a.artist_name, plays: a.listen_count || null, rank: i }))
    )
    state.importStats = { kinds: ['ListenBrainz: ' + name], distinctArtists: rows.length, records: rows.length, problems: [] }
    showResults()
  } catch (err) {
    status(t('lbFail'))
  }
}

async function loadTaste(fn) {
  try {
    const imported = await fn()
    if (!imported.artists.length) {
      status(t('noArtists'))
      return
    }
    state.taste = buildTaste(imported.artists)
    state.importStats = imported.stats
    showResults()
  } catch (err) {
    status(`${err.message || err}`)
  }
}

// ------------------------------------------------------------------- render

function showResults() {
  $('#landing').hidden = true
  $('#results').hidden = false
  $('#restart').hidden = false
  window.scrollTo(0, 0)
  run()
}

function run() {
  if (!state.taste) return
  state.result = recommend({
    taste: state.taste,
    events: EVENTS,
    artistIndex: ARTIST_INDEX,
    options: { ...state.options, lang },
  })
  render()
}

function render() {
  const { picks, diagnostics: d } = state.result
  $('#result-count').textContent = picks.length
  $('#result-said').textContent = STR[lang].saidOne(
    picks.length,
    d.window.from.slice(0, 4) === d.window.to.slice(0, 4)
      ? d.window.from.slice(0, 4)
      : `${d.window.from.slice(0, 7)} → ${d.window.to.slice(0, 7)}`,
    d.eventsConsidered
  )

  $('#short-note').innerHTML = d.short
    ? `<div class="note">${esc(STR[lang].whyShort(picks.length, d.shortReason))}</div>`
    : ''

  $('#no-results').innerHTML = picks.length
    ? ''
    : `<div class="empty-state"><b>${esc(t('nothing'))}</b>${esc(t('nothingP'))}</div>`

  renderSpine(picks, d.window)
  renderMethod(d)
}

function renderSpine(picks, window_) {
  const spine = $('#spine')
  if (!picks.length) {
    spine.innerHTML = ''
    return
  }

  // Group into months, and keep the empty months in between. A year with a
  // four-month gap should look like one.
  const byMonth = new Map()
  for (const p of picks) {
    const k = monthKey(p.event.startDate)
    if (!byMonth.has(k)) byMonth.set(k, [])
    byMonth.get(k).push(p)
  }
  // Span the WHOLE window, not just the first pick to the last. The empty
  // months are the point: a year with a four-month gap should look like one,
  // and a short list should visibly be short against twelve months.
  const all = []
  let cur = monthKey(window_.from)
  const last = monthKey(window_.to)
  let guard = 0
  while (cur <= last && guard++ < 36) {
    all.push(cur)
    const [y, m] = cur.split('-').map(Number)
    cur = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }

  spine.innerHTML = all
    .map((k) => {
      const list = byMonth.get(k) || []
      const [y, m] = k.split('-').map(Number)
      return `<div class="month${list.length ? '' : ' empty'}">
        <div class="month-label"><b>${esc(STR[lang].months[m - 1])}</b>${y}</div>
        ${list.map(pickHtml).join('')}
      </div>`
    })
    .join('')
}

function pickHtml(p) {
  const e = p.event
  const { day, month, dow } = fmtDate(e.startDate)
  const href = e.ticketUrl || e.url || '#'
  const venue = [e.venue?.name, e.venue?.city].filter(Boolean).join(', ')
  const price =
    e.price?.amount != null
      ? e.price.amount === 0
        ? t('free')
        : `${Math.round(e.price.amount)} ${e.price.currency || 'DKK'}`
      : ''

  const chips = []
  if (p.discovery) chips.push(`<span class="chip acc">${esc(t('discovery'))}</span>`)
  else if (p.best?.kind === 'direct') chips.push(`<span class="chip">${esc(t('yourArtist'))}</span>`)
  if (e.isFestival) chips.push(`<span class="chip">${esc(t('festival'))}</span>`)

  return `<a class="pick${p.discovery ? ' disc' : ''}" href="${esc(href)}" target="_blank" rel="noopener">
    <div class="pick-date">
      <b>${day}</b><span>${esc(STR[lang].days[dow])} ${esc(STR[lang].months[month])}</span>
    </div>
    <div class="pick-main">
      <h3>${esc(e.title)}</h3>
      <p class="pick-meta">${esc(venue)}${e.startTime ? `<span class="dot">·</span>${esc(e.startTime)}` : ''}</p>
      <p class="why">${esc(lang === 'da' ? p.whyDa : p.why)}</p>
    </div>
    <div class="pick-side">
      ${chips.join('')}
      ${price ? `<span class="price">${esc(price)}</span>` : ''}
      <span class="tick">${esc(e.ticketUrl ? t('tickets') : t('venuePage'))}</span>
    </div>
  </a>`
}

function renderMethod(d) {
  const s = state.importStats || {}
  const rows = [
    [lang === 'da' ? 'Kunstnere læst fra dine data' : 'Artists read from your data', d.tasteSize],
    [lang === 'da' ? 'Af dem, der optræder i kalenderen' : 'Of those, appearing in the calendar', d.tasteArtistsMatched],
    [lang === 'da' ? 'Koncerter i dit filter' : 'Concerts inside your filter', d.eventsConsidered],
    [lang === 'da' ? 'Koncerter der nåede tærsklen' : 'Concerts that cleared the bar', d.eventsScored],
    [lang === 'da' ? 'Valgt' : 'Selected', d.returned],
    [lang === 'da' ? 'Heraf nyt for dig' : 'Of which new to you', d.discoveryPicks],
  ]
  const filtered = Object.entries(d.filtered).filter(([, v]) => v > 0)

  $('#method').innerHTML = `<div class="note">
    <b>${esc(t('methodH'))}</b>
    <div class="stat-row" style="margin-top:14px">
      ${rows.map(([k, v]) => `<div class="stat"><b>${v}</b><span>${esc(k)}</span></div>`).join('')}
    </div>
    <p style="margin-top:10px">${
      lang === 'da'
        ? 'Hver koncert scores på tre slags belæg: du lytter til dem, du lytter til nogen der ligner dem, eller de rammer dine genrer. Listen bliver derefter spredt ud, så én kunstner ikke fylder den, og mindst to pladser er sat af til noget du ikke allerede kender.'
        : 'Every concert is scored on three kinds of evidence: you listen to them, you listen to someone close to them, or they match your genres. The list is then spread out so one artist cannot dominate it, and at least two places are held for something you do not already know.'
    }</p>
    ${
      filtered.length
        ? `<p style="margin-top:8px;color:var(--ink-3);font-size:13px">${
            lang === 'da' ? 'Sorteret fra: ' : 'Filtered out: '
          }${filtered.map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>`
        : ''
    }
    ${
      s.kinds?.length
        ? `<p style="margin-top:8px;color:var(--ink-3);font-size:13px">${
            lang === 'da' ? 'Læst fra: ' : 'Read from: '
          }${esc(s.kinds.join(', '))}</p>`
        : ''
    }
  </div>`
}

function renderFooter() {
  const age = relativeAge(META.generatedAt)
  const venues = META.counts?.venues ?? 0
  const src = META.perSource?.filter((s) => s.kept > 0) || []
  $('#foot-data').innerHTML =
    lang === 'da'
      ? `${META.counts.events} koncerter, hentet ${esc(age)} (${esc(META.generatedAt.slice(0, 10))}). Opdateres hver mandag.`
      : `${META.counts.events} concerts, fetched ${esc(age)} (${esc(META.generatedAt.slice(0, 10))}). Refreshed every Monday.`
  $('#foot-cover').innerHTML =
    (lang === 'da'
      ? `${venues} spillesteder og festivaler: `
      : `${venues} venues and festivals: `) +
    esc(src.map((s) => s.name).join(', ')) +
    (META.notYetCovered?.length
      ? (lang === 'da' ? '. Endnu ikke dækket: ' : '. Not yet covered: ') +
        esc(META.notYetCovered.map((n) => n.id).join(', '))
      : '')

  const stats = $('#corpus-stats')
  if (stats) {
    stats.innerHTML = [
      [META.counts.events, lang === 'da' ? 'koncerter' : 'concerts'],
      [venues, lang === 'da' ? 'spillesteder' : 'venues'],
      [META.counts.artists, lang === 'da' ? 'kunstnere' : 'artists'],
    ]
      .map(([v, k]) => `<div class="stat"><b>${v}</b><span>${esc(k)}</span></div>`)
      .join('')
  }
}

// ---------------------------------------------------------------------- boot

initChrome()
initImport()
applyLang()
