import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { Capacitor } from '@capacitor/core'
import './index.css'
import App from './App.jsx'

// iOS standalone PWAs won't notice a new deploy on their own and get stuck on a
// stale bundle. Force an update check whenever the app regains focus; with
// registerType 'autoUpdate' a found update is applied and the page reloads.
// Skip this entirely inside the native (Capacitor) shell: there the app runs
// from bundled local files, so a service worker would only reintroduce the very
// stale-bundle problem it exists to solve on the web.
if (!Capacitor.isNativePlatform()) {
  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, r) {
      if (!r) return
      const check = () => { if (document.visibilityState === 'visible') r.update() }
      document.addEventListener('visibilitychange', check)
      window.addEventListener('focus', check)
    },
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
