// Окно отправки файлов, как в официальном клиенте: превью, «Сжать изображение», комментарий.
// Файлы приходят из буфера обмена, перетаскиванием или через скрепку.
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, FileText, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { formatSize } from './Attachment'
import { toHtml } from './Mentions'

const isImage = (f: File) => /^image\/(png|jpe?g|webp|bmp)$/.test(f.type)

async function draw(file: File, max: number, quality: number): Promise<Blob | undefined> {
  const bmp = await createImageBitmap(file).catch(() => undefined)
  if (!bmp) return undefined
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k))
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

// Сжатие: не больше 2560 px по длинной стороне, JPEG 85%. Если выйдет не меньше — шлём оригинал.
async function compress(file: File) {
  const blob = await draw(file, 2560, 0.85)
  if (!blob || blob.size >= file.size) return file
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
}

// Уже набранный в поле ввода текст становится комментарием, как в Telegram.
export function SendFilesDialog({ files, setFiles, draft, clearDraft }: { files: File[]; setFiles: (f: File[]) => void; draft: string; clearDraft: () => void }) {
  const { sendFiles, send, notify } = useStore()
  const [squeeze, setSqueeze] = useState(true)
  const [comment, setComment] = useState(draft)
  const commentRef = useRef<HTMLInputElement>(null)
  useEffect(() => { requestAnimationFrame(() => commentRef.current?.focus()) }, [])
  const [progress, setProgress] = useState<number | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const urls = useMemo(() => files.map(f => (isImage(f) || f.type === 'image/gif' ? URL.createObjectURL(f) : '')), [files])
  useEffect(() => () => urls.forEach(u => u && URL.revokeObjectURL(u)), [urls])
  const images = files.filter(isImage).length
  const allImages = files.every(f => f.type.startsWith('image/'))
  const title = allImages ? `Выбрано ${files.length} ${plural(files.length, 'изображение', 'изображения', 'изображений')}` : `Выбрано ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}`

  const go = async () => {
    setProgress(0)
    try {
      const prepared = await Promise.all(files.map(async f => {
        const file = squeeze && isImage(f) ? await compress(f) : f
        return { file, preview: isImage(f) ? await draw(f, 480, 0.7) : undefined }
      }))
      await sendFiles(prepared, (i, p) => setProgress((i + p) / prepared.length))
      if (comment.trim()) await send(toHtml(comment.trim(), []))
      clearDraft()
      setFiles([])
    } catch (e: any) {
      notify(e.message)
      setProgress(null)
    }
  }

  return (
    <div className="modal-bg" onMouseDown={() => progress === null && setFiles([])}>
      <div className="modal narrow send-files" onMouseDown={e => e.stopPropagation()}>
        <div className="send-files-head"><h3>{title}</h3><button className="ghost" title="Закрыть" onClick={() => setFiles([])}><X size={18} /></button></div>
        <div className="send-files-list">
          {files.map((f, i) => (
            <div key={i} className={urls[i] ? 'sf-image' : 'sf-file'}>
              {urls[i] ? <img src={urls[i]} alt={f.name} /> : <><span className="att-icon"><FileText size={19} /></span><span className="att-meta"><span className="att-name">{f.name}</span><span className="att-size">{formatSize(f.size)}</span></span></>}
              {progress === null && <button className="sf-remove" title="Убрать" onClick={() => setFiles(files.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
            </div>
          ))}
        </div>
        {images > 0 && <label className="check"><input type="checkbox" checked={squeeze} onChange={e => setSqueeze(e.target.checked)} />Сжать {images > 1 ? 'изображения' : 'изображение'}</label>}
        <label className="field">Комментарий<input ref={commentRef} value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => e.key === 'Enter' && progress === null && go()} /></label>
        {progress !== null && <div className="meter"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        <div className="modal-actions">
          <button className="ghost" disabled={progress !== null} onClick={() => picker.current?.click()}>Добавить</button>
          <div className="grow" />
          <button className="ghost" disabled={progress !== null} onClick={() => setFiles([])}>Отмена</button>
          <button className="primary" disabled={progress !== null || !files.length} onClick={go}>{progress === null ? 'Отправить' : `Отправка… ${Math.round(progress * 100)}%`}</button>
        </div>
        <input ref={picker} type="file" multiple hidden onChange={e => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
    </div>
  )
}
