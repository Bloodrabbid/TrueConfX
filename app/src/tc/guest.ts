// Кросс-сервер гостевой вход в конференцию TrueConf.
// Когда конференция на другом сервере, чем аккаунт (аккаунт tc.t2.ru, конфа 2811027@tc2.t2.ru),
// вход домашней сессией даёт ошибку 1104. Решение: подключиться к серверу конференции и войти гостем.
//
// Гостевой токен клиент НЕ считает — его выдаёт сам сервер конференции в ответе
// GET /api/v4/software/clients (в web_url и deeplinks как &token=/&password=$2…). Проверено живьём
// на tc2.t2.ru: loginUser login="*guest*<имя>", credentialsType=TOKEN, credentials=<токен> → result 0.
import type { TCClient } from './client'

// Токен: $2<nonce>*<unixtime>*<md5hex>. Регекс терпим к длинам nonce/hash.
const TOKEN_RE = /\$2[A-Za-z0-9]{6,}\*\d{9,}\*[0-9a-f]{20,}/

// Хост сервера конференции: часть id после '@' (до '#' и '/'), иначе домашний хост.
export function confServerHost(confId: string, homeHost: string): string {
  const at = confId.indexOf('@')
  if (at < 0) return homeHost
  return confId.slice(at + 1).split('#')[0].split('/')[0] || homeHost
}

// Конференция на другом сервере, чем домашний?
export function isCrossServer(confId: string, homeHost: string): boolean {
  const h = confServerHost(confId, homeHost)
  return !!homeHost && h.toLowerCase() !== homeHost.toLowerCase()
}

// Номер конференции без ведущего '\c\' и без '@host': сервер конференции ждёт голый номер.
export function confNumber(confId: string): string {
  return confId.replace(/^\\c\\/, '').split('@')[0]
}

// Достать гостевой токен из ответа /api/v4/software/clients (строка или разобранный JSON).
export function extractGuestToken(softwareClients: unknown): string | undefined {
  const blob = typeof softwareClients === 'string' ? softwareClients : JSON.stringify(softwareClients ?? '')
  return blob.match(TOKEN_RE)?.[0]
}

// Запросить у сервера конференции свежий гостевой токен. CORS на эндпоинте открыт (*).
export async function fetchGuestToken(host: string, confId: string): Promise<string> {
  const num = confNumber(confId)
  const url = `https://${host}/api/v4/software/clients?lang=ru&call_id=${encodeURIComponent(num)}&case=join_conference_button`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`Не удалось получить гостевой токен (${r.status})`)
  const token = extractGuestToken(await r.text())
  if (!token) throw new Error('Сервер конференции не выдал гостевой токен')
  return token
}

// Разобрать ссылку/ввод в id конференции, СОХРАНЯЯ сервер (иначе кросс-сервер не определить):
//   trueconf:\c\<id@host#vcs>&h=…  →  <id@host#vcs>   (сервер уже внутри id)
//   https://host/c/<id> | /webrtc/<id>  →  <id>@host
//   голый <id> или <id@host>  →  как есть; иначе undefined
export function parseConfLink(link: string): string | undefined {
  const s = decodeURIComponent(link)
  const dc = s.match(/\\c\\([^&\s/]+)/)?.[1]
  if (dc) return dc
  const web = s.match(/https?:\/\/([^/:]+)(?::\d+)?\/(?:c|webrtc)\/([^/?#\s]+)/)
  if (web) return `${web[2]}@${web[1]}`
  const bare = s.trim()
  return /^[\w-]+(@[\w.-]+)?$/.test(bare) ? bare : undefined
}

// Открыть гостевой клиент на сервере конференции и войти гостем.
export async function openGuestClient(host: string, confId: string, name: string): Promise<TCClient> {
  const { TCClient, AUTH } = await import('./client')
  const token = await fetchGuestToken(host, confId)
  const client = new TCClient(host)
  await client.login(name ? `*guest*${name}` : '*guest*', token, AUTH.TOKEN)
  return client
}
