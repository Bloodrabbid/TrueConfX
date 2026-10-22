// Текст сообщений TrueConf приходит как урезанный HTML: <a>, <br>, <b>, сущности &amp;.
// Разбираем его DOMParser'ом и собираем React-узлы только из разрешённых тегов,
// поэтому чужая разметка не исполняется.
import type { ReactNode } from 'react'
import { useStore } from '../store'

const INLINE: Record<string, string> = { b: 'strong', strong: 'strong', i: 'em', em: 'em', u: 'u', s: 's', strike: 's', code: 'code', pre: 'pre' }
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g

function Mention({ id, children }: { id: string; children: ReactNode }) {
  const openP2P = useStore(s => s.openP2P)
  return <button className="mention" title={id} onClick={() => openP2P(id)}>@{children}</button>
}

function linkify(text: string, key: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 ? <a key={`${key}-${i}`} href={part} target="_blank" rel="noreferrer">{part}</a> : part)
}

function walk(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return linkify(node.textContent ?? '', key)
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  const kids = Array.from(el.childNodes).map((c, i) => walk(c, `${key}.${i}`))
  if (tag === 'br') return <br key={key} />
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? ''
    // trueconf:user@host&do=profile — упоминание человека.
    const m = href.match(/^trueconf:([^&\s]+@[^&\s]+)/i)
    if (m) return <Mention key={key} id={m[1]}>{el.textContent}</Mention>
    if (/^(https?:|mailto:)/i.test(href)) return <a key={key} href={href} target="_blank" rel="noreferrer">{el.textContent}</a>
    return <span key={key}>{kids}</span>
  }
  const T = INLINE[tag]
  if (T) { const Tag = T as any; return <Tag key={key}>{kids}</Tag> }
  if (tag === 'p' || tag === 'div') return <span key={key}>{kids}<br /></span>
  return <span key={key}>{kids}</span>
}

export function RichText({ html }: { html: string }) {
  if (!/[<&]/.test(html)) return <>{linkify(html, 't')}</>
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return <>{Array.from(doc.body.childNodes).map((n, i) => walk(n, String(i)))}</>
}

// Тот же текст без разметки — для превью в списке чатов и уведомлений.
export function plainText(html: string) {
  if (!/[<&]/.test(html)) return html
  const doc = new DOMParser().parseFromString(`<body>${html.replace(/<br\s*\/?>/gi, ' ')}</body>`, 'text/html')
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}
