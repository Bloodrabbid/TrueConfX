interface Window {
  native?: {
    platform: string
    notify: (title: string, body: string) => Promise<void>
    download: (url: string, name: string) => Promise<void>
    takeLink: () => Promise<string | undefined>
    onDeepLink: (cb: (url: string) => void) => void
    onPickScreen: (cb: (list: { id: string; name: string; thumb: string }[]) => void) => void
    pickScreen: (id: string | null) => void
    saveCredentials: (server: string, login: string, password: string) => Promise<void>
    loadCredentials: () => Promise<{ server: string; login: string; password: string } | null>
  }
}
