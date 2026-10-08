// Tiny Markdown renderer that builds DOM nodes directly. Model text never goes through innerHTML.

type Kids = (Node | string)[]

function h(tag: string, kids: Kids = [], cls?: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const k of kids) e.append(k)
  return e
}

const SAFE_URL = /^(https?:|mailto:)/i

const INLINE =
  /(`+)([^`][\s\S]*?)\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\w\\])__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\w\\])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)|\[([^\]\n]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"*_])/

export function inline(src: string): Kids {
  const out: Kids = []
  let s = src
  while (s) {
    const m = INLINE.exec(s)
    if (!m) {
      out.push(s)
      break
    }
    if (m.index) out.push(s.slice(0, m.index))
    if (m[2] !== undefined) out.push(h('code', [m[2].replace(/^ (.*) $/, '$1')]))
    else if (m[3] !== undefined) out.push(h('strong', inline(m[3])))
    else if (m[4] !== undefined) out.push(h('strong', inline(m[4])))
    else if (m[5] !== undefined) out.push(h('del', inline(m[5])))
    else if (m[6] !== undefined) out.push(h('em', inline(m[6])))
    else if (m[7] !== undefined) out.push(h('em', inline(m[7])))
    else if (m[8] !== undefined) out.push(link(m[9], inline(m[8])))
    else if (m[10] !== undefined) out.push(link(m[10], [m[10]]))
    s = s.slice(m.index + m[0].length)
  }
  return out
}

function link(url: string, kids: Kids): Node {
  if (!SAFE_URL.test(url)) return h('span', kids)
  const a = h('a', kids) as HTMLAnchorElement
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  return a
}

const RE_FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/
const RE_HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const RE_QUOTE = /^\s{0,3}>\s?/
const RE_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const RE_TROW = /^\s*\|?.*\|.*\|?\s*$/
const RE_TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function cells(row: string): string[] {
  let r = row.trim()
  if (r.startsWith('|')) r = r.slice(1)
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1)
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

export function render(md: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  for (const n of blocks(md.replace(/\r\n?/g, '\n').split('\n'))) frag.append(n)
  return frag
}

function blocks(lines: string[]): Node[] {
  const out: Node[] = []
  let i = 0
  let para: string[] = []
  const endPara = () => {
    if (para.length) out.push(h('p', inline(para.join('\n').trim()).flatMap(brs)))
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    let m: RegExpExecArray | null
    if (!line.trim()) {
      endPara()
      i++
    } else if ((m = RE_FENCE.exec(line))) {
      endPara()
      const fence = m[1]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++])
      i++
      const code = h('code', [body.join('\n')])
      if (m[2]) code.dataset.lang = m[2]
      out.push(h('pre', [code]))
    } else if ((m = RE_HEAD.exec(line))) {
      endPara()
      out.push(h(`h${Math.min(6, m[1].length + 1)}`, inline(m[2])))
      i++
    } else if (RE_HR.test(line)) {
      endPara()
      out.push(h('hr'))
      i++
    } else if (RE_QUOTE.test(line)) {
      endPara()
      const body: string[] = []
      while (i < lines.length && lines[i].trim() && RE_QUOTE.test(lines[i])) body.push(lines[i++].replace(RE_QUOTE, ''))
      out.push(h('blockquote', blocks(body)))
    } else if (RE_TROW.test(line) && i + 1 < lines.length && RE_TSEP.test(lines[i + 1]) && line.includes('|')) {
      endPara()
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]))
      const thead = h('thead', [h('tr', head.map((c) => h('th', inline(c))))])
      const tbody = h('tbody', rows.map((r) => h('tr', head.map((_, k) => h('td', inline(r[k] ?? ''))))))
      out.push(h('div', [h('table', [thead, tbody])], 'table-wrap'))
    } else if (RE_ITEM.test(line) && (para.length === 0 || /^\s*([-*+]|1[.)])\s/.test(line))) {
      endPara()
      const body: string[] = []
      while (i < lines.length) {
        const l = lines[i]
        if (!l.trim()) {
          // blank line: keep going only if the list continues
          const next = lines.slice(i + 1).find((x) => x.trim())
          if (next && (RE_ITEM.test(next) || /^\s{2,}/.test(next))) {
            body.push('')
            i++
            continue
          }
          break
        }
        if (body.length && !RE_ITEM.test(l) && !/^\s/.test(l) && !body[body.length - 1]) break
        body.push(l)
        i++
      }
      out.push(list(body))
    } else {
      para.push(line)
      i++
    }
  }
  endPara()
  return out
}

function brs(k: Node | string): (Node | string)[] {
  if (typeof k !== 'string' || !k.includes('\n')) return [k]
  const parts = k.split('\n')
  return parts.flatMap((p, j) => (j ? [h('br'), p] : [p]))
}

function list(lines: string[]): Node {
  const first = RE_ITEM.exec(lines[0])!
  const base = first[1].length
  const ordered = /\d/.test(first[2])
  const el = h(ordered ? 'ol' : 'ul')
  if (ordered) {
    const start = parseInt(first[2], 10)
    if (start !== 1) (el as HTMLOListElement).start = start
  }
  let item: string[] | null = null
  const items: string[][] = []
  for (const l of lines) {
    const m = RE_ITEM.exec(l)
    if (m && m[1].length <= base) {
      item = [m[3]]
      items.push(item)
    } else if (item) {
      item.push(l.slice(Math.min(base + 2, l.length - l.trimStart().length)))
    }
  }
  for (const it of items) {
    const li = h('li')
    const sub = blocks(it)
    // A one-paragraph item renders inline (no <p> margin).
    if (sub.length && sub[0] instanceof HTMLElement && (sub[0] as HTMLElement).tagName === 'P' && !it.includes('')) {
      li.append(...Array.from((sub.shift() as HTMLElement).childNodes))
    }
    li.append(...sub)
    el.append(li)
  }
  return el
}
