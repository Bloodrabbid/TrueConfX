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

// Файл у отправителя качаем сами по порту 4307 (Electron). Один запрос на файл, результат живёт, пока открыто приложение.
const p2pLoads = new Map<string, Promise<string | undefined>>()
function p2pLoad(hash: string, hosts: string[], mime: string): Promise<string | undefined> {
  if (!window.native?.p2pFetch) return Promise.resolve(undefined)
  let p = p2pLoads.get(hash)
  if (!p) {
    p = window.native.p2pFetch(hosts, hash).then(r => {
      if (r.ok) return URL.createObjectURL(new Blob([r.data as BlobPart], { type: mime }))
      p2pLoads.delete(hash) // не вышло — следующая проверка попробует снова
      return undefined
    })
    p2pLoads.set(hash, p)
  }
  return p
}

type FileState = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'fetching'; percent: number } | { kind: 'missing' }

function useFile(hash: string | undefined, size: number, mime: string, sender: string) {
  const client = useStore(s => s.client)
  const [state, setState] = useState<FileState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // Превью сервер отдаёт и тогда, когда сам файл ещё у отправителя.
  const [preview, setPreview] = useState<string>()

  useEffect(() => {
    if (!hash || !client) return
    let alive = true, watching = false, done = false
    const ready = (url: string) => { done = true; setState({ kind: 'ready', url }) }
    // Файл у отправителя: сервер отправителя отдаёт его по порту 4307, но только после того,
    // как какой-нибудь клиент TrueConf «поднял» его запросом по закрытому каналу. Поэтому проверяем часто и дёшево.
    const tryP2P = () => {
      if (done) return
      const hosts = [sender.split('@')[1]?.split('/')[0], client.host]
      const off = window.native?.onP2PProgress?.(p => { if (alive && !done && p.hash === hash && p.total) setState({ kind: 'fetching', percent: Math.floor((100 * p.got) / p.total) }) })
      p2pLoad(hash, hosts, mime).then(url => { off?.(); if (alive && !done && url) ready(url) })
    }
    const load = async () => {
      const e = await client.fileInfo(hash)
      if (!alive || done) return
      if (!e) return setState({ kind: 'missing' })
      setPreview(e.previews?.[0]?.downloadUrl)
      if (e.readyState === 2) return ready(e.downloadUrl)
      if (watching) return
      watching = true
      const ok = await client.watchUpload(hash, bytes => {
        // Сервер иногда шлёт мусорное число вместо прогресса — такое пропускаем.
        if (!alive || !Number.isFinite(bytes) || bytes > size * 2) return
        if (bytes >= size) { client.forgetFile(hash); watching = false; load() } else setState({ kind: 'fetching', percent: Math.floor((100 * bytes) / size) })
      })
      if (alive && !done) setState(st => (!ok ? { kind: 'missing' } : st.kind === 'loading' ? { kind: 'fetching', percent: 0 } : st))
    }
    load()
    tryP2P()
    const p2pTimer = setInterval(tryP2P, 5_000)
    const infoTimer = setInterval(() => { if (alive && !done) { client.forgetFile(hash); load() } }, 30_000)
    return () => { alive = false; clearInterval(p2pTimer); clearInterval(infoTimer); if (watching) client.unwatchUpload(hash) }
  }, [hash, client, size, mime, sender, attempt])

  // Ссылка с токеном могла протухнуть — один раз запрашиваем новую.
  const retry = () => { if (hash && client && attempt < 1) { client.forgetFile(hash); setAttempt(a => a + 1) } else setState({ kind: 'missing' }) }
  // Ручной повтор: отправитель мог появиться в сети и снова раздавать файл.
  const again = () => { if (hash && client) { client.forgetFile(hash); setState({ kind: 'loading' }); setAttempt(a => a + 1) } }
  return { state, preview, retry, again }
}

export function Attachment({ m }: { m: ServerMessage }) {
  const c = m.content ?? {}
  const size: number = c.file_size ?? 0
  const { state, preview, retry, again } = useFile(c.hash, size, c.file_type ?? '', String(c.from_instance ?? m.sender))
  const nameOf = useStore(s => s.nameOf)
  const [zoom, setZoom] = useState(false)
  const mime: string = c.file_type ?? ''
  const name: string = c.file_name ?? 'файл'
  const url = state.kind === 'ready' ? state.url : undefined
  const isImage = mime.startsWith('image/')

  if (isImage && (state.kind !== 'missing' || preview)) {
    const w = c.preview?.width, h = c.preview?.height
    const style = w && h ? { aspectRatio: `${w} / ${h}`, width: Math.min(w, 420) } : { minWidth: 240, minHeight: 160, maxWidth: 420 }
    return (
      <>
        <button className="att-image" style={style} onClick={() => url && setZoom(true)}>
          {url ? <img src={url} alt={name} loading="lazy" onError={retry} />
            : preview ? <><img src={preview} alt={name} className="att-preview" /><span className="att-progress">Оригинал ещё на сервере отправителя{state.kind === 'fetching' && state.percent > 0 ? ` · ${state.percent}%` : ''}</span></>
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
  const sub = missing ? `Файл на сервере ${nameOf(owner).split(' ').slice(0, 2).join(' ')}, сервер пока его не отдаёт. Нажмите «Скачать» в приложении TrueConf — файл появится здесь`
    : state.kind === 'fetching' ? `Забираю файл у отправителя… ${state.percent}%`
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
