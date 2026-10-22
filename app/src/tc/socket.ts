// Сигнальный канал TrueConf Server: один WebSocket, кадр — JSON с полем method.
export type Frame = { method: string; [k: string]: any }
type Handler = (f: Frame) => void

export class TCSocket {
  private ws?: WebSocket
  private handlers = new Map<string, Set<Handler>>()
  private anyHandlers = new Set<Handler>()
  log = false
  constructor(public url: string) {}

  open(timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const t = setTimeout(() => { ws.close(); reject(new Error('Сервер не ответил за 15 с')) }, timeoutMs)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('Нет соединения с сервером')) }
      ws.onclose = e => this.dispatch({ method: '_closed', code: e.code })
      ws.onmessage = e => {
        let f: Frame
        try { f = JSON.parse(String(e.data)) } catch { return }
        // Сервер пишет method то с большой, то с маленькой буквы.
        const m = String(f.method ?? f.Method ?? '')
        f.method = m.charAt(0).toLowerCase() + m.slice(1)
        if (this.log) console.debug('<<', f.method, f)
        this.dispatch(f)
      }
    })
  }

  get isOpen() { return this.ws?.readyState === WebSocket.OPEN }
  close() { this.ws?.close() }

  send(f: Frame) {
    if (this.log) console.debug('>>', f.method, f)
    this.ws?.send(JSON.stringify(f))
  }

  on(method: string, h: Handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method)!.add(h)
    return () => this.handlers.get(method)!.delete(h)
  }
  onAny(h: Handler) { this.anyHandlers.add(h); return () => this.anyHandlers.delete(h) }

  // Отправить и дождаться первого кадра, который подходит под условие.
  request(f: Frame | null, method: string, match: (r: Frame) => boolean = () => true, timeoutMs = 15000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const off = this.on(method, r => { if (match(r)) { off(); clearTimeout(t); resolve(r) } })
      const t = setTimeout(() => { off(); reject(new Error(`Нет ответа на ${f?.method ?? method}`)) }, timeoutMs)
      if (f) this.send(f)
    })
  }

  private dispatch(f: Frame) {
    this.handlers.get(f.method)?.forEach(h => h(f))
    this.anyHandlers.forEach(h => h(f))
  }
}
