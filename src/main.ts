import './style.css'
import { allRounds, askPersist, clearRounds, deleteRound, load, putRound, remove, save } from './db'
import { render } from './md'
import {
  ApiError,
  DEFAULT_SLOTS,
  PROVIDERS,
  callModel,
  friendly,
  providerName,
  testKey,
  type ErrKind,
  type ProviderId,
  type Slot,
  type Source,
} from './providers'
import { SYNTH_SYSTEM, buildSynthesis, type Mapping } from './synth'

const HISTORY_KEEP = 50
const TIMEOUT_MS = 180_000
const DEFAULT_SYSTEM =
  'Answer clearly and accurately, in the language of the question. Keep it reasonably short. If you are not sure about something, say so.'

interface Settings {
  v: 1
  slots: Slot[]
  synth: string
  fallback: string
  autoCombine: boolean
  system: string
}
type Keys = Partial<Record<ProviderId, string>>

interface Err {
  kind: ErrKind
  msg: string
  detail: string
}
interface Answer {
  slot: string
  label: string
  provider: ProviderId
  model: string
  search?: boolean
  status: 'running' | 'done' | 'error'
  text: string
  ms: number
  err?: Err
  sources?: Source[]
}
interface Synth {
  status: 'running' | 'done' | 'error'
  text: string
  ms: number
  label: string
  mapping: Mapping[]
  note?: string
  err?: Err
}
interface Round {
  id: string
  ts: number
  question: string
  answers: Answer[]
  synth?: Synth
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

function defaults(): Settings {
  return {
    v: 1,
    slots: clone(DEFAULT_SLOTS),
    synth: 'gemini-flash',
    fallback: 'mistral-large',
    autoCombine: false,
    system: DEFAULT_SYSTEM,
  }
}

let settings: Settings = defaults()
let keys: Keys = {}
let current: Round | null = null
let roundCtrl: AbortController | null = null
let synthCtrl: AbortController | null = null
const starts = new Map<object, number>()

// ---------- DOM helpers ----------
type Attrs = Record<string, string | boolean | number | EventListener | undefined>
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v)
    else if (k === 'class') e.className = String(v)
    else if (k === 'text') e.textContent = String(v)
    else if (v === true) e.setAttribute(k, '')
    else e.setAttribute(k, String(v))
  }
  for (const k of kids) if (k) e.append(k)
  return e
}

const app = document.querySelector<HTMLDivElement>('#app')!

// ---------- shell ----------
const btnHistory = el('button', { class: 'nav', type: 'button', text: 'History', onclick: () => show('history') })
const btnSettings = el('button', { class: 'nav', type: 'button', text: 'Settings', onclick: () => show('settings') })
const btnBack = el('button', { class: 'nav back', type: 'button', text: '← Back', onclick: () => show('ask') })
const bar = el(
  'header',
  { class: 'bar' },
  el('h1', { class: 'title', text: 'Ask All' }),
  el('nav', {}, btnBack, btnHistory, btnSettings),
)

const qEl = el('textarea', {
  id: 'q',
  rows: 3,
  placeholder: 'Ask anything…',
  'aria-label': 'Your question',
  enterkeyhint: 'enter',
})
const goBtn = el('button', { class: 'primary go', type: 'button', text: 'Ask all' })
const hint = el('span', { class: 'hint', text: /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ + Enter' : 'Ctrl + Enter' })
const notice = el('div', { class: 'notice', hidden: true })
const openRow = el(
  'div',
  { class: 'open-in' },
  el('span', { text: 'Also ask in:' }),
  ...[
    ['ChatGPT', 'https://chatgpt.com/'],
    ['Claude', 'https://claude.ai/new'],
    ['Grok', 'https://grok.com/'],
  ].map(([name, url]) => el('button', { type: 'button', class: 'chip', text: name, title: `Copies your question and opens ${name}`, onclick: () => openSite(name, url) })),
)

const qShown = el('p', { class: 'q-shown', hidden: true })
const panels = el('div', { class: 'panels' })
const combineBtn = el('button', { class: 'primary', type: 'button', text: 'Combine answers' })
const combineHint = el('span', { class: 'hint' })
const combineBar = el('div', { class: 'combine-bar', hidden: true }, combineBtn, combineHint)
const synthBox = el('div', { class: 'synth-box' })

const askView = el(
  'section',
  { class: 'view ask' },
  notice,
  el('div', { class: 'ask-box' }, qEl, el('div', { class: 'row' }, goBtn, hint)),
  openRow,
  qShown,
  panels,
  combineBar,
  synthBox,
)
const historyView = el('section', { class: 'view history', hidden: true })
const settingsView = el('section', { class: 'view settings', hidden: true })
const toastEl = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' })
app.append(bar, el('main', {}, askView, historyView, settingsView), toastEl)

let toastTimer = 0
function toast(msg: string) {
  toastEl.textContent = msg
  toastEl.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), 2600)
}

function show(view: 'ask' | 'history' | 'settings') {
  askView.hidden = view !== 'ask'
  historyView.hidden = view !== 'history'
  settingsView.hidden = view !== 'settings'
  btnBack.hidden = view === 'ask'
  btnHistory.hidden = view === 'history'
  btnSettings.hidden = view === 'settings'
  if (view === 'history') void renderHistory()
  if (view === 'settings') renderSettings()
  if (view === 'ask') updateNotice()
  window.scrollTo(0, 0)
}

async function copy(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    toast(what)
  } catch {
    toast('Could not copy')
  }
}

function openSite(name: string, url: string) {
  window.open(url, '_blank', 'noopener')
  const q = qEl.value.trim()
  if (q) void copy(q, `Question copied — paste it into ${name}`)
}

function secs(ms: number) {
  return `${(ms / 1000).toFixed(1)} s`
}

function updateNotice() {
  const has = Object.values(keys).some(Boolean)
  notice.hidden = has
  notice.replaceChildren(
    el('span', { text: 'Add a free key to start. Gemini and Groq take a couple of minutes and cover three models.' }),
    el('button', { type: 'button', class: 'chip', text: 'Open Settings', onclick: () => show('settings') }),
  )
}

// ---------- answer cards ----------
interface Card {
  root: HTMLElement
  time: HTMLElement
  body: HTMLElement
  sources: HTMLElement
  pending: boolean
}
const cards = new WeakMap<object, Card>()

function errOf(e: unknown): Err {
  if (e instanceof ApiError) return { kind: e.kind, msg: friendly(e.kind), detail: e.detail }
  return { kind: 'other', msg: friendly('other'), detail: e instanceof Error ? e.message : String(e) }
}

function makeCard(round: Round, a: Answer): HTMLElement {
  const time = el('span', { class: 'time' })
  const body = el('div', { class: 'body md' })
  const sources = el('div', { class: 'sources' })
  const root = el(
    'article',
    { class: 'card', 'data-slot': a.slot },
    el(
      'header',
      {},
      el('span', { class: 'spin', 'aria-hidden': 'true' }),
      el('div', { class: 'who' }, el('strong', { text: a.label }), el('small', { text: `${providerName(a.provider)} · ${a.model}${a.search ? ' · Search' : ''}` })),
      time,
    ),
    body,
    sources,
    el(
      'footer',
      {},
      el('button', { type: 'button', class: 'small', text: 'Copy', onclick: () => (a.text ? void copy(a.text) : toast('Nothing to copy yet')) }),
      el('button', { type: 'button', class: 'small retry', text: 'Retry', onclick: () => void retry(round, a) }),
    ),
  )
  cards.set(a, { root, time, body, sources, pending: false })
  paint(a)
  return root
}

function paint(a: Answer) {
  const c = cards.get(a)
  if (!c) return
  c.root.classList.toggle('running', a.status === 'running')
  c.root.classList.toggle('failed', a.status === 'error')
  const start = starts.get(a)
  c.time.textContent = a.status === 'running' ? (start ? secs(performance.now() - start) : '') : a.ms ? secs(a.ms) : ''
  if (a.status === 'error' && a.err) {
    const box = el('div', { class: 'err' }, el('strong', { text: a.err.msg }))
    if (a.err.detail) box.append(el('small', { text: a.err.detail }))
    if (a.text) c.body.replaceChildren(box, render(a.text))
    else c.body.replaceChildren(box)
  } else if (a.text) {
    c.body.replaceChildren(render(a.text))
  } else {
    c.body.replaceChildren(el('p', { class: 'wait', text: a.status === 'running' ? 'Thinking…' : '' }))
  }
  c.sources.replaceChildren()
  if (a.sources?.length) {
    c.sources.append(el('small', { text: 'Sources:' }))
    const ol = el('ol')
    for (const s of a.sources.slice(0, 8)) {
      const link = el('a', { href: /^https?:/i.test(s.uri) ? s.uri : '#', target: '_blank', rel: 'noopener noreferrer', text: s.title })
      ol.append(el('li', {}, link))
    }
    c.sources.append(ol)
  }
}

function schedule(a: object, fn: () => void) {
  const c = cards.get(a) as { pending: boolean } | undefined
  if (!c || c.pending) return
  c.pending = true
  requestAnimationFrame(() => {
    c.pending = false
    fn()
  })
}

// Ticks the elapsed time on running cards.
setInterval(() => {
  if (!current) return
  for (const a of current.answers) if (a.status === 'running') {
    const c = cards.get(a)
    const s = starts.get(a)
    if (c && s) c.time.textContent = secs(performance.now() - s)
  }
  const sy = current.synth
  if (sy?.status === 'running') {
    const c = cards.get(sy)
    const s = starts.get(sy)
    if (c && s) c.time.textContent = secs(performance.now() - s)
  }
}, 200)

function showRound(r: Round) {
  current = r
  qShown.textContent = r.question
  qShown.hidden = false
  panels.replaceChildren(...r.answers.map((a) => makeCard(r, a)))
  synthBox.replaceChildren()
  if (r.synth) synthBox.append(makeSynthCard(r, r.synth))
  refreshControls()
}

function refreshControls() {
  const r = current
  const running = !!r && r.answers.some((a) => a.status === 'running')
  goBtn.textContent = running ? 'Stop' : 'Ask all'
  goBtn.classList.toggle('stop', running)
  if (!r) {
    combineBar.hidden = true
    return
  }
  const ok = r.answers.filter((a) => a.status === 'done' && a.text).length
  combineBar.hidden = false
  const synthRunning = r.synth?.status === 'running'
  combineBtn.disabled = ok < 2 || synthRunning
  combineBtn.textContent = synthRunning ? 'Combining…' : r.synth ? 'Combine again' : 'Combine answers'
  combineHint.textContent =
    ok < 2 ? (running ? 'Waiting for answers…' : 'Needs at least 2 answers') : `${ok} answers · names hidden from the combining AI`
}

// ---------- asking ----------
function signalFor(parent: AbortSignal): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController()
  let timed = false
  const onAbort = () => ctrl.abort()
  parent.addEventListener('abort', onAbort)
  const t = setTimeout(() => {
    timed = true
    ctrl.abort()
  }, TIMEOUT_MS)
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(t)
      parent.removeEventListener('abort', onAbort)
    },
    timedOut: () => timed,
  }
}

async function runAnswer(r: Round, a: Answer, parent: AbortSignal) {
  a.status = 'running'
  a.text = ''
  a.err = undefined
  a.sources = undefined
  a.ms = 0
  const t0 = performance.now()
  starts.set(a, t0)
  paint(a)
  refreshControls()
  const s = signalFor(parent)
  try {
    const res = await callModel({
      provider: a.provider,
      model: a.model,
      key: keys[a.provider] ?? '',
      system: settings.system.trim(),
      prompt: r.question,
      search: a.search,
      signal: s.signal,
      onText: (t) => {
        a.text = t
        schedule(a, () => paint(a))
      },
    })
    a.text = res.text
    a.sources = res.sources
    a.status = 'done'
  } catch (e) {
    a.status = 'error'
    if (s.signal.aborted) a.err = s.timedOut() ? { kind: 'timeout', msg: friendly('timeout'), detail: '' } : { kind: 'other', msg: 'Stopped', detail: '' }
    else a.err = errOf(e)
  } finally {
    s.done()
    a.ms = Math.round(performance.now() - t0)
    starts.delete(a)
    paint(a)
    refreshControls()
  }
}

async function ask() {
  if (current?.answers.some((a) => a.status === 'running')) {
    roundCtrl?.abort()
    return
  }
  const q = qEl.value.trim()
  if (!q) {
    qEl.focus()
    return
  }
  const slots = settings.slots.filter((s) => s.enabled)
  if (!slots.length) {
    toast('Turn on at least one model in Settings')
    return
  }
  synthCtrl?.abort()
  roundCtrl = new AbortController()
  const signal = roundCtrl.signal
  const r: Round = {
    id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()),
    ts: Date.now(),
    question: q,
    answers: slots.map((s) => ({
      slot: s.id,
      label: s.label.trim() || s.model,
      provider: s.provider,
      model: s.model.trim(),
      search: s.provider === 'gemini' && !!s.search,
      status: 'running',
      text: '',
      ms: 0,
    })),
  }
  showRound(r)
  await Promise.all(r.answers.map((a) => runAnswer(r, a, signal)))
  await saveRound(r)
  const ok = r.answers.filter((a) => a.status === 'done' && a.text).length
  if (settings.autoCombine && ok >= 2 && current === r && !signal.aborted) await combine(r)
}

async function retry(r: Round, a: Answer) {
  if (a.status === 'running') return
  if (!roundCtrl || roundCtrl.signal.aborted) roundCtrl = new AbortController()
  await runAnswer(r, a, roundCtrl.signal)
  await saveRound(r)
}

async function saveRound(r: Round) {
  try {
    await putRound(clone(r), HISTORY_KEEP)
  } catch {
    toast('Could not save to history')
  }
}

// ---------- combining ----------
function makeSynthCard(r: Round, sy: Synth): HTMLElement {
  const time = el('span', { class: 'time' })
  const body = el('div', { class: 'body md' })
  const sources = el('div', { class: 'map' })
  const root = el(
    'article',
    { class: 'card synth' },
    el(
      'header',
      {},
      el('span', { class: 'spin', 'aria-hidden': 'true' }),
      el('div', { class: 'who' }, el('strong', { text: 'Combined answer' }), el('small', { class: 'by' })),
      time,
    ),
    sources,
    body,
    el(
      'footer',
      {},
      el('button', { type: 'button', class: 'small', text: 'Copy', onclick: () => (sy.text ? void copy(sy.text) : toast('Nothing to copy yet')) }),
      el('button', { type: 'button', class: 'small retry', text: 'Retry', onclick: () => void combine(r) }),
    ),
  )
  cards.set(sy, { root, time, body, sources, pending: false })
  paintSynth(sy)
  return root
}

function paintSynth(sy: Synth) {
  const c = cards.get(sy)
  if (!c) return
  c.root.classList.toggle('running', sy.status === 'running')
  c.root.classList.toggle('failed', sy.status === 'error')
  const by = c.root.querySelector('.by')!
  by.textContent = sy.label ? `by ${sy.label}${sy.note ? ` — ${sy.note}` : ''}` : ''
  const s = starts.get(sy)
  c.time.textContent = sy.status === 'running' ? (s ? secs(performance.now() - s) : '') : sy.ms ? secs(sy.ms) : ''
  c.sources.replaceChildren(
    el('small', { text: 'Who is who (the combining AI only saw letters):' }),
    el('div', { class: 'chips' }, ...sy.mapping.map((m) => el('span', { class: 'tag', text: `${m.letter} = ${m.label}` }))),
  )
  if (sy.status === 'error' && sy.err) {
    const box = el('div', { class: 'err' }, el('strong', { text: sy.err.msg }))
    if (sy.err.detail) box.append(el('small', { text: sy.err.detail }))
    c.body.replaceChildren(box)
  } else if (sy.text) c.body.replaceChildren(render(sy.text))
  else c.body.replaceChildren(el('p', { class: 'wait', text: sy.status === 'running' ? 'Comparing answers…' : '' }))
}

async function combine(r: Round) {
  const ok = r.answers.filter((a) => a.status === 'done' && a.text)
  if (ok.length < 2) {
    toast('Needs at least 2 answers to combine')
    return
  }
  if (r.synth?.status === 'running') return
  synthCtrl?.abort()
  synthCtrl = new AbortController()
  const parent = synthCtrl.signal
  const { prompt, mapping } = buildSynthesis(
    r.question,
    ok.map((a) => ({ label: a.label, text: a.text })),
  )
  const sy: Synth = { status: 'running', text: '', ms: 0, label: '', mapping }
  r.synth = sy
  if (current === r) {
    synthBox.replaceChildren(makeSynthCard(r, sy))
    cards.get(sy)?.root.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  refreshControls()
  const ids = [settings.synth, settings.fallback].filter((id, i, l) => id && l.indexOf(id) === i)
  const order = ids.map((id) => settings.slots.find((s) => s.id === id)).filter((s): s is Slot => !!s)
  if (!order.length) order.push(settings.slots[0])
  const t0 = performance.now()
  starts.set(sy, t0)
  for (let k = 0; k < order.length; k++) {
    const slot = order[k]
    sy.label = slot.label.trim() || slot.model
    sy.text = ''
    paintSynth(sy)
    const s = signalFor(parent)
    try {
      const res = await callModel({
        provider: slot.provider,
        model: slot.model,
        key: keys[slot.provider] ?? '',
        system: SYNTH_SYSTEM,
        prompt,
        signal: s.signal,
        onText: (t) => {
          sy.text = t
          schedule(sy, () => paintSynth(sy))
        },
      })
      sy.text = res.text
      sy.status = 'done'
      sy.err = undefined
      break
    } catch (e) {
      if (parent.aborted) {
        sy.status = 'error'
        sy.err = { kind: 'other', msg: 'Stopped', detail: '' }
        break
      }
      const err = s.timedOut() ? { kind: 'timeout' as const, msg: friendly('timeout'), detail: '' } : errOf(e)
      if (k < order.length - 1) {
        sy.note = `${sy.label}: ${err.msg.split(' — ')[0].toLowerCase()}, used the backup`
        continue
      }
      sy.status = 'error'
      sy.err = err
    } finally {
      s.done()
    }
  }
  sy.ms = Math.round(performance.now() - t0)
  starts.delete(sy)
  paintSynth(sy)
  refreshControls()
  await saveRound(r)
}

goBtn.addEventListener('click', () => void ask())
combineBtn.addEventListener('click', () => current && void combine(current))
qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    void ask()
  }
})

// ---------- history ----------
async function renderHistory() {
  const rounds = await allRounds<Round>()
  const list = el('ul', { class: 'hist' })
  for (const r of rounds) {
    const ok = r.answers.filter((a) => a.status === 'done').length
    const meta = `${new Date(r.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${ok}/${r.answers.length} answers${r.synth?.status === 'done' ? ' · combined' : ''}`
    list.append(
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            class: 'hist-open',
            onclick: () => {
              qEl.value = r.question
              show('ask')
              showRound(r)
            },
          },
          el('span', { class: 'hq', text: r.question }),
          el('small', { text: meta }),
        ),
        el('button', {
          type: 'button',
          class: 'small danger',
          text: 'Delete',
          'aria-label': 'Delete this round',
          onclick: async () => {
            await deleteRound(r.id)
            if (current?.id === r.id) current.id = 'deleted-' + r.id
            void renderHistory()
          },
        }),
      ),
    )
  }
  historyView.replaceChildren(
    ...[
    el('h2', { text: 'History' }),
    el('p', { class: 'muted', text: `The last ${HISTORY_KEEP} questions are kept on this device only.` }),
    rounds.length ? list : el('p', { class: 'muted', text: 'Nothing yet.' }),
    rounds.length
      ? el('button', {
          type: 'button',
          class: 'danger',
          text: 'Delete all history',
          onclick: async () => {
            if (!confirm('Delete all saved questions and answers?')) return
            await clearRounds()
            void renderHistory()
          },
        })
      : null,
    ].filter((x): x is NonNullable<typeof x> => !!x),
  )
}

// ---------- settings ----------
let saveTimer = 0
function persistSettings() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void save('settings', settings), 250)
}
let keyTimer = 0
function persistKeys() {
  clearTimeout(keyTimer)
  keyTimer = window.setTimeout(() => {
    void save('keys', keys)
    void askPersist()
  }, 250)
}

function renderSettings() {
  const keyCards = PROVIDERS.map((p) => {
    const input = el('input', {
      type: 'password',
      class: 'key',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: `${p.name} API key`,
      'aria-label': `${p.name} API key`,
      'data-provider': p.id,
    })
    input.value = keys[p.id] ?? ''
    input.addEventListener('input', () => {
      const v = input.value.trim()
      if (v) keys[p.id] = v
      else delete keys[p.id]
      persistKeys()
    })
    const result = el('span', { class: 'test-result' })
    const test = el('button', {
      type: 'button',
      class: 'small',
      text: 'Test key',
      onclick: async () => {
        result.className = 'test-result'
        result.textContent = 'Testing…'
        const models = settings.slots.filter((s) => s.provider === p.id).map((s) => s.model)
        const r = await testKey(p.id, keys[p.id] ?? '', models)
        result.className = `test-result ${r.ok ? 'ok' : 'bad'}`
        result.textContent = r.message
      },
    })
    const show = el('button', {
      type: 'button',
      class: 'small',
      text: 'Show',
      onclick: () => {
        input.type = input.type === 'password' ? 'text' : 'password'
        show.textContent = input.type === 'password' ? 'Show' : 'Hide'
      },
    })
    return el(
      'div',
      { class: 'prov' },
      el('div', { class: 'prov-head' }, el('strong', { text: p.name }), el('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Get a free key ↗' })),
      el('p', { class: 'muted', text: p.note }),
      el('div', { class: 'row' }, input, show, test),
      result,
    )
  })

  const modelRows = el('div', { class: 'models' })
  const synthSel = el('select', { 'aria-label': 'Combining model' })
  const fallSel = el('select', { 'aria-label': 'Backup combining model' })
  const fillSelects = () => {
    for (const [sel, val] of [
      [synthSel, settings.synth],
      [fallSel, settings.fallback],
    ] as const) {
      sel.replaceChildren(...settings.slots.map((s) => el('option', { value: s.id, text: `${s.label || s.model} (${providerName(s.provider)})` })))
      sel.value = val
    }
  }
  synthSel.addEventListener('change', () => {
    settings.synth = synthSel.value
    persistSettings()
  })
  fallSel.addEventListener('change', () => {
    settings.fallback = fallSel.value
    persistSettings()
  })

  const drawModels = () => {
    modelRows.replaceChildren(
      ...settings.slots.map((s) => {
        const on = el('input', { type: 'checkbox', 'aria-label': `Use ${s.label}` })
        on.checked = s.enabled
        on.addEventListener('change', () => {
          s.enabled = on.checked
          persistSettings()
        })
        const label = el('input', { type: 'text', class: 'label', 'aria-label': 'Name', placeholder: 'Name' })
        label.value = s.label
        label.addEventListener('input', () => {
          s.label = label.value
          persistSettings()
        })
        label.addEventListener('change', fillSelects)
        const model = el('input', { type: 'text', class: 'model', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Model id', placeholder: 'Model id' })
        model.value = s.model
        model.addEventListener('input', () => {
          s.model = model.value.trim()
          persistSettings()
        })
        let prov: HTMLElement
        if (s.custom) {
          const sel = el('select', { 'aria-label': 'Provider' })
          sel.append(...PROVIDERS.map((p) => el('option', { value: p.id, text: p.name })))
          sel.value = s.provider
          sel.addEventListener('change', () => {
            s.provider = sel.value as ProviderId
            if (s.provider !== 'gemini') s.search = false
            persistSettings()
            drawModels()
            fillSelects()
          })
          prov = sel
        } else prov = el('span', { class: 'prov-name', text: providerName(s.provider) })
        const extras: HTMLElement[] = []
        if (s.provider === 'gemini') {
          const g = el('input', { type: 'checkbox' })
          g.checked = !!s.search
          g.addEventListener('change', () => {
            s.search = g.checked
            persistSettings()
          })
          extras.push(el('label', { class: 'inline', title: 'Free on Gemini 2.5 Flash / Flash-Lite only (500 a day)' }, g, ' Google Search (free only on 2.5 models)'))
        }
        if (s.custom)
          extras.push(
            el('button', {
              type: 'button',
              class: 'small danger',
              text: 'Remove',
              onclick: () => {
                settings.slots = settings.slots.filter((x) => x !== s)
                persistSettings()
                drawModels()
                fillSelects()
              },
            }),
          )
        return el(
          'div',
          { class: `model-row${s.enabled ? '' : ' off'}` },
          el('label', { class: 'inline' }, on, prov),
          label,
          model,
          extras.length ? el('div', { class: 'row' }, ...extras) : null,
        )
      }),
    )
  }
  drawModels()
  fillSelects()

  const auto = el('input', { type: 'checkbox' })
  auto.checked = settings.autoCombine
  auto.addEventListener('change', () => {
    settings.autoCombine = auto.checked
    persistSettings()
  })
  const sys = el('textarea', { rows: 3, 'aria-label': 'Instructions sent to every model' })
  sys.value = settings.system
  sys.addEventListener('input', () => {
    settings.system = sys.value
    persistSettings()
  })

  settingsView.replaceChildren(
    el('h2', { text: 'Settings' }),
    el(
      'p',
      { class: 'note' },
      'Keys are kept only in this browser on this device (IndexedDB) and are sent only to the matching AI company. ',
      el('strong', { text: 'Free tiers may use your questions to train or improve their models' }),
      ', so don’t paste private or personal information.',
    ),
    el('h3', { text: 'API keys' }),
    ...keyCards,
    el('h3', { text: 'Models' }),
    el('p', { class: 'muted', text: 'Tick the ones to ask. Model names change over time; if one says “model not found”, paste the current id from the provider’s model list. “Test key” shows whether each id is listed.' }),
    modelRows,
    el(
      'div',
      { class: 'row' },
      el('button', {
        type: 'button',
        class: 'small',
        text: '+ Add a model',
        onclick: () => {
          settings.slots.push({ id: `c-${Date.now()}`, provider: 'openrouter', label: 'New model', model: '', enabled: false, custom: true })
          persistSettings()
          drawModels()
          fillSelects()
        },
      }),
      el('button', {
        type: 'button',
        class: 'small',
        text: 'Reset models',
        onclick: () => {
          if (!confirm('Put the model list back to the defaults?')) return
          const d = defaults()
          settings.slots = d.slots
          settings.synth = d.synth
          settings.fallback = d.fallback
          persistSettings()
          drawModels()
          fillSelects()
        },
      }),
    ),
    el('h3', { text: 'Combine' }),
    el('label', { class: 'field' }, el('span', { text: 'Combining model' }), synthSel),
    el('label', { class: 'field' }, el('span', { text: 'Backup if it fails (e.g. daily limit)' }), fallSel),
    el('label', { class: 'inline' }, auto, ' Combine automatically when the answers are in'),
    el('h3', { text: 'Instructions sent to every model' }),
    sys,
    el('h3', { text: 'Clean up' }),
    el(
      'div',
      { class: 'row' },
      el('button', {
        type: 'button',
        class: 'danger',
        text: 'Delete all keys',
        onclick: async () => {
          if (!confirm('Delete all saved API keys from this device?')) return
          keys = {}
          clearTimeout(keyTimer)
          await remove('keys')
          renderSettings()
          toast('All keys deleted')
        },
      }),
    ),
  )
}

// ---------- start ----------
async function start() {
  const s = await load<Settings>('settings')
  if (s && s.v === 1 && Array.isArray(s.slots)) settings = { ...defaults(), ...s }
  keys = (await load<Keys>('keys')) ?? {}
  void askPersist()
  show('ask')
  refreshControls()
}
void start()
