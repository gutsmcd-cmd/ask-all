// Provider adapters. Every call goes straight from this device to the provider.

export type ProviderId = 'gemini' | 'groq' | 'mistral' | 'openrouter' | 'cohere'

export interface ProviderInfo {
  id: ProviderId
  name: string
  keyUrl: string
  note: string
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Google AI Studio → Get API key. Free, no card. Daily limits reset at midnight US Pacific (16:00–17:00 JST).',
  },
  {
    id: 'groq',
    name: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    note: 'Free plan, no card. One key runs two models: OpenAI gpt-oss-120b and Qwen. About 1,000 questions a day each.',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    keyUrl: 'https://console.mistral.ai',
    note: 'Free mode, no card (asks for an SMS phone check). Turn off training in Admin if it is offered.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Optional. Free (":free") models only, 50 requests a day in total. Free models need "may train" allowed in Privacy settings.',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    note: 'Optional. Free trial key: 1,000 calls a month.',
  },
]

export function providerName(id: ProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id
}

export interface Slot {
  id: string
  provider: ProviderId
  label: string
  model: string
  enabled: boolean
  search?: boolean // Gemini only: Google Search grounding
  custom?: boolean
}

// Defaults checked against the official model lists on 9 Oct 2026. Ids change, so all are editable.
export const DEFAULT_SLOTS: Slot[] = [
  { id: 'gemini-flash', provider: 'gemini', label: 'Gemini 3.8 Flash', model: 'gemini-3.8-flash', enabled: true },
  {
    id: 'gemini-search',
    provider: 'gemini',
    label: 'Gemini 2.5 Flash + Google Search',
    model: 'gemini-2.5-flash',
    enabled: false,
    search: true,
  },
  { id: 'groq-gptoss', provider: 'groq', label: 'GPT-OSS 120B (OpenAI)', model: 'openai/gpt-oss-120b', enabled: true },
  { id: 'groq-qwen', provider: 'groq', label: 'Qwen 3.8 27B', model: 'qwen/qwen3.8-27b', enabled: true },
  { id: 'mistral-large', provider: 'mistral', label: 'Mistral Large', model: 'mistral-large-latest', enabled: true },
  {
    id: 'openrouter-free',
    provider: 'openrouter',
    label: 'Nemotron 3 Ultra (OpenRouter)',
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    enabled: false,
  },
  { id: 'cohere-command', provider: 'cohere', label: 'Command A+ (Cohere)', model: 'command-a-plus-05-2026', enabled: false },
]

export type ErrKind = 'nokey' | 'auth' | 'limit' | 'notfound' | 'busy' | 'network' | 'timeout' | 'empty' | 'other'

export class ApiError extends Error {
  constructor(
    public kind: ErrKind,
    public status: number,
    public detail: string,
  ) {
    super(detail || kind)
  }
}

export function friendly(kind: ErrKind): string {
  switch (kind) {
    case 'nokey':
      return 'No key yet — add one in Settings, or turn this model off'
    case 'auth':
      return 'Key missing or invalid — check it in Settings'
    case 'limit':
      return 'Daily limit reached — try later'
    case 'notfound':
      return 'Model not found — check the model id in Settings'
    case 'busy':
      return 'Service busy — try again in a minute'
    case 'network':
      return 'Network error — check your connection'
    case 'timeout':
      return 'Took too long — try again'
    case 'empty':
      return 'Came back empty — try again'
    default:
      return 'Something went wrong'
  }
}

function kindFor(status: number, detail: string): ErrKind {
  const d = detail.toLowerCase()
  if (status === 429) return 'limit'
  if (status === 401 || status === 403) return 'auth'
  if (d.includes('api key not valid') || d.includes('api_key_invalid') || d.includes('invalid api key')) return 'auth'
  if (status === 404) return 'notfound'
  if (d.includes('quota') || d.includes('rate limit') || d.includes('resource_exhausted')) return 'limit'
  if (status === 400 && (d.includes('model') && (d.includes('not found') || d.includes('invalid') || d.includes('does not exist'))))
    return 'notfound'
  if (status >= 500) return 'busy'
  return 'other'
}

function messageOf(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  const e = b.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') {
    const m = (e as Record<string, unknown>).message
    if (typeof m === 'string') return m
  }
  if (typeof b.message === 'string') return b.message
  if (typeof b.detail === 'string') return b.detail
  if (Array.isArray(b.detail)) return b.detail.map((x) => (x && typeof x === 'object' ? String((x as { msg?: string }).msg ?? '') : String(x))).join('; ')
  return ''
}

async function failFrom(res: Response): Promise<never> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* ignore */
  }
  let detail = text
  try {
    detail = messageOf(JSON.parse(text)) || text
  } catch {
    /* not JSON */
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300)
  throw new ApiError(kindFor(res.status, detail), res.status, detail || `HTTP ${res.status}`)
}

async function doFetch(url: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { ...init, referrerPolicy: 'strict-origin-when-cross-origin', cache: 'no-store' })
  } catch (e) {
    if (init.signal?.aborted) throw e
    throw new ApiError('network', 0, e instanceof Error ? e.message : String(e))
  }
  if (!res.ok) await failFrom(res)
  return res
}

/** Yields `{event, data}` for each server-sent event. */
async function* sse(res: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let event = ''
  let data: string[] = []
  const flush = function* () {
    if (data.length) yield { event, data: data.join('\n') }
    event = ''
    data = []
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(buf[i] === '\r' ? i + 2 : i + 1)
      if (line === '') yield* flush()
      else if (line.startsWith(':')) continue
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) event = line.slice(6).trim()
    }
  }
  buf += dec.decode()
  if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''))
  yield* flush()
}

function parse(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Hides reasoning that some open models put inside <think> tags. */
export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '')
}

export interface Source {
  title: string
  uri: string
}

export interface CallArgs {
  provider: ProviderId
  model: string
  key: string
  system: string
  prompt: string
  search?: boolean
  signal: AbortSignal
  onText: (text: string) => void
}

export interface CallResult {
  text: string
  sources?: Source[]
}

const OPENAI_BASE: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

export async function callModel(a: CallArgs): Promise<CallResult> {
  if (!a.key) throw new ApiError('nokey', 0, '')
  if (!a.model.trim()) throw new ApiError('notfound', 0, 'No model id set')
  let out: CallResult
  if (a.provider === 'gemini') out = await gemini(a)
  else if (a.provider === 'cohere') out = await cohere(a)
  else out = await openaiCompat(a)
  out.text = stripThink(out.text).trim()
  if (!out.text) throw new ApiError('empty', 0, 'No text in the reply')
  return out
}

async function gemini(a: CallArgs): Promise<CallResult> {
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: a.prompt }] }],
  }
  if (a.system) body.systemInstruction = { parts: [{ text: a.system }] }
  if (a.search) body.tools = [{ google_search: {} }]
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.model.trim())}:streamGenerateContent?alt=sse`
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': a.key },
    body: JSON.stringify(body),
    signal: a.signal,
  })
  let text = ''
  let blocked = ''
  const sources: Source[] = []
  for await (const ev of sse(res)) {
    const j = parse(ev.data)
    if (!j) continue
    if (j.error) throw new ApiError(kindFor(Number((j.error as { code?: number }).code) || 0, messageOf(j)), 0, messageOf(j))
    const cands = (j.candidates as Array<Record<string, unknown>> | undefined) ?? []
    const c = cands[0]
    const pf = j.promptFeedback as { blockReason?: string } | undefined
    if (pf?.blockReason) blocked = pf.blockReason
    if (!c) continue
    const parts = ((c.content as { parts?: Array<{ text?: string; thought?: boolean }> } | undefined)?.parts ?? [])
    for (const p of parts) if (p.text && !p.thought) text += p.text
    const fr = c.finishReason as string | undefined
    if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS' && !text) blocked = fr
    const gm = c.groundingMetadata as { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } | undefined
    for (const g of gm?.groundingChunks ?? []) {
      if (g.web?.uri && !sources.some((s) => s.uri === g.web!.uri)) sources.push({ uri: g.web.uri, title: g.web.title || g.web.uri })
    }
    a.onText(text)
  }
  if (!text && blocked) throw new ApiError('empty', 0, `Blocked by the model (${blocked})`)
  return { text, sources: sources.length ? sources : undefined }
}

async function openaiCompat(a: CallArgs): Promise<CallResult> {
  const messages = []
  if (a.system) messages.push({ role: 'system', content: a.system })
  messages.push({ role: 'user', content: a.prompt })
  const res = await doFetch(`${OPENAI_BASE[a.provider]}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.key}` },
    body: JSON.stringify({ model: a.model.trim(), messages, stream: true }),
    signal: a.signal,
  })
  let text = ''
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    text = j.choices?.[0]?.message?.content ?? ''
    a.onText(text)
    return { text }
  }
  for await (const ev of sse(res)) {
    if (ev.data === '[DONE]') break
    const j = parse(ev.data)
    if (!j) continue
    if (j.error) {
      const code = Number((j.error as { code?: number }).code) || 0
      throw new ApiError(kindFor(code, messageOf(j)), code, messageOf(j))
    }
    const ch = (j.choices as Array<{ delta?: { content?: string | null } }> | undefined)?.[0]
    const d = ch?.delta?.content
    if (d) {
      text += d
      a.onText(stripThink(text))
    }
  }
  return { text }
}

async function cohere(a: CallArgs): Promise<CallResult> {
  const messages = []
  if (a.system) messages.push({ role: 'system', content: a.system })
  messages.push({ role: 'user', content: a.prompt })
  const res = await doFetch('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${a.key}` },
    body: JSON.stringify({ model: a.model.trim(), messages, stream: true }),
    signal: a.signal,
  })
  let text = ''
  for await (const ev of sse(res)) {
    const j = parse(ev.data)
    if (!j) continue
    const type = (j.type as string | undefined) ?? ev.event
    if (type === 'content-delta') {
      const t = (j.delta as { message?: { content?: { text?: string } } } | undefined)?.message?.content?.text
      if (t) {
        text += t
        a.onText(text)
      }
    }
  }
  return { text }
}

/** Checks a key and reports which of the given model ids the provider lists. */
export async function testKey(
  provider: ProviderId,
  key: string,
  models: string[],
): Promise<{ ok: boolean; message: string }> {
  if (!key) return { ok: false, message: 'Paste a key first.' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    let ids: string[] = []
    if (provider === 'gemini') {
      const r = await doFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
        headers: { 'x-goog-api-key': key },
        signal: ctrl.signal,
      })
      const j = (await r.json()) as { models?: Array<{ name: string }> }
      ids = (j.models ?? []).map((m) => m.name.replace(/^models\//, ''))
    } else if (provider === 'cohere') {
      const r = await doFetch('https://api.cohere.com/v1/models?page_size=1000', {
        headers: { authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      })
      const j = (await r.json()) as { models?: Array<{ name: string }> }
      ids = (j.models ?? []).map((m) => m.name)
    } else if (provider === 'openrouter') {
      await doFetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: ctrl.signal })
      const r = await doFetch('https://openrouter.ai/api/v1/models', { signal: ctrl.signal })
      const j = (await r.json()) as { data?: Array<{ id: string }> }
      ids = (j.data ?? []).map((m) => m.id)
    } else {
      const r = await doFetch(`${OPENAI_BASE[provider]}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      })
      const j = (await r.json()) as { data?: Array<{ id: string; aliases?: string[] }> }
      ids = (j.data ?? []).flatMap((m) => [m.id, ...(m.aliases ?? [])])
    }
    const marks = models
      .filter((m) => m.trim())
      .map((m) => `${m.trim()} ${ids.includes(m.trim()) ? '✓' : '✗ not listed'}`)
    return { ok: true, message: `Key works.${marks.length ? ' ' + marks.join(' · ') : ''}` }
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, message: `${friendly(e.kind)}${e.detail ? ` (${e.detail})` : ''}` }
    return { ok: false, message: ctrl.signal.aborted ? friendly('timeout') : String(e) }
  } finally {
    clearTimeout(timer)
  }
}
