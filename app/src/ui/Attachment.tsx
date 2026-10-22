// Вложение из чата: картинка показывается превью, остальное — карточкой файла.
// Файл может лежать не на сервере, а у отправителя (раздача P2P): тогда сервер
// подкачивает его по запросу, а если отправитель офлайн — файл недоступен.
import { useEffect, useState } from 'react'
import { FileText, FileArchive, FileImage, FileVideo, FileAudio, Download, X, CloudOff } from 'lucide-react'
import { useStore } from '../store'
import type { ServerMessage } from '../tc/client'

export function formatSize(bytes?: number) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} МБ`
}

function iconFor(mime = '', name = '') {
  if (mime.startsWith('image/')) return FileImage
  if (mime.startsWith('video/')) return FileVideo
  if (mime.startsWith('audio/')) return FileAudio
  if (/\.(zip|rar|7z|gz|tar)$/i.test(name)) return FileArchive
  return FileText
}

type FileState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'fetching'; percent: number } | { kind: 'missing' }

function useFile(hash: string | undefined, size: number) {
  const client = useStore(s => s.client)
  const [state, setState] = useState<FileState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!hash || !client) return
    let alive = true, watching = false
    const load = async () => {
      const e = await client.fileInfo(hash)
      if (!alive) return
      if (!e) return setState({ kind: 'missing' })
      if (e.readyState === 2) return setState({ kind: 'ready', url: e.downloadUrl })
      watching = true
      const ok = await client.watchUpload(hash, bytes => {
        // Сервер иногда шлёт мусорное число вместо прогресса — такое пропускаем.
        if (!alive || !Number.isFinite(bytes) || bytes > size * 2) return
        if (bytes >= size) { client.forgetFile(hash); load() } else setState({ kind: 'fetching', percent: Math.floor((100 * bytes) / size) })
      })
      if (alive) setState(st => (!ok ? { kind: 'missing' } : st.kind === 'loading' ? { kind: 'fetching', percent: 0 } : st))
    }
    load()
    return () => { alive = false; if (watching) client.unwatchUpload(hash) }
  }, [hash, client, size, attempt])

  // Ссылка с токеном могла протухнуть — один раз запрашиваем новую.
  const retry = () => { if (hash && client && attempt < 1) { client.forgetFile(hash); setAttempt(a => a + 1) } else setState({ kind: 'missing' }) }
  // Ручной повтор: отправитель мог появиться в сети и снова раздавать файл.
  const again = () => { if (hash && client) { client.forgetFile(hash); setState({ kind: 'loading' }); setAttempt(a => a + 1) } }
  return { state, retry, again }
}

export function Attachment({ m }: { m: ServerMessage }) {
  const c = m.content ?? {}
  const size: number = c.file_size ?? 0
  const { state, retry, again } = useFile(c.hash, size)
  const nameOf = useStore(s => s.nameOf)
  const [zoom, setZoom] = useState(false)
  const mime: string = c.file_type ?? ''
  const name: string = c.file_name ?? 'файл'
  const url = state.kind === 'ready' ? state.url : undefined
  const isImage = mime.startsWith('image/')

  if (isImage && state.kind !== 'missing') {
    const w = c.preview?.width, h = c.preview?.height
    const style = w && h ? { aspectRatio: `${w} / ${h}`, width: Math.min(w, 420) } : { minWidth: 240, minHeight: 160, maxWidth: 420 }
    return (
      <>
        <button className="att-image" style={style} onClick={() => url && setZoom(true)}>
          {url ? <img src={url} alt={name} loading="lazy" onError={retry} />
            : <span className="att-skeleton">{state.kind === 'fetching' && <span className="att-progress">{state.percent}%</span>}</span>}
        </button>
        {zoom && url && (
          <div className="lightbox" onClick={() => setZoom(false)}>
            <img src={url} alt={name} />
            <div className="lightbox-bar" onClick={e => e.stopPropagation()}>
              <span>{name}</span>
              <button className="ghost" title="Скачать" onClick={() => window.native?.download(url, name)}><Download size={18} /></button>
              <button className="ghost" title="Закрыть" onClick={() => setZoom(false)}><X size={18} /></button>
            </div>
          </div>
        )}
      </>
    )
  }

  const missing = state.kind === 'missing'
  const Icon = missing ? CloudOff : iconFor(mime, name)
  const owner = String(c.from_instance ?? m.sender).split('/')[0]
  const sub = missing ? `Файл у ${nameOf(owner).split(' ').slice(0, 2).join(' ')}, сейчас никто его не раздаёт`
    : state.kind === 'fetching' ? `Сервер забирает файл… ${state.percent}%`
    : state.kind === 'loading' ? `${formatSize(size)} · проверяю…`
    : formatSize(size)
  return (
    <button className={`att-file ${missing ? 'missing' : ''}`} disabled={!url && !missing} onClick={() => url && window.native?.download(url, name)} title={url ? 'Скачать' : undefined}>
      <span className="att-icon"><Icon size={19} /></span>
      <span className="att-meta"><span className="att-name">{name}</span><span className="att-size">{sub}</span></span>
      {url && <Download size={16} className="att-dl" />}
      {missing && <span className="att-retry" role="button" onClick={e => { e.stopPropagation(); again() }}>Повторить</span>}
    </button>
  )
}
