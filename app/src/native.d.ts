interface Window {
  native?: {
    platform: string
    notify: (title: string, body: string, opts?: { chatId?: string; silent?: boolean }) => Promise<void>
    setBadge?: (count: number, image?: string) => Promise<void>
    attention?: () => Promise<void>
    onOpenChat?: (cb: (chatId: string) => void) => () => void
    download: (url: string, name: string) => Promise<void>
    p2pFetch?: (hosts: string[], hash: string) => Promise<{ ok: true; data: Uint8Array } | { ok: false; error: string }>
    onP2PProgress?: (cb: (p: { hash: string; got: number; total: number }) => void) => () => void
    takeLink: () => Promise<string | undefined>
    onDeepLink: (cb: (url: string) => void) => () => void
    onPickScreen: (cb: (list: { id: string; name: string; thumb: string }[]) => void) => () => void
    pickScreen: (id: string | null) => void
    saveCredentials: (server: string, login: string, password: string) => Promise<void>
    loadCredentials: () => Promise<{ server: string; login: string; password: string } | null>
  }
}
