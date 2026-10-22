// Панель «Файлы»: все вложения чата. Сервер 5.5 не отвечает на CHAT_FILE_LIST,
// поэтому собираем их из истории и по кнопке догружаем более ранние сообщения.
import { useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { MSG } from '../tc/client'
import { Attachment } from './Attachment'
import { dayLabel, formatTime } from './common'

export function FilesPanel() {
  const { showFiles, activeChatId, messages, nameOf, set, loadOlder } = useStore()
  const [loading, setLoading] = useState(false)
  if (!showFiles || !activeChatId) return null
  const all = messages[activeChatId] ?? []
  const files = all.filter(m => m.type === MSG.FILE).reverse()
  const more = async () => { setLoading(true); await loadOlder(activeChatId).catch(() => {}); setLoading(false) }
  return (
    <aside className="members files-panel">
      <div className="members-head">
        <div><h3>Файлы</h3><span className="muted small">{files.length} в загруженной истории</span></div>
        <button className="ghost" title="Закрыть" onClick={() => set({ showFiles: false })}><X size={17} /></button>
      </div>
      <div className="list">
        {files.map(m => (
          <div key={m.messageId} className="file-row">
            <div className="muted small">{nameOf(m.sender).split(' ').slice(0, 2).join(' ')} · {dayLabel(m.timestamp)} {formatTime(m.timestamp)}</div>
            <Attachment m={m} />
          </div>
        ))}
        {!files.length && <div className="empty">Файлов пока не видно</div>}
        <button className="members-action" disabled={loading} onClick={more}>{loading ? 'Загружаю…' : 'Показать более ранние'}</button>
      </div>
    </aside>
  )
}
