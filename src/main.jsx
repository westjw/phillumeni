import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'

// iOS standalone PWAs won't notice a new deploy on their own and get stuck on a
// stale bundle. Force an update check whenever the app regains focus; with
// registerType 'autoUpdate' a found update is applied and the page reloads.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, r) {
    if (!r) return
    const check = () => { if (document.visibilityState === 'visible') r.update() }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
