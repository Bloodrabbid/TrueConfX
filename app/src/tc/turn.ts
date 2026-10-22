// Расшифровка пароля TURN из getIceConfig (AES-GCM-256, ключ из HKDF-SHA256).
const enc = new TextEncoder()

export async function decryptTurnCredential(hex: string, cid: string, streamConferenceId: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', enc.encode(cid), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(streamConferenceId), info: enc.encode('app=bridge;module=conference;dir=s2c;') },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  const data = new Uint8Array(hex.match(/../g)!.map(h => parseInt(h, 16)))
  const iv = enc.encode(cid).slice(0, 12)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, data)
  return new TextDecoder().decode(plain)
}

export type IceConfigFrame = {
  iceServers?: { serviceType: number; address: string; port: number; transport: number; userName?: string; credential?: string }[]
  gatherer?: { client?: { policy?: number; transport?: number }; server?: { policy?: number; transport?: number } }
}

const TRANSPORT = ['udp', 'tcp', 'tls']

export async function toRtcConfig(f: IceConfigFrame, cid: string, streamId: string): Promise<RTCConfiguration> {
  const servers: RTCIceServer[] = []
  for (const s of f.iceServers ?? []) {
    if (s.serviceType === 0) { servers.push({ urls: `stun:${s.address}:${s.port}` }); continue }
    const scheme = s.transport === 2 ? 'turns' : 'turn'
    const tr = s.transport === 2 ? 'tcp' : TRANSPORT[s.transport] ?? 'udp'
    let credential = s.credential ?? ''
    try { if (credential) credential = await decryptTurnCredential(credential, cid, streamId) } catch { /* оставляем как есть */ }
    servers.push({ urls: `${scheme}:${s.address}:${s.port}?transport=${tr}`, username: s.userName, credential })
  }
  return { iceServers: servers, iceTransportPolicy: f.gatherer?.client?.policy === 1 ? 'relay' : 'all', bundlePolicy: 'max-bundle' }
}
