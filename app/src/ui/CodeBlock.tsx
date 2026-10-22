// Блок кода в сообщении: подсветка, копирование, сворачивание длинного.
import { useMemo, useState } from 'react'
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import sql from 'highlight.js/lib/languages/sql'
import xml from 'highlight.js/lib/languages/xml'
import java from 'highlight.js/lib/languages/java'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import python from 'highlight.js/lib/languages/python'
import javascript from 'highlight.js/lib/languages/javascript'

for (const [name, lang] of Object.entries({ json, sql, xml, java, bash, yaml, python, javascript })) hljs.registerLanguage(name, lang)
const AUTO = ['json', 'sql', 'xml', 'java', 'bash', 'yaml', 'python', 'javascript']
const LABEL: Record<string, string> = { json: 'JSON', sql: 'SQL', xml: 'XML', java: 'Java', bash: 'Shell', yaml: 'YAML', python: 'Python', javascript: 'JS', trace: 'Stack trace' }
const COLLAPSE_AT = 18

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const { html, used } = useMemo(() => {
    const known = lang && hljs.getLanguage(lang) ? lang : undefined
    const r = known ? hljs.highlight(code, { language: known }) : hljs.highlightAuto(code, AUTO)
    return { html: r.value, used: lang === 'trace' ? 'trace' : r.language ?? 'text' }
  }, [code, lang])
  const lines = code.split('\n').length
  const long = lines > COLLAPSE_AT
  return (
    <div className={`code ${long && !open ? 'collapsed' : ''}`} onDoubleClick={e => e.stopPropagation()}>
      <div className="code-bar">
        <span>{LABEL[used] ?? used}</span>
        <span className="grow" />
        {long && <button onClick={() => setOpen(!open)}>{open ? <><ChevronUp size={13} /> Свернуть</> : <><ChevronDown size={13} /> Ещё {lines - COLLAPSE_AT} строк</>}</button>}
        <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200) }}>
          {copied ? <><Check size={13} /> Скопировано</> : <><Copy size={13} /> Копировать</>}
        </button>
      </div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  )
}

// ── Поиск структурированных фрагментов в тексте сообщения ───────────────

export type Segment = { kind: 'text'; text: string } | { kind: 'code'; code: string; lang?: string }

// Конец JSON-объекта/массива с учётом строк и экранированных кавычек.
function matchBracket(s: string, start: number) {
  const open = s[start], close = open === '{' ? '}' : ']'
  let depth = 0, inStr = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === open || ch === '{' || ch === '[') depth++
    else if (ch === close || ch === '}' || ch === ']') { depth--; if (depth === 0) return i }
  }
  return -1
}

// JSON может прийти экранированным ({\"a\":1}) — пробуем как есть и без экранирования.
function parseJson(raw: string): unknown | undefined {
  for (const cand of [raw, raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\')]) {
    try { const v = JSON.parse(cand); if (v && typeof v === 'object') return v } catch { /* дальше */ }
  }
  return undefined
}

function splitJson(text: string): Segment[] {
  const out: Segment[] = []
  let rest = text
  for (;;) {
    const m = /[{[]/.exec(rest)
    if (!m) break
    const end = matchBracket(rest, m.index)
    const raw = end > 0 ? rest.slice(m.index, end + 1) : ''
    const value = raw.length >= 15 ? parseJson(raw) : undefined
    if (value === undefined || Object.keys(value as object).length === 0) {
      // Не JSON — оставляем символ текстом и ищем дальше.
      out.push({ kind: 'text', text: rest.slice(0, m.index + 1) })
      rest = rest.slice(m.index + 1)
      continue
    }
    out.push({ kind: 'text', text: rest.slice(0, m.index) })
    out.push({ kind: 'code', code: JSON.stringify(value, null, 2), lang: 'json' })
    rest = rest.slice(end + 1)
  }
  out.push({ kind: 'text', text: rest })
  // Склеиваем соседние текстовые куски.
  return out.reduce<Segment[]>((acc, s) => {
    const last = acc.at(-1)
    if (s.kind === 'text' && last?.kind === 'text') last.text += s.text
    else acc.push({ ...s })
    return acc
  }, []).filter(s => s.kind === 'code' || s.text.trim())
}

const SQL_RE = /^\s*(select|insert|update|delete|with|create|alter|drop|merge)\b[\s\S]*\b(from|into|set|table|as|where)\b/i
const TRACE_RE = /^\s+at [\w$.<>]+\(.*\)$/m
const XML_RE = /^\s*<(\?xml|[a-zA-Z][\w:-]*)[^>]*>[\s\S]*<\/[\w:-]+>\s*$/

// Разбивает текст на обычные куски и блоки кода. Возвращает undefined, если кода нет.
export function findCode(text: string): Segment[] | undefined {
  // ```lang ... ``` — явная разметка.
  if (text.includes('```')) {
    const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g)
    const out: Segment[] = []
    for (let i = 0; i < parts.length; i += 3) {
      if (parts[i]?.trim()) out.push({ kind: 'text', text: parts[i] })
      if (parts[i + 2] !== undefined) out.push({ kind: 'code', code: parts[i + 2].replace(/\n$/, ''), lang: parts[i + 1] || undefined })
    }
    if (out.some(s => s.kind === 'code')) return out
  }
  if (/[{[]/.test(text)) {
    // JSON, вставленный как строка: {\"a\":1}. Снимаем экранирование кавычек целиком.
    const segs = splitJson(text.includes('\\"') ? text.replace(/\\"/g, '"') : text)
    if (segs.some(s => s.kind === 'code')) return segs
  }
  const lines = text.split('\n').length
  if (lines >= 3 && TRACE_RE.test(text)) return [{ kind: 'code', code: text.trim(), lang: 'trace' }]
  if (lines >= 3 && SQL_RE.test(text)) return [{ kind: 'code', code: text.trim(), lang: 'sql' }]
  if (lines >= 2 && XML_RE.test(text)) return [{ kind: 'code', code: text.trim(), lang: 'xml' }]
  return undefined
}
