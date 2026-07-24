// Edge Function `push` — delivers a push_outbox row to APNs.
//
// Invoked by a Supabase Database Webhook on push_outbox INSERT. It reads the
// recipient's device tokens, signs an APNs provider JWT with the .p8 key, and
// POSTs the alert to each device over HTTP/2. Dead tokens (410 / BadDeviceToken)
// are pruned. The outbox row is stamped sent_at (or error).
//
// Secrets (set via `supabase secrets set` or the dashboard):
//   APNS_KEY         the .p8 file contents (PEM, with BEGIN/END lines)
//   APNS_KEY_ID      10-char Key ID from the Apple key page
//   APNS_TEAM_ID     your Apple Team ID (68DSBW8375)
//   APNS_BUNDLE_ID   com.phillumeni.app  (the apns-topic)
//   PUSH_WEBHOOK_SECRET  shared secret the webhook sends as x-webhook-secret
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

// Import the Apple .p8 (PKCS#8 PEM) as an ECDSA P-256 signing key.
async function importP8(pem: string): Promise<CryptoKey> {
  const der = atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''))
  const bytes = Uint8Array.from(der, (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

// APNs provider JWT (ES256). Cached ~50 min (Apple requires < 60 min old).
let cachedJwt: { token: string; at: number } | null = null
async function apnsJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedJwt && now - cachedJwt.at < 3000) return cachedJwt.token
  const key = await importP8(Deno.env.get('APNS_KEY')!)
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'ES256', kid: Deno.env.get('APNS_KEY_ID') })))
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: Deno.env.get('APNS_TEAM_ID'), iat: now })))
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`))
  const token = `${header}.${payload}.${b64url(sig)}`
  cachedJwt = { token, at: now }
  return token
}

const HOST = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' }

async function sendOne(token: string, env: string, jwt: string, msg: { title: string; body: string; data: unknown }) {
  const payload = JSON.stringify({
    aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' },
    data: msg.data,
  })
  const headers = {
    authorization: `bearer ${jwt}`,
    'apns-topic': Deno.env.get('APNS_BUNDLE_ID')!,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'content-type': 'application/json',
  }
  // Try the token's own environment first; on a token/env mismatch, try the other.
  const order = env === 'sandbox' ? ['sandbox', 'production'] : ['production', 'sandbox']
  for (const e of order) {
    const res = await fetch(`${HOST[e as keyof typeof HOST]}/3/device/${token}`, { method: 'POST', headers, body: payload })
    if (res.ok) return { ok: true }
    const txt = await res.text().catch(() => '')
    // 410 = unregistered; 400 BadDeviceToken = wrong env → let the loop retry the other host
    if (res.status === 410 || txt.includes('BadDeviceToken')) {
      if (e === order[order.length - 1]) return { ok: false, dead: true, status: res.status, txt }
      continue
    }
    return { ok: false, dead: false, status: res.status, txt }
  }
  return { ok: false, dead: true }
}

Deno.serve(async (req) => {
  // Only the webhook may call this.
  const secret = Deno.env.get('PUSH_WEBHOOK_SECRET')
  if (secret && req.headers.get('x-webhook-secret') !== secret) {
    return new Response('forbidden', { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const row = body?.record
  if (!row?.recipient_id || !row?.id) return new Response('no record', { status: 400 })

  const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: tokens } = await supa.from('device_tokens').select('token, environment').eq('user_id', row.recipient_id)

  if (!tokens || tokens.length === 0) {
    await supa.from('push_outbox').update({ sent_at: new Date().toISOString(), error: 'no devices' }).eq('id', row.id)
    return new Response('no devices', { status: 200 })
  }

  const jwt = await apnsJwt()
  const msg = { title: row.title, body: row.body, data: row.data ?? {} }
  let anyOk = false
  const dead: string[] = []
  for (const t of tokens) {
    const r = await sendOne(t.token, t.environment, jwt, msg)
    if (r.ok) anyOk = true
    else if (r.dead) dead.push(t.token)
  }
  if (dead.length) await supa.from('device_tokens').delete().in('token', dead)
  await supa.from('push_outbox').update({
    sent_at: new Date().toISOString(),
    error: anyOk ? null : 'no live device accepted',
  }).eq('id', row.id)

  return new Response(JSON.stringify({ sent: anyOk, pruned: dead.length }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
})
