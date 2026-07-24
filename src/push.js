// Push notifications — native (Capacitor/iOS) only. No-ops everywhere else, so
// the web app and dev browser are unaffected. Push is ENCOURAGED, never required
// (App Store 4.5.4): the in-app trade badge stays the guaranteed path.
import { Capacitor } from '@capacitor/core'
import { supabase } from './supabase'

const isNative = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'

// TestFlight + App Store builds use the production APNs environment; a build run
// straight from Xcode to a device uses sandbox. The Edge Function retries the
// other host on a mismatch, so this is only a hint. VITE_APNS_ENV can override
// it during dev testing.
const APNS_ENV = import.meta.env.VITE_APNS_ENV || 'production'

let registeredToken = null

// Ask iOS for permission and, if granted, register for a token. Returns the
// permission state so callers can prime/gate UI. Safe to call repeatedly.
export async function enablePush() {
  if (!isNative) return 'unsupported'
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    let perm = await PushNotifications.checkPermissions()
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions()
    }
    if (perm.receive !== 'granted') return perm.receive // 'denied' | 'prompt'
    await PushNotifications.register() // fires 'registration' → handled by initPush's listener
    return 'granted'
  } catch (e) {
    console.error('enablePush failed', e)
    return 'error'
  }
}

// Current permission state without prompting — for deciding whether to show the
// priming screen. 'granted' | 'denied' | 'prompt' | 'unsupported'.
export async function pushPermission() {
  if (!isNative) return 'unsupported'
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    return (await PushNotifications.checkPermissions()).receive
  } catch { return 'unsupported' }
}

// Wire the token + tap listeners ONCE at app start. onOpen(data) is called when
// the user taps a notification, with the payload's `data` ({type, chat_id, ...})
// so the app can jump to the right trade.
export async function initPush({ onOpen } = {}) {
  if (!isNative) return
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    PushNotifications.addListener('registration', async (t) => {
      registeredToken = t.value
      // Store against the current user; a no-op if signed out (RLS/auth guard).
      const { data: { user } } = await supabase.auth.getUser()
      if (user) await supabase.rpc('register_device_token', { p_token: t.value, p_environment: APNS_ENV }).catch(() => {})
    })
    PushNotifications.addListener('registrationError', (e) => console.error('APNs registration error', e))
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data = action?.notification?.data || {}
      onOpen?.(data)
    })

    // If permission was already granted in a past session, silently re-register
    // (the token can rotate) — no prompt.
    if ((await PushNotifications.checkPermissions()).receive === 'granted') {
      await PushNotifications.register()
    }
  } catch (e) {
    console.error('initPush failed', e)
  }
}

// Re-bind the already-registered token to whoever is signed in now — covers a
// sign-out → different-user sign-in without an app restart. Silent (no prompt).
export async function syncPushToken() {
  if (!isNative || !registeredToken) return
  try { await supabase.rpc('register_device_token', { p_token: registeredToken, p_environment: APNS_ENV }) } catch {}
}

// On sign-out, drop this device's token so a shared phone doesn't keep buzzing
// for the previous user.
export async function unregisterPush() {
  if (!isNative || !registeredToken) return
  try { await supabase.rpc('unregister_device_token', { p_token: registeredToken }) } catch {}
  registeredToken = null
}
