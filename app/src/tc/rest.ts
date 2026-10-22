// REST API личного кабинета TrueConf Server (/api/v4). Нужен там, чего нет в WebSocket:
// создание конференций. Сервер молча игнорирует createConference из веб-протокола.
export class TCRest {
  private access = ''
  private refresh = ''
  private expiresAt = 0
  userId = ''

  constructor(private host: string) {}

  async login(username: string, password: string) {
    await this.token({ grant_type: 'password', username, password })
  }

  private async token(extra: Record<string, string>) {
    const r = await fetch(`https://${this.host}/api/v4/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'trueconf_server_users', ...extra }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.access_token) throw new Error(j.error_description ?? j.error?.message ?? `OAuth ${r.status}`)
    this.access = j.access_token
    this.refresh = j.refresh_token ?? this.refresh
    this.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000
    this.userId = j.user_id ?? this.userId
  }

  get ready() { return !!this.access }

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.access) throw new Error('Нет доступа к REST API сервера')
    if (Date.now() > this.expiresAt - 60_000 && this.refresh) await this.token({ grant_type: 'refresh_token', refresh_token: this.refresh })
    const r = await fetch(`https://${this.host}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${this.access}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    })
    if (r.status === 204) return undefined as T
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const reason = j.error?.errors?.map((e: any) => e.reason).join(', ') || j.error?.message || r.statusText
      throw new Error(`Сервер: ${reason}`)
    }
    return j
  }

  // Конференция «здесь и сейчас»: без расписания, владелец обязан быть в приглашённых.
  async createMeeting(topic: string, invitees: string[], owner: string) {
    const ids = [...new Set([owner, ...invitees])]
    const { conference } = await this.req<{ conference: any }>('POST', '/api/v4/conferences', {
      topic, owner: this.userId, mode: 'PxP', access: 'private', schedule: { type: 'none' },
      max_participants: Math.max(4, ids.length + 2), invitations: ids.map(id => ({ id })),
    })
    await this.req('POST', `/api/v4/conferences/${conference.id}/run`)
    return conference as { id: string; url: string; topic: string }
  }

  remove(id: string) { return this.req('DELETE', `/api/v4/conferences/${id}`) }
}
