import type { Presence } from '../tc/client'

// Приглушённые тона: аватар — тонированная плашка с инициалами того же тона.
const TONES = ['#7c8ea6', '#8a9a7b', '#a69580', '#9a8296', '#7f9c9c', '#a3877c', '#8b8fa8', '#93a07f']

export function initials(name: string) {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function Avatar({ name, id, size = 40, presence }: { name: string; id: string; size?: number; presence?: Presence }) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <div className="avatar" style={{ width: size, height: size, ['--tone' as any]: TONES[h % TONES.length], fontSize: size * 0.36 }}>
      {initials(name)}
      {presence && <span className={`dot ${presence}`} />}
    </div>
  )
}

export const PRESENCE_LABEL: Record<Presence, string> = { online: 'В сети', away: 'Отошёл', busy: 'Занят', dnd: 'Не беспокоить', offline: 'Не в сети' }

export function formatTime(ts?: number) {
  if (!ts) return ''
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'вчера'
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' })
}

export function dayLabel(ts: number) {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Сегодня'
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Вчера'
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}
