import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import '@tabler/icons-webfont/dist/tabler-icons.min.css'
import { supabase } from './supabase.js'
// mapbox-gl (~600KB) is imported lazily inside AppMap so it stays out of the
// initial bundle and only loads once the map actually mounts.

// ─── CONFIG ─────────────────────────────────────────────
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const NYC = { lng: -74.006, lat: 40.7128 }

// Supported cities for manual entry — a real dropdown so adding a second city
// later is a data change, not a UI change (spec §2). center = geocode fallback.
const CITIES = [
  { id: 'NYC', label: 'New York City', center: NYC },
]
const cityCenter = (id) => (CITIES.find(c => c.id === id) || CITIES[0]).center
const cityLabel = (id) => (CITIES.find(c => c.id === id) || CITIES[0]).label

// Pull a real city + neighborhood out of a Mapbox feature's context (works for
// both Search Box retrieve and Geocoding v6 forward) so venues aren't all "NYC".
function placeFromContext(props) {
  const ctx = (props && props.context) || {}
  const city = ctx.place?.name || ctx.locality?.name || ctx.region?.name || null
  const neighborhood = ctx.neighborhood?.name || ctx.locality?.name || null
  return { city, neighborhood }
}

// Title-case a Mapbox poi_category (e.g. "fast food restaurant" -> "Fast Food Restaurant")
const titleCase = (s) => (s ? String(s).replace(/\b\w/g, (c) => c.toUpperCase()) : s)

// "Column not migrated yet" — Postgres reports an undefined column as 42703, but
// PostgREST's schema-cache check reports it as PGRST204 ("Could not find the 'X'
// column of 'Y' in the schema cache"). Treat both (and any schema-cache miss) as
// the column being absent, so the app degrades gracefully on a partial migration.
const isMissingColumn = (err) =>
  !!err && (err.code === '42703' || err.code === 'PGRST204' || /schema cache/i.test(err.message || ''))

// Downscale a photo before upload — phone photos are 3–12MB, which makes uploads
// crawl on cellular. Resize to fit maxDim, re-encode as JPEG, honor EXIF
// orientation. Returns the original file if anything fails or it's already smaller.
async function downscaleImage(file, maxDim = 1600, quality = 0.82) {
  if (!file?.type?.startsWith('image/')) return file
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
    const width = Math.round(bitmap.width * scale)
    const height = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}
const venueInitials = (name) => (name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')

// ─── COLORS ─────────────────────────────────────────────
const C = {
  bg:'#FAFAF8', card:'#FFFFFF', surface:'#F4F1EC',
  border:'#E8E3DA', borderStr:'#D0C8BC',
  text:'#1A1918', sec:'#5C5A56', muted:'#9C9990',
  amber:'#C87B0A', amberBg:'#FDF2DC', amberBd:'#E8C06A',
  green:'#1A9470', greenBg:'#E4F5EE', greenBd:'#6ACBAB',
  purple:'#534AB7', purpleBg:'#EEEDFE', purpleBd:'#AFA9EC',
  red:'#D43C3C', redBg:'#FCECEC',
  dark:'#1A1918',
}

// A keepsake is a matchbook with no place (wedding, event): rankable + collectable,
// but never on the map, nearby list, or shared boards. The (0,0) guard covers rows
// created before migration 020 added the kind column.
const isKeepsake = (v) => v?.kind === 'keepsake' || (Number(v?.lat) === 0 && Number(v?.lng) === 0)

// A spot you can't get a matchbook from anymore. Two ways to die, and they must
// READ differently: 'closed' is the business; 'discontinued' is a business
// that's still open but stopped making them — calling that "Closed" would send
// people past a busy bar the app swears is gone. Same behaviour, honest label.
const isRetired = (v) => v?.status === 'closed' || v?.status === 'discontinued'
const retiredLabel = (v) => (v?.status === 'discontinued' ? 'No longer makes matchbooks' : 'Closed')

// ─── SMALL COMPONENTS ────────────────────────────────────
const Av = ({ ini, bg, tc, size = 34 }) => (
  <div style={{ width: size, height: size, borderRadius: '50%', background: bg, color: tc, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * .34, fontWeight: 600, flexShrink: 0 }}>{ini}</div>
)

const Tag = ({ label, bg, color }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 99, background: bg, color, whiteSpace: 'nowrap', letterSpacing: .2 }}>{label}</span>
)

const Card = ({ children, style = {} }) => (
  <div style={{ background: C.card, borderRadius: 14, border: `0.5px solid ${C.border}`, boxShadow: '0 1px 6px rgba(0,0,0,0.06)', ...style }}>{children}</div>
)

// Clean header that sits below the real iOS status bar (no more fake "9:41").
// In a standalone PWA env(safe-area-inset-top) is the notch height; in a browser
// it resolves to 0, so the max() keeps a small gap either way.
const SBar = ({ title, light }) => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', padding: 'max(12px, env(safe-area-inset-top)) 22px 10px', flexShrink: 0, minHeight: 22 }}>
    {title && <span style={{ fontWeight: 700, fontSize: 16, color: light ? '#fff' : C.text, letterSpacing: '-.3px' }}>{title}</span>}
  </div>
)

const PrimaryBtn = ({ children, onClick, disabled, style = {} }) => (
  <button onClick={onClick} disabled={disabled} style={{ width: '100%', padding: 14, background: disabled ? C.border : C.dark, color: disabled ? C.muted : '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', letterSpacing: '-.2px', transition: 'all .15s', ...style }}>
    {children}
  </button>
)

const OutlineBtn = ({ children, onClick, color, style = {} }) => (
  <button onClick={onClick} style={{ width: '100%', padding: 13, background: 'transparent', color: color || C.dark, border: `1.5px solid ${color || C.dark}`, borderRadius: 13, fontSize: 14, fontWeight: 600, cursor: 'pointer', letterSpacing: '-.1px', ...style }}>
    {children}
  </button>
)

// ─── MATCHBOX ICON ───────────────────────────────────────
function MbIcon({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="mbs"><feDropShadow dx="2" dy="4" stdDeviation="5" floodColor="#000" floodOpacity="0.55" /></filter>
        <filter id="mbt"><feDropShadow dx="1" dy="3" stdDeviation="3" floodColor="#000" floodOpacity="0.45" /></filter>
        <clipPath id="mbc"><rect x="12" y="42" width="118" height="116" rx="8" /></clipPath>
      </defs>
      <rect width="200" height="200" rx="44" fill="#0D0D0D" />
      <g filter="url(#mbt)">
        <rect x="108" y="48" width="82" height="104" rx="6" fill="#F0E8D0" />
        <rect x="108" y="48" width="82" height="104" rx="6" fill="none" stroke="#C4AE82" strokeWidth="3" />
        {[61, 77, 93, 109, 125, 141].map((y, i) => (
          <g key={i}>
            <rect x="112" y={y} width="62" height="6" rx="3" fill="#D4A855" stroke="#8B6820" strokeWidth="0.8" />
            <circle cx="180" cy={y + 3} r="9" fill="#CC3322" />
          </g>
        ))}
      </g>
      <g filter="url(#mbs)">
        <rect x="12" y="42" width="118" height="116" rx="8" fill="#EDE4CB" />
        <g clipPath="url(#mbc)">
          <line x1="43" y1="42" x2="43" y2="158" stroke="#1C1708" strokeWidth="1.5" />
          <rect x="73" y="42" width="3.5" height="116" fill="#CEC4A4" />
          <line x1="12" y1="71" x2="130" y2="71" stroke="#1C1708" strokeWidth="1.3" />
          <rect x="12" y="99" width="118" height="3.5" fill="#CEC4A4" />
          <line x1="12" y1="131" x2="130" y2="131" stroke="#1C1708" strokeWidth="1.3" />
          <path d="M75 80 C68 80 62 86 62 93 C62 103 75 116 75 116 C75 116 88 103 88 93 C88 86 82 80 75 80Z" fill="#E24B4A" />
          <circle cx="75" cy="93" r="6" fill="#EDE4CB" />
        </g>
        <rect x="12" y="42" width="118" height="116" rx="8" fill="none" stroke="#C8B99A" strokeWidth="1" />
        <rect x="122" y="42" width="8" height="116" fill="#C4AE82" />
      </g>
    </svg>
  )
}

// ─── MAPBOX MAP ──────────────────────────────────────────
// Venues render as CLUSTERED WebGL layers, not per-venue DOM markers: with
// ~700 venues, one DOM element each was the map's biggest performance cost on
// phones. Mapbox's geojson clustering merges dense areas into numbered bubbles
// that split apart as you zoom; singles are plain circles (green = active,
// grey = closed) with a bigger ring for the selected venue.

function AppMap({ venues, collectionIds, reportedIds, onSelectVenue, selectedVenue, filter, onCenterChange }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const mapboxglRef = useRef(null)
  const geolocateRef = useRef(null)
  const onCenterChangeRef = useRef(onCenterChange)
  onCenterChangeRef.current = onCenterChange
  const didFitRef = useRef(false)     // initial camera has been set (by GPS or pins)
  const geoFailedRef = useRef(false)  // GPS denied/unavailable → fall back to framing pins
  const [mapReady, setMapReady] = useState(false)
  const selectedRef = useRef(selectedVenue)
  selectedRef.current = selectedVenue
  const venueByIdRef = useRef(new Map()) // vid -> full venue (layer clicks carry only ids)
  const pointsRef = useRef([])           // latest plotted [lng,lat]s, for fitToPins

  // Frame all current pins — the FALLBACK when GPS can't place the user.
  const fitToPins = () => {
    const mapboxgl = mapboxglRef.current
    if (!mapboxgl || !mapRef.current || didFitRef.current) return
    if (!pointsRef.current.length) return // nothing plotted yet; the venues effect fits later
    didFitRef.current = true
    const bounds = new mapboxgl.LngLatBounds()
    pointsRef.current.forEach(p => bounds.extend(p))
    mapRef.current.fitBounds(bounds, { padding: 56, maxZoom: 14.5, duration: 0 })
  }

  // Init map — mapbox-gl is loaded lazily here (kept out of the initial bundle).
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
    let cancelled = false
    ;(async () => {
      const mapboxgl = (await import('mapbox-gl')).default
      await import('mapbox-gl/dist/mapbox-gl.css')
      if (cancelled || mapRef.current || !containerRef.current) return
      mapboxglRef.current = mapboxgl
      mapboxgl.accessToken = MAPBOX_TOKEN

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: [NYC.lng, NYC.lat],
        zoom: 13.5,
        attributionControl: false,
      })

      const geolocate = new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true,
      })

      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right')
      map.addControl(geolocate, 'top-right')

      // Keep the "spots nearby" list in sync with where the map is LOOKING —
      // with hundreds of venues, "nearby" must mean the current view, not A-Z.
      map.on('moveend', () => {
        const c = map.getCenter()
        onCenterChangeRef.current?.({ lat: c.lat, lng: c.lng })
      })

      // Start zoomed in on WHERE YOU ARE, not the far-flung spread of every pin.
      // On success the tracking control flies to + follows the user; if it's
      // denied/unavailable/slow we fall back to framing the user's pins so the
      // map is never stranded on a default city.
      let fallbackTimer = null
      const fallbackToPins = () => {
        if (didFitRef.current) return
        geoFailedRef.current = true
        fitToPins()
      }
      geolocate.on('geolocate', () => {
        didFitRef.current = true          // GPS owns the camera; don't fit over it
        if (fallbackTimer) clearTimeout(fallbackTimer)
      })
      geolocate.on('error', (err) => {
        console.warn('Geolocation unavailable; framing your pins instead.', err?.message || err)
        if (fallbackTimer) clearTimeout(fallbackTimer)
        fallbackToPins()
      })

      map.on('load', () => {
        if (cancelled) return

        // Clustered venue source + layers (WebGL — no DOM markers).
        map.addSource('venues', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterMaxZoom: 15,
          clusterRadius: 46,
        })
        map.addLayer({
          id: 'clusters', type: 'circle', source: 'venues',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': '#1A1918',
            'circle-radius': ['step', ['get', 'point_count'], 15, 25, 19, 100, 23],
            'circle-stroke-width': 2.5, 'circle-stroke-color': '#FFFFFF',
            'circle-opacity': 0.95,
          },
        })
        map.addLayer({
          id: 'cluster-count', type: 'symbol', source: 'venues',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-size': 12, 'text-allow-overlap': true,
          },
          paint: { 'text-color': '#FFFFFF' },
        })
        // grey = closed, amber = already in your collection, green = out there to grab
        const pinColor = ['case',
          ['==', ['get', 'closed'], 1], '#9C9990',
          ['==', ['get', 'collected'], 1], '#C87B0A',
          '#1A9470']
        map.addLayer({
          id: 'pins', type: 'circle', source: 'venues',
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': pinColor, 'circle-radius': 8,
            'circle-stroke-width': 2.5, 'circle-stroke-color': '#FFFFFF',
            'circle-opacity': 0.95,
          },
        })
        map.addLayer({
          id: 'pin-selected', type: 'circle', source: 'venues',
          filter: ['==', ['get', 'vid'], -999],
          paint: {
            'circle-color': pinColor, 'circle-radius': 12,
            'circle-stroke-width': 3.5, 'circle-stroke-color': '#FFFFFF',
          },
        })

        // Tap a cluster → zoom in until it splits.
        map.on('click', 'clusters', (e) => {
          const f = map.queryRenderedFeatures(e.point, { layers: ['clusters'] })[0]
          if (!f) return
          map.getSource('venues').getClusterExpansionZoom(f.properties.cluster_id, (err, zoom) => {
            if (err) return
            map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.4 })
          })
        })
        // Tap a pin → select (tap again → deselect).
        const pinTap = (e) => {
          const f = e.features && e.features[0]
          if (!f) return
          const venue = venueByIdRef.current.get(f.properties.vid)
          if (!venue) return
          onSelectVenue(selectedRef.current?.id === venue.id ? null : venue)
        }
        map.on('click', 'pins', pinTap)
        map.on('click', 'pin-selected', pinTap)
        // Tap empty map → deselect.
        map.on('click', (e) => {
          const hits = map.queryRenderedFeatures(e.point, { layers: ['clusters', 'pins', 'pin-selected'] })
          if (!hits.length && selectedRef.current) onSelectVenue(null)
        })
        ;['clusters', 'pins'].forEach(l => {
          map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', l, () => { map.getCanvas().style.cursor = '' })
        })

        if (import.meta.env.DEV) window.__pmap = map // dev-only test/debug handle

        setMapReady(true)
        try { geolocate.trigger() } catch { /* control not ready yet */ }
        // GPS can hang without ever firing error — fall back after a short wait.
        fallbackTimer = setTimeout(fallbackToPins, 4000)
      })

      mapRef.current = map
      geolocateRef.current = geolocate
    })()

    return () => {
      cancelled = true
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
    }
  }, [])

  // Push the visible venue set into the clustered source — one setData call,
  // Mapbox handles the rest. Only hide venues the user reported unavailable;
  // closed ones stay visible (grey) as history.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !map.getSource('venues')) return

    const collectedSet = new Set(collectionIds)
    const visible = venues.filter(v => {
      if (isKeepsake(v)) return false // keepsakes have no place — never on the map
      // Hide venues the user reported — but never one they've COLLECTED (e.g.
      // submitted with "this place has closed"): their own pin must not vanish.
      if (reportedIds.includes(v.id) && !collectedSet.has(v.id)) return false
      if (filter === 'open') return v.is_open && !isRetired(v)
      if (filter === 'multi') return (v.sources || []).length >= 2
      return true
    })
    venueByIdRef.current = new Map(visible.map(v => [v.id, v]))
    pointsRef.current = visible.map(v => [Number(v.lng), Number(v.lat)])
    map.getSource('venues').setData({
      type: 'FeatureCollection',
      features: visible.map(v => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(v.lng), Number(v.lat)] },
        properties: {
          vid: v.id,
          closed: isRetired(v) ? 1 : 0, // grey pin: no matchbooks to get, either way
          collected: collectedSet.has(v.id) ? 1 : 0, // found ones turn amber
        },
      })),
    })

    // Only frame the pins here if GPS FELL BACK (denied/unavailable) and venues
    // hadn't loaded yet when that happened. On a normal GPS start the map is
    // already centered on the user, so we leave it alone.
    if (geoFailedRef.current && !didFitRef.current && visible.length > 0) {
      fitToPins()
    }
  }, [venues, collectionIds, reportedIds, filter, mapReady])

  // Selection = a filter change on the highlight layer — no data churn at all.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !map.getLayer('pin-selected')) return
    map.setFilter('pin-selected', ['==', ['get', 'vid'], selectedVenue?.id ?? -999])
  }, [selectedVenue, mapReady])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

// ─── EXPLORE SCREEN ──────────────────────────────────────
function Explore({ venues, collectionIds, reported, onCollect, onFlag, onFakeReport, onSubmit, venuesError, onRetry, onSheetOpenChange, user, onRank, isAdmin, onSetCover }) {
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('all')
  const [reporting, setReporting] = useState(null) // venue being reported
  const [venuePhotos, setVenuePhotos] = useState([]) // anonymized gallery for the open venue
  const [collectErr, setCollectErr] = useState('')
  const [mapCenter, setMapCenter] = useState(NYC) // where the map is looking (drives "nearby")
  // Post-collect follow-up: right after "Got it", offer photos + ranking in place.
  const [postCollect, setPostCollect] = useState(false)
  const [pcPhotos, setPcPhotos] = useState([])
  const [pcBusy, setPcBusy] = useState(false)
  const [pcErr, setPcErr] = useState('')
  const pcFileRef = useRef(null)
  const reportedIds = useMemo(() => reported.map(r => r.venue_id), [reported])

  // Fresh venue, fresh follow-up state.
  useEffect(() => { setPostCollect(false); setPcPhotos([]); setPcErr(''); setPcBusy(false) }, [selected?.id])

  const addPostCollectPhotos = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length || !user || !selected) return
    setPcBusy(true)
    setPcErr('')
    try {
      const urls = []
      for (const f of files.slice(0, 6)) {
        const blob = await downscaleImage(f, 1600, 0.8)
        const path = `${user.id}/${crypto.randomUUID()}.jpg`
        const { error: upErr } = await supabase.storage.from('matchbooks').upload(path, blob, { contentType: 'image/jpeg', upsert: false })
        if (upErr) throw upErr
        urls.push(supabase.storage.from('matchbooks').getPublicUrl(path).data.publicUrl)
      }
      const merged = [...pcPhotos, ...urls]
      const { error } = await supabase.from('collections')
        .update({ photos: merged, photo_url: merged[0] })
        .eq('user_id', user.id).eq('venue_id', selected.id)
      if (error) throw error
      setPcPhotos(merged)
    } catch (err) {
      console.error('Post-collect photo upload failed', err)
      setPcErr('Couldn’t upload — try again.')
    }
    setPcBusy(false)
  }

  // Tell the shell a sheet is open so it can hide the tab bar (sheet covers it).
  useEffect(() => {
    onSheetOpenChange?.(!!reporting)
    return () => onSheetOpenChange?.(false)
  }, [reporting]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the venue's community photo gallery (anonymized RPC; no-ops gracefully
  // if migration 009 hasn't run yet).
  useEffect(() => {
    setCollectErr('')
    if (!selected) { setVenuePhotos([]); return }
    let cancelled = false
    supabase.rpc('venue_photos', { p_venue_id: selected.id }).then(({ data, error }) => {
      if (cancelled) return
      if (error) { setVenuePhotos([]); return }
      setVenuePhotos(Array.isArray(data) ? data.filter(Boolean) : [])
    })
    return () => { cancelled = true }
  }, [selected])

  // "Nearby" = closest to where the map is looking, not alphabetical — with
  // hundreds of venues, A-Z-first-8 showed the same list to everyone.
  const listed = venues
    .filter(v => {
      if (isKeepsake(v)) return false // no place — never "nearby"
      if (reportedIds.includes(v.id) && !collectionIds.includes(v.id)) return false
      if (isRetired(v)) return false // nothing to collect here anymore
      if (filter === 'open') return v.is_open
      if (filter === 'multi') return (v.sources || []).length >= 2
      return true
    })
    .map(v => ({ ...v, _d: (v.lat - mapCenter.lat) ** 2 + ((v.lng - mapCenter.lng) * 0.766) ** 2 }))
    .sort((a, b) => a._d - b._d)
    .slice(0, 20)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'max(10px, env(safe-area-inset-top)) 16px 6px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MbIcon size={26} />
          <span style={{ fontFamily: 'Georgia, serif', fontSize: 17, fontWeight: 300, color: C.text, letterSpacing: '-.3px' }}>phillumeni</span>
        </div>
        <button onClick={onSubmit} style={{ display: 'flex', alignItems: 'center', gap: 5, background: C.dark, color: '#fff', border: 'none', borderRadius: 99, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
          <i className="ti ti-plus" style={{ fontSize: 12 }} /> Submit
        </button>
      </div>

      {/* Map */}
      <div style={{ position: 'relative', height: 248, flexShrink: 0, margin: '8px 0 0' }}>
        <AppMap
          venues={venues}
          collectionIds={collectionIds}
          reportedIds={reportedIds}
          onSelectVenue={setSelected}
          selectedVenue={selected}
          filter={filter}
          onCenterChange={setMapCenter}
        />
      </div>

      {/* Sheet */}
      <div style={{ flex: 1, overflowY: 'auto', background: C.bg, borderTop: `0.5px solid ${C.border}` }}>
        <div style={{ width: 36, height: 4, background: C.border, borderRadius: 2, margin: '10px auto 0' }} />

        {selected ? (
          <div style={{ padding: '12px 16px 24px' }}>
            <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', fontSize: 13, color: C.amber, cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, padding: '0 0 10px' }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> All nearby
            </button>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
              {/* The venue's face is a real matchbook, not a flame — the cover
                  (auto-filled from the first submitted photo, admin-choosable). */}
              {selected.cover_photo_url
                ? <img src={selected.cover_photo_url} alt="" style={{ width: 52, height: 52, borderRadius: 13, objectFit: 'cover', flexShrink: 0 }} />
                : <div style={{ width: 52, height: 52, borderRadius: 13, background: selected.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, flexShrink: 0 }}>
                    {selected.emoji}
                  </div>}
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, letterSpacing: '-.3px', marginBottom: 2 }}>{selected.name}</div>
                <div style={{ fontSize: 12, color: C.muted }}>{selected.address}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
              {isRetired(selected) && <Tag label={retiredLabel(selected)} bg={C.redBg} color={C.red} />}
              {collectionIds.includes(selected.id) && <Tag label="✓ In your collection" bg={C.amberBg} color={C.amber} />}
              <Tag label={selected.type || 'Spot'} bg={C.surface} color={C.sec} />
            </div>

            {/* Community gallery — every matchbook submitted here, anonymized.
                Admins: tap a photo to make it the venue's cover. */}
            {venuePhotos.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.4px', textTransform: 'uppercase', marginBottom: 8 }}>
                  Matchbooks found here · {venuePhotos.length}{isAdmin ? ' · tap to set cover' : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                  {venuePhotos.map((url, i) => (
                    <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={url} alt="Matchbook" loading="lazy"
                        onClick={isAdmin ? async () => {
                          const ok = await onSetCover?.(selected.id, url)
                          if (ok !== false) setSelected(s => (s ? { ...s, cover_photo_url: url } : s))
                        } : undefined}
                        style={{ width: 104, height: 104, objectFit: 'cover', borderRadius: 12, border: url === selected.cover_photo_url ? `2px solid ${C.amber}` : `0.5px solid ${C.border}`, background: C.surface, cursor: isAdmin ? 'pointer' : 'default' }} />
                      {url === selected.cover_photo_url && (
                        <span style={{ position: 'absolute', top: 5, left: 5, background: C.amber, color: '#fff', fontSize: 9, fontWeight: 800, letterSpacing: '.4px', padding: '2px 7px', borderRadius: 99 }}>COVER</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {selected.note && <div style={{ fontSize: 12, color: C.muted, fontStyle: 'italic', marginBottom: 14, lineHeight: 1.5 }}>{selected.note}</div>}
            {isRetired(selected) ? (
              <div style={{ padding: 12, background: C.surface, borderRadius: 12, fontSize: 13, color: C.sec, textAlign: 'center', fontWeight: 500, lineHeight: 1.5 }}>
                {selected.status === 'discontinued'
                  ? "This spot is still open, but doesn't make matchbooks anymore — the ones out there are collector's items."
                  : "This spot has closed — its matchbooks are now collector's items."}
              </div>
            ) : collectionIds.includes(selected.id) ? (
              postCollect ? (
                // Fresh collect → offer the natural next steps in place, both optional.
                <>
                  <div style={{ padding: 12, background: C.amberBg, borderRadius: 12, fontSize: 13, color: C.amber, textAlign: 'center', fontWeight: 600, marginBottom: 10 }}>
                    <i className="ti ti-check" style={{ fontSize: 13, marginRight: 5 }} />Added to your collection
                  </div>
                  <input ref={pcFileRef} type="file" accept="image/*" multiple onChange={addPostCollectPhotos} style={{ display: 'none' }} />
                  <PrimaryBtn onClick={() => !pcBusy && pcFileRef.current?.click()} style={{ marginBottom: 8, background: pcBusy ? C.border : C.dark }}>
                    <i className="ti ti-camera" style={{ fontSize: 14, marginRight: 6 }} />
                    {pcBusy ? 'Uploading…' : pcPhotos.length ? `${pcPhotos.length} photo${pcPhotos.length > 1 ? 's' : ''} added — add more` : 'Add matchbook photos'}
                  </PrimaryBtn>
                  {pcErr && <div style={{ fontSize: 12, color: C.red, margin: '0 0 8px', lineHeight: 1.4 }}>{pcErr}</div>}
                  <PrimaryBtn onClick={() => onRank?.(selected, pcPhotos)} style={{ marginBottom: 8, background: C.amber }}>
                    <i className="ti ti-trophy" style={{ fontSize: 14, marginRight: 6 }} />Rank it now
                  </PrimaryBtn>
                  <OutlineBtn onClick={() => setPostCollect(false)}>Done — rank it later</OutlineBtn>
                </>
              ) : (
                <>
                  <div style={{ padding: 12, background: C.amberBg, borderRadius: 12, fontSize: 13, color: C.amber, textAlign: 'center', fontWeight: 600, marginBottom: 8 }}>
                    <i className="ti ti-check" style={{ fontSize: 13, marginRight: 5 }} />You've collected this one
                  </div>
                  <OutlineBtn onClick={() => setReporting(selected)} color={C.red}>
                    <i className="ti ti-flag" style={{ fontSize: 12, marginRight: 5 }} />Report a problem
                  </OutlineBtn>
                </>
              )
            ) : reportedIds.includes(selected.id) ? (
              <div style={{ padding: 12, background: C.redBg, borderRadius: 12, fontSize: 13, color: C.red, textAlign: 'center', fontWeight: 500 }}>Reported as unavailable</div>
            ) : (
              <>
                <PrimaryBtn onClick={async () => { const ok = await onCollect(selected); if (ok) setPostCollect(true); else setCollectErr('Couldn’t add it — check your connection and try again.') }} style={{ marginBottom: 8 }}>Got it — add to collection</PrimaryBtn>
                {collectErr && <div style={{ fontSize: 12, color: C.red, margin: '0 0 8px', lineHeight: 1.4 }}>{collectErr}</div>}
                <OutlineBtn onClick={() => setReporting(selected)} color={C.red}>
                  <i className="ti ti-flag" style={{ fontSize: 12, marginRight: 5 }} />Report a problem
                </OutlineBtn>
              </>
            )}
          </div>
        ) : venues.length === 0 && !venuesError ? (
          // Day-zero: a real, designed empty state — not a fallback (spec §1)
          <div style={{ textAlign: 'center', padding: '30px 26px 40px' }}>
            <i className="ti ti-map-pin" style={{ fontSize: 40, color: C.borderStr }} />
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: '-.4px', margin: '12px 0 8px' }}>Nothing here yet</div>
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.6, marginBottom: 22 }}>
              Every matchbook on this map was found by a real person. Be the first to add one.
            </div>
            <PrimaryBtn onClick={onSubmit}>Submit the first one</PrimaryBtn>
          </div>
        ) : (
          <div style={{ padding: '12px 16px 8px' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 10 }}>{listed.length} spots nearby</div>
            {listed.map(v => (
              <div key={v.id} onClick={() => setSelected(v)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer' }}>
                {v.cover_photo_url
                  ? <img src={v.cover_photo_url} alt="" loading="lazy" style={{ width: 38, height: 38, borderRadius: 11, objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 38, height: 38, borderRadius: 11, background: v.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>{v.emoji}</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{v.neighborhood || v.city}</div>
                </div>
                {collectionIds.includes(v.id)
                  ? <Tag label="✓ Yours" bg={C.amberBg} color={C.amber} />
                  : (v.type && <Tag label={v.type} bg={C.surface} color={C.sec} />)}
              </div>
            ))}
            {listed.length === 0 && (
              venuesError ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: C.muted, fontSize: 13 }}>
                  Couldn’t load spots.{' '}
                  <span onClick={onRetry} style={{ color: C.amber, fontWeight: 700, cursor: 'pointer' }}>Retry</span>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '2rem', color: C.muted, fontSize: 13 }}>
                  No spots nearby yet — submit one to get started. 🔥
                </div>
              )
            )}
          </div>
        )}
      </div>

      {reporting && (
        <ReportSheet
          venue={reporting}
          onClose={() => setReporting(null)}
          onNotAvailable={async (venueId, reason) => { const ok = await onFlag(venueId, reason); if (ok) setSelected(null); return ok }}
          onFake={onFakeReport}
        />
      )}
    </div>
  )
}

// How long ago, in the coarsest unit that's still true. "Last collected" is the
// live signal that a spot still has matchbooks, so precision past a day is noise.
function agoLabel(ts) {
  if (!ts) return null
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)
  if (days < 365) return months === 1 ? 'a month ago' : `${months} months ago`
  const years = Math.round(days / 365)
  return years === 1 ? 'a year ago' : `${years} years ago`
}

// One card for a venue, whether or not you own its matchbook. Opens from
// Collection tiles, every Rankings row (Mine + City/World/Friends), so a spot
// looks the same everywhere. `item` is your collection row (with `venue`
// attached) when you have it; for a spot you don't own, pass `venue` alone and
// the card drops to read-only — no photos, no rank, no remove.
function MatchbookDetail({ item, venue, title, backLabel, onBack, onReRank, onRemove, onAddPhotos }) {
  const v = item?.venue || venue
  const owned = !!item
  // Local copy so the page updates in place as photos upload; the collection
  // state itself is updated by onAddPhotos up in App.
  const [detailPhotos, setDetailPhotos] = useState(
    (item?.photos && item.photos.length) ? item.photos : (item?.photo_url ? [item.photo_url] : [])
  )
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoErr, setPhotoErr] = useState('')
  const fileRef = useRef(null)

  // Community freshness: when did ANYONE last log a matchbook here? collections
  // is owner-only under RLS, so this has to come from a definer RPC (021).
  // Meaningless for a retired spot (the closed-toggle submit path writes
  // collected_at = today, which would read as "still stocked"), so we don't ask.
  const [lastCollected, setLastCollected] = useState(null)
  const showFreshness = !isKeepsake(v) && !isRetired(v)
  useEffect(() => {
    if (!showFreshness || !v?.id) { setLastCollected(null); return }
    let cancelled = false
    supabase.rpc('venue_last_collected', { p_venue_id: v.id }).then(({ data, error }) => {
      if (!cancelled) setLastCollected(error ? null : data) // pre-021: no RPC, just omit the line
    })
    return () => { cancelled = true }
  }, [v?.id, showFreshness])

  const addPhotos = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length || !onAddPhotos) return
    setPhotoBusy(true)
    setPhotoErr('')
    try {
      const merged = await onAddPhotos(item, files)
      if (merged) setDetailPhotos(merged)
    } catch (err) {
      console.error('Add photos failed', err)
      setPhotoErr('Couldn’t upload — try again.')
    }
    setPhotoBusy(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SBar title={title} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '10px 16px 0' }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 13, color: C.amber, cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0 12px' }}>
            <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> {backLabel}
          </button>
        </div>
        {detailPhotos.length ? (
          <img src={detailPhotos[0]} alt="Your matchbook" style={{ width: '100%', height: 210, objectFit: 'cover', display: 'block' }} />
        ) : v.cover_photo_url ? (
          // No photos of YOUR copy — the venue's community cover beats a flame
          <img src={v.cover_photo_url} alt="" style={{ width: '100%', height: 210, objectFit: 'cover', display: 'block' }} />
        ) : (
          <div style={{ width: '100%', height: 210, background: v.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 72 }}>{v.emoji}</div>
        )}
        <div style={{ padding: '16px 16px 28px' }}>
          <div style={{ fontSize: 19, fontWeight: 700, color: C.text, letterSpacing: '-.3px', marginBottom: 4 }}>{v.name}</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>{v.address}</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
            {owned && <Tag label={`Collected ${new Date(item.collected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`} bg={C.greenBg} color={C.green} />}
            <Tag label={v.type || 'Spot'} bg={C.surface} color={C.sec} />
            {isRetired(v) && <Tag label={`${retiredLabel(v)} — collector's item`} bg={C.redBg} color={C.red} />}
          </div>
          {/* Does this spot still have them? The last time anyone logged one is
              the only honest answer we have. */}
          {showFreshness && lastCollected && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: C.surface, borderRadius: 12, padding: '10px 12px', marginBottom: 14 }}>
              <i className="ti ti-flame" style={{ fontSize: 14, color: C.amber }} />
              <span style={{ fontSize: 12.5, color: C.sec }}>
                Last collected <span style={{ fontWeight: 700, color: C.text }}>{agoLabel(lastCollected)}</span>
              </span>
            </div>
          )}
          {isRetired(v) && v.closed_at && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: C.surface, borderRadius: 12, padding: '10px 12px', marginBottom: 14 }}>
              <i className="ti ti-archive" style={{ fontSize: 14, color: C.muted }} />
              <span style={{ fontSize: 12.5, color: C.sec }}>
                {v.status === 'discontinued' ? 'Stopped making them' : 'Closed'} <span style={{ fontWeight: 700, color: C.text }}>{agoLabel(v.closed_at)}</span>
              </span>
            </div>
          )}
          {owned && onAddPhotos && <input ref={fileRef} type="file" accept="image/*" multiple onChange={addPhotos} style={{ display: 'none' }} />}
          {detailPhotos.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {detailPhotos.map((url, i) => (
                <img key={i} src={url} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: i === 0 ? `2px solid ${C.amber}` : `0.5px solid ${C.border}` }} />
              ))}
              {owned && onAddPhotos && (
                <button onClick={() => !photoBusy && fileRef.current?.click()}
                  style={{ width: 64, height: 64, borderRadius: 8, border: `1.5px dashed ${C.borderStr}`, background: 'none', color: C.muted, fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {photoBusy ? '…' : '+'}
                </button>
              )}
            </div>
          )}
          {owned && detailPhotos.length === 0 && (
            onAddPhotos ? (
              <button onClick={() => !photoBusy && fileRef.current?.click()}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.surface, border: `1.5px dashed ${C.borderStr}`, borderRadius: 12, padding: '12px', fontSize: 13, fontWeight: 600, color: C.sec, cursor: 'pointer', marginBottom: 14 }}>
                <i className="ti ti-camera" style={{ fontSize: 14 }} />
                {photoBusy ? 'Uploading…' : 'Add matchbook photos'}
              </button>
            ) : (
              <div style={{ background: C.surface, borderRadius: 12, padding: '10px 12px', fontSize: 12, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
                <i className="ti ti-camera" style={{ fontSize: 12, marginRight: 6 }} />No photos for this one yet
              </div>
            )
          )}
          {photoErr && <div style={{ fontSize: 12, color: C.red, margin: '-6px 0 12px', lineHeight: 1.4 }}>{photoErr}</div>}
          {/* A spot you don't own: read-only. Nothing here is yours to rank. */}
          {!owned && (
            <div style={{ background: C.surface, borderRadius: 12, padding: '11px 13px', fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
              <i className="ti ti-map-pin" style={{ fontSize: 12, marginRight: 6 }} />
              {isRetired(v)
                ? "Not in your collection — and this spot is retired, so the only way to get one now is a trade."
                : "Not in your collection yet. Find it on the map to collect it."}
            </div>
          )}
          {owned && onReRank && (
            <button
              onClick={() => onReRank({ ...item, photos: detailPhotos, photo_url: detailPhotos[0] || item.photo_url })}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.amber, color: '#fff', border: 'none', borderRadius: 12, padding: '13px', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}
            >
              <i className="ti ti-trophy" style={{ fontSize: 15 }} />
              {item.score == null ? 'Rank this spot' : 'Re-rank this spot'}
            </button>
          )}
          {owned && onRemove && <OutlineBtn onClick={() => onRemove(item.id)} color={C.red}>Remove from collection</OutlineBtn>}
        </div>
      </div>
    </div>
  )
}

// ─── COLLECTION SCREEN ───────────────────────────────────
function Collection({ items, venues, onRemove, onSubmit, onReRank, onAddPhotos, myListings = [], offerCounts = {}, onToggleTrade, onListingPhoto, onOpenOffers }) {
  const [view, setView] = useState('grid')
  const [detail, setDetail] = useState(null)
  const [tab, setTab] = useState('all') // all | trade

  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))
  const collected = items.map(item => ({ ...item, venue: venueMap[item.venue_id] })).filter(i => i.venue)
  const hoods = [...new Set(collected.map(i => i.venue.neighborhood).filter(Boolean))]
  const listedCount = (myListings || []).filter(l => l.status !== 'removed').length
  // Matchbooks per city, most first — replaces the single-city "NYC progress".
  const byCity = Object.entries(collected.reduce((m, i) => {
    const c = isKeepsake(i.venue) ? 'Keepsakes' : (i.venue.city || 'Unknown'); m[c] = (m[c] || 0) + 1; return m
  }, {})).sort((a, b) => b[1] - a[1])

  if (detail) {
    return (
      <MatchbookDetail
        item={detail}
        title="Collection"
        backLabel="Collection"
        onBack={() => setDetail(null)}
        onReRank={onReRank ? (it) => { setDetail(null); onReRank(it) } : null}
        onRemove={(id) => { onRemove(id); setDetail(null) }}
        onAddPhotos={onAddPhotos}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SBar title="Collection" />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '14px 16px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-.4px' }}>Your collection</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={onSubmit} style={{ display: 'flex', alignItems: 'center', gap: 5, background: C.dark, color: '#fff', border: 'none', borderRadius: 99, padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                <i className="ti ti-plus" style={{ fontSize: 12 }} /> Submit
              </button>
              {tab === 'all' && (
                <div style={{ display: 'flex', gap: 2, background: C.surface, borderRadius: 9, padding: 3, border: `0.5px solid ${C.border}` }}>
                  {['grid', 'list'].map(v => (
                    <button key={v} onClick={() => setView(v)} style={{ width: 30, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', cursor: 'pointer', background: view === v ? C.card : 'transparent', color: view === v ? C.text : C.muted }}>
                      <i className={`ti ti-${v === 'grid' ? 'layout-grid' : 'list'}`} style={{ fontSize: 13 }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', borderBottom: `0.5px solid ${C.border}`, marginBottom: 14 }}>
            {[{ k: 'all', l: 'All' }, { k: 'trade', l: 'For trade', n: listedCount }].map(t => (
              <div key={t.k} onClick={() => setTab(t.k)}
                style={{ padding: '7px 14px 8px', fontSize: 14, fontWeight: tab === t.k ? 700 : 500, color: tab === t.k ? C.text : C.muted, cursor: 'pointer', borderBottom: tab === t.k ? `2px solid ${C.text}` : '2px solid transparent', marginBottom: -1 }}>
                {t.l}{t.n > 0 ? ` · ${t.n}` : ''}
              </div>
            ))}
          </div>

          {tab === 'trade' && (
            <ForTrade
              collected={collected}
              myListings={myListings}
              offerCounts={offerCounts}
              onToggle={onToggleTrade}
              onPhoto={onListingPhoto}
              onOpenOffers={onOpenOffers}
            />
          )}
        </div>
        {tab === 'trade' ? null : (<>
        <div style={{ padding: '0 16px 10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
            {[{ n: collected.length, l: 'matchbooks' }, { n: new Set(collected.map(i => i.venue.city).filter(Boolean)).size, l: 'cities' }, { n: hoods.length, l: 'hoods' }, { n: collected.filter(i => i.score != null).length, l: 'ranked' }].map((s, i) => (
              <div key={i} style={{ background: C.surface, borderRadius: 12, padding: '9px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{s.n}</div>
                <div style={{ fontSize: 9, color: C.muted, marginTop: 1, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 600 }}>{s.l}</div>
              </div>
            ))}
          </div>

          {byCity.length > 0 && (
            <Card style={{ padding: '11px 14px', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>By city</div>
              {byCity.map(([city, n]) => (
                <div key={city} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                  <span style={{ fontSize: 13, color: C.sec }}>{city}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{n}</span>
                </div>
              ))}
            </Card>
          )}
        </div>

        {collected.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🔥</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>No matchbooks yet</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Find a venue on the map and tap "Got it"</div>
          </div>
        ) : view === 'grid' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, padding: 2 }}>
            {collected.map(item => (
              // Photos are real <img loading="lazy" decoding="async"> — NOT CSS
              // backgrounds, which load eagerly all-at-once and decode the full
              // 1600px upload on the main thread for every tile (the Collection-
              // page jank). Lazy imgs only fetch what's on screen.
              <div key={item.id} onClick={() => setDetail(item)} style={{ aspectRatio: '1', background: item.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
                {item.photo_url
                  ? <img src={item.photo_url} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
                  : item.venue.emoji}
                {isRetired(item.venue) && (
                  <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 8, fontWeight: 700, letterSpacing: .3, padding: '1px 5px', borderRadius: 99 }}>
                    {item.venue.status === 'discontinued' ? 'NO MATCHES' : 'CLOSED'}
                  </div>
                )}
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent,rgba(0,0,0,0.6))', padding: '14px 5px 5px' }}>
                  <div style={{ fontSize: 9, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: '0 16px' }}>
            {collected.map(item => (
              <div key={item.id} onClick={() => setDetail(item)} style={{ display: 'flex', gap: 11, alignItems: 'center', padding: '10px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer' }}>
                <div style={{ width: 52, height: 52, borderRadius: 10, background: item.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
                  {item.photo_url
                    ? <img src={item.photo_url} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
                    : item.venue.emoji}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {item.venue.neighborhood ? `${item.venue.neighborhood} · ${item.venue.city}` : item.venue.city}
                    {isRetired(item.venue) && <span style={{ color: C.red, fontWeight: 700 }}> · {retiredLabel(item.venue)}</span>}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>{new Date(item.collected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
              </div>
            ))}
          </div>
        )}
        </>)}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

// The For trade tab: one toggle per matchbook, with the three removal states
// from spec §4.2 — free exit, confirm-and-decline, and locked mid-trade.
function ForTrade({ collected, myListings, offerCounts, onToggle, onPhoto, onOpenOffers }) {
  const [confirm, setConfirm] = useState(null) // { item, listing, pending }
  const [busy, setBusy] = useState(null)
  const byVenue = useMemo(() => Object.fromEntries((myListings || []).map(l => [l.venue_id, l])), [myListings])
  const fileRef = useRef(null)
  const [photoFor, setPhotoFor] = useState(null)

  // Keepsakes aren't inventory — your wedding matchbook isn't up for swap.
  const tradeable = useMemo(() => collected.filter(i => i.venue && !isKeepsake(i.venue)), [collected])

  const toggle = async (item) => {
    const l = byVenue[item.venue_id]
    const pending = offerCounts[l?.id] || 0
    if (l?.status === 'in_trade') return                       // state C: locked
    if (l?.status === 'active' && pending > 0) { setConfirm({ item, listing: l, pending }); return } // state B
    setBusy(item.venue_id)
    await onToggle?.(item, !(l && l.status === 'active'))      // state A: free
    setBusy(null)
  }

  return (
    <>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginBottom: 12 }}>
        Toggle a matchbook to list it. Photo optional — it shows condition. No addresses, ever; that's sorted in private chat.
      </div>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && photoFor) { setBusy(photoFor.venue_id); await onPhoto?.(photoFor, f); setBusy(null); setPhotoFor(null) } }} />

      {tradeable.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: C.muted, fontSize: 13, lineHeight: 1.6 }}>
          Nothing to trade yet — collect a matchbook first.
        </div>
      )}

      {tradeable.map(item => {
        const l = byVenue[item.venue_id]
        const listed = l && l.status === 'active'
        const inTrade = l && l.status === 'in_trade'
        const pending = offerCounts[l?.id] || 0
        const on = listed || inTrade
        return (
          <div key={item.id} style={{ border: `1.5px solid ${on ? C.amberBd : C.border}`, borderRadius: 14, marginBottom: 10, overflow: 'hidden', background: C.card }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px' }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: item.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
                {(l?.photo_url || item.photo_url)
                  ? <img src={l?.photo_url || item.photo_url} alt="" loading="lazy" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                  : item.venue.emoji}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                <div style={{ fontSize: 11.5, color: C.muted }}>{item.venue.neighborhood || item.venue.city}</div>
              </div>
              {inTrade && <Tag label="In trade" bg={C.amberBg} color={C.amber} />}
              {listed && <Tag label="Trading" bg={C.amberBg} color={C.amber} />}
              <div onClick={() => !busy && toggle(item)} title={inTrade ? 'In an active trade — complete or cancel it first' : undefined}
                style={{ width: 46, height: 27, borderRadius: 99, flexShrink: 0, background: on ? C.amber : C.border, position: 'relative', cursor: inTrade ? 'not-allowed' : 'pointer', opacity: inTrade ? 0.5 : (busy === item.venue_id ? 0.6 : 1), transition: 'background .15s' }}>
                <div style={{ position: 'absolute', top: 3, left: on ? 22 : 3, width: 21, height: 21, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
              </div>
            </div>

            {inTrade && (
              <div style={{ background: C.surface, padding: '8px 13px', fontSize: 11.5, color: C.muted }}>
                In an active trade — complete or cancel it first.
              </div>
            )}
            {listed && (
              <div style={{ background: l?.photo_url ? C.amberBg : C.surface, padding: '9px 13px', display: 'flex', alignItems: 'center', gap: 9 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: l?.photo_url ? C.amber : C.text }}>
                    {l?.photo_url ? 'Photo added' : 'Add photo of your copy'}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted }}>{l?.photo_url ? 'Visible to traders' : 'Optional — shows condition'}</div>
                </div>
                <button onClick={() => { setPhotoFor(l); fileRef.current?.click() }}
                  style={{ flexShrink: 0, background: 'none', border: 'none', color: C.amber, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>
                  {l?.photo_url ? 'Change' : 'Add →'}
                </button>
              </div>
            )}
            {listed && pending > 0 && (
              <button onClick={() => onOpenOffers?.({ ...l, venue: item.venue })}
                style={{ width: '100%', padding: '11px', border: 'none', borderTop: `0.5px solid ${C.border}`, background: C.dark, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                View {pending} {pending === 1 ? 'offer' : 'offers'} →
              </button>
            )}
          </div>
        )
      })}

      {/* State B: pending offers die with the listing, so say so first */}
      {confirm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => setConfirm(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', maxWidth: 500, margin: '0 auto', width: '100%' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Remove listing?</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>
              {confirm.item.venue.name} has {confirm.pending} pending {confirm.pending === 1 ? 'offer' : 'offers'}. Removing it declines {confirm.pending === 1 ? 'that offer' : 'them all'}.
            </div>
            <button onClick={async () => { const c = confirm; setConfirm(null); setBusy(c.item.venue_id); await onToggle?.(c.item, false); setBusy(null) }}
              style={{ width: '100%', padding: 14, background: C.red, color: '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 8 }}>Remove listing</button>
            <button onClick={() => setConfirm(null)} style={{ width: '100%', padding: 13, background: 'none', border: `1.5px solid ${C.border}`, borderRadius: 13, color: C.text, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Keep listing</button>
          </div>
        </div>
      )}
    </>
  )
}

// ─── SUBMIT SCREEN ───────────────────────────────────────
function Submit({ onBack, onAdded, user, rankedItems = [], collectedMapboxIds = new Set(), onRankingDone, onSheetOpenChange, onFlag }) {
  const [step, setStep] = useState(1)
  const [photos, setPhotos] = useState([]) // { id, preview, url, path, status: 'uploading'|'done'|'error' }
  const photosRef = useRef(photos)
  photosRef.current = photos
  const [uploadErr, setUploadErr] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(null)
  const [placeClosed, setPlaceClosed] = useState(false) // "this place has closed" — collector's item
  const [reportedClosed, setReportedClosed] = useState(false) // added-closed against a still-active venue (report pending)
  const [retiredPrompt, setRetiredPrompt] = useState(null) // { venue } — retired spot: when did you get it?
  const [reposted, setReposted] = useState(false)          // a recent matchbook put it back on the map
  const [retiredAdding, setRetiredAdding] = useState(false)
  const [retiredErr, setRetiredErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [addErr, setAddErr] = useState('')
  const [addedVenue, setAddedVenue] = useState(null)
  const [needsRanking, setNeedsRanking] = useState(false)
  const [alreadyHave, setAlreadyHave] = useState(false) // venue was already in your collection
  // Manual entry ("can't find it") — spec §2
  const [showManual, setShowManual] = useState(false)
  const [manualCity, setManualCity] = useState('NYC')
  const [manualName, setManualName] = useState('')
  const [manualAddress, setManualAddress] = useState('')
  const [manualErr, setManualErr] = useState('')
  const [manualAdding, setManualAdding] = useState(false)
  // Keepsake entry — a matchbook that isn't from a place (wedding, event, one-off)
  const [showKeepsake, setShowKeepsake] = useState(false)
  const [keepsakeName, setKeepsakeName] = useState('')
  const [keepsakeErr, setKeepsakeErr] = useState('')
  const [keepsakeAdding, setKeepsakeAdding] = useState(false)
  const searchTimer = useRef(null)

  // The manual-entry / keepsake sheets cover the screen — hide the tab bar with them.
  useEffect(() => {
    onSheetOpenChange?.(showManual || showKeepsake)
    return () => onSheetOpenChange?.(false)
  }, [showManual, showKeepsake]) // eslint-disable-line react-hooks/exhaustive-deps
  const fileInputRef = useRef(null)
  const searchSeq = useRef(0)        // guards against out-of-order search responses
  const sessionRef = useRef('')      // Search Box billing session (suggest + retrieve)
  const getSession = () => (sessionRef.current ||= crypto.randomUUID())

  const handlePhotoSelect = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = '' // allow re-selecting the same file later
    if (!files.length || !user) return
    setUploadErr('')
    for (const file of files) {
      const id = crypto.randomUUID()
      setPhotos(prev => [...prev, { id, preview: URL.createObjectURL(file), url: null, path: null, status: 'uploading' }])
      try {
        const upload = await downscaleImage(file)
        const resized = upload !== file // downscale re-encoded it to JPEG
        const ext = resized ? 'jpg' : ((file.name.split('.').pop() || 'jpg').toLowerCase())
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('matchbooks')
          .upload(path, upload, { contentType: resized ? 'image/jpeg' : (file.type || 'image/jpeg'), upsert: false })
        if (upErr) throw upErr
        const { data } = supabase.storage.from('matchbooks').getPublicUrl(path)
        setPhotos(prev => prev.map(p => (p.id === id ? { ...p, url: data.publicUrl, path, status: 'done' } : p)))
      } catch (err) {
        console.error(err)
        setPhotos(prev => prev.map(p => (p.id === id ? { ...p, status: 'error' } : p)))
        setUploadErr('A photo failed to upload — remove it and try again.')
      }
    }
  }

  const removePhoto = (id) => {
    setPhotos(prev => {
      const gone = prev.find(p => p.id === id)
      if (gone?.path) supabase.storage.from('matchbooks').remove([gone.path]) // clean up the orphan
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return prev.filter(p => p.id !== id)
    })
  }

  const clearPhotos = () => {
    photos.forEach(p => p.preview && URL.revokeObjectURL(p.preview))
    setPhotos([])
    setUploadErr('')
  }

  const uploadingAny = photos.some(p => p.status === 'uploading')
  const photoUrls = photos.filter(p => p.status === 'done').map(p => p.url)

  // Revoke blob preview URLs on unmount (covers Cancel / Back to map / tab switch)
  useEffect(() => () => {
    photosRef.current.forEach(p => p.preview && URL.revokeObjectURL(p.preview))
  }, [])

  const searchVenues = async (q) => {
    const query = q.trim()
    if (query.length < 2) { setResults([]); setSearchErr(''); setSearching(false); return }
    const seq = ++searchSeq.current
    setSearching(true)
    setSearchErr('')
    try {
      // Mapbox Search Box API — the v5 geocoder's POI search is deprecated.
      // proximity=ip softly biases to wherever the searcher actually is (was
      // hard-locked to NYC, which buried far-flung spots like a Nantucket bar);
      // limit=10 is the max, so more results come back to scroll through.
      const res = await fetch(
        `https://api.mapbox.com/search/searchbox/v1/suggest?q=${encodeURIComponent(query)}` +
        `&proximity=ip&types=poi&limit=10` +
        `&session_token=${getSession()}&access_token=${MAPBOX_TOKEN}`
      )
      if (!res.ok) throw new Error(`Search unavailable (${res.status})`)
      const data = await res.json()
      if (seq !== searchSeq.current) return // a newer keystroke superseded this response
      const places = (data.suggestions || []).map(s => ({
        id: s.mapbox_id,
        mapbox_id: s.mapbox_id,
        name: s.name,
        address: s.full_address || s.place_formatted || s.name,
        type: titleCase(s.poi_category?.[0]) || 'Restaurant',
      }))
      setResults(places)
    } catch (e) {
      if (seq !== searchSeq.current) return
      setResults([])
      setSearchErr('Couldn’t reach search. Check your connection and try again.')
    } finally {
      if (seq === searchSeq.current) setSearching(false)
    }
  }

  const handleQueryChange = (q) => {
    setQuery(q)
    setPicked(null)
    setPlaceClosed(false) // a new search is a new place — don't carry the closed flag over
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => searchVenues(q), 400)
  }

  const handleAdd = async () => {
    if (!picked || !user) return
    setAdding(true)
    setAddErr('')
    try {
      // Dedup by mapbox_id — tolerate the column not existing yet (pre-migration 003)
      let venue = null
      let dedupOn = true
      const { data: existing, error: existErr } = await supabase
        .from('venues').select('*').eq('mapbox_id', picked.mapbox_id).maybeSingle()
      if (existErr) {
        if (isMissingColumn(existErr) || /mapbox_id/.test(existErr.message || '')) {
          dedupOn = false // column not migrated yet → fall back to a plain insert
        } else {
          throw existErr
        }
      } else {
        venue = existing
      }

      if (!venue) {
        // New venue — Search Box suggestions carry no coordinates, so retrieve them
        const res = await fetch(
          `https://api.mapbox.com/search/searchbox/v1/retrieve/${picked.mapbox_id}` +
          `?session_token=${getSession()}&access_token=${MAPBOX_TOKEN}`
        )
        if (!res.ok) throw new Error('Could not load that place — pick another.')
        const retrieved = await res.json()
        const feat = retrieved.features?.[0]
        const coords = feat?.geometry?.coordinates
        if (!coords || coords.length < 2) throw new Error('No location found for that place.')
        const [lng, lat] = coords
        const place = placeFromContext(feat?.properties)

        // Second dedup net: the seeded + manually-added venues have NO
        // mapbox_id, so the id check above sails right past all ~670 of them
        // and mints a duplicate (how Bar Snack nearly got a third row). Same
        // name + ~2km proximity rule the manual path uses.
        const { data: nearby } = await supabase
          .from('venues').select('*').ilike('name', picked.name)
          .gte('lat', lat - 0.02).lte('lat', lat + 0.02)
          .gte('lng', lng - 0.02).lte('lng', lng + 0.02)
          .limit(1)
        if (nearby && nearby.length) {
          venue = nearby[0]
        } else {

        const venueRow = {
          name: picked.name,
          address: picked.address.split(',').slice(0, 2).join(','),
          neighborhood: place.neighborhood || picked.address.split(',')[1]?.trim() || null,
          city: place.city || 'Unknown',
          lat,
          lng,
          type: picked.type,
          emoji: '🔥',
          bg_color: '#281808',
          sources: ['Submitted by ' + (user.email?.split('@')[0] || 'user')],
          created_by: user.id,
          verified: false,
        }
        if (dedupOn) venueRow.mapbox_id = picked.mapbox_id
        if (placeClosed) { venueRow.status = 'closed'; venueRow.closed_at = new Date().toISOString() }

        const { data: inserted, error: venueErr } = await supabase
          .from('venues').insert(venueRow).select().single()

        if (venueErr) {
          // Another user created it first (unique mapbox_id) — use theirs
          if (dedupOn && venueErr.code === '23505') {
            const { data: raced } = await supabase
              .from('venues').select('*').eq('mapbox_id', picked.mapbox_id).maybeSingle()
            if (!raced) throw venueErr
            venue = raced
          } else {
            throw venueErr
          }
        } else {
          venue = inserted
        }
        } // end: no nearby name-match — we really did create it
      }

      await collectVenue(venue, placeClosed)
    } catch (e) {
      // A retired spot isn't a dead end — ask when they got the matchbook, and
      // a recent one puts the spot back on the map (handleRetiredAnswer).
      if (e.code === 'RETIRED') { setRetiredPrompt({ venue: e.venue }); setAdding(false); return }
      console.error(e)
      setAddErr(e.message || 'Something went wrong. Try again.')
    }
    setAdding(false)
  }

  // Collect a resolved venue into the user's collection, then trigger ranking.
  // Shared by the search path (handleAdd) and manual entry (handleAddManual).
  // closedByUser = the "This place has closed" toggle: it unlocks collecting an
  // already-retired venue (the matchbook is a collector's item — you HAVE it,
  // you're not going there) and files a closed-report on a still-active one.
  // retiredOk = the caller already asked WHEN they got it (the repost prompt).
  // Otherwise a retired venue raises a RETIRED signal rather than a dead-end
  // error, so Submit can ask instead of just refusing. Kept here (not in the
  // callers) because a create-race can still resolve to a retired row.
  const collectVenue = async (venue, closedByUser = false, retiredOk = false) => {
    if (isRetired(venue) && !closedByUser && !retiredOk) {
      throw Object.assign(new Error('RETIRED'), { code: 'RETIRED', venue })
    }

    // Add to collection — capture the real row (serial id) and surface errors.
    // First-ever ranked venue gets score 7.5 automatically (spec §3).
    // photos[] (006) and score (007) may not be migrated yet — on a missing-column
    // error strip the offending key and retry, the same column-tolerance contract
    // handleAdd uses for mapbox_id.
    const isFirstRanked = rankedItems.length === 0
    const cover = photoUrls[0] || null
    const insertRow = { user_id: user.id, venue_id: venue.id, photo_url: cover, photos: photoUrls, score: isFirstRanked ? 7.5 : null }
    let collectionRow = null, collErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      ;({ data: collectionRow, error: collErr } = await supabase
        .from('collections').insert(insertRow).select().single())
      if (!collErr || !isMissingColumn(collErr)) break
      const m = collErr.message || ''
      if (/photos/.test(m) && 'photos' in insertRow) delete insertRow.photos
      else if (/score/.test(m) && 'score' in insertRow) delete insertRow.score
      else if ('photos' in insertRow) delete insertRow.photos       // unnamed miss → drop newest cols
      else if ('score' in insertRow) delete insertRow.score
      else break
    }

    let savedRow = collectionRow
    let alreadyHave = false
    if (collErr) {
      if (collErr.code === '23505') alreadyHave = true // you already collected this venue
      // unique(user_id, venue_id): already collected. Treat as success, but merge
      // any newly-uploaded photos into the existing row.
      if (collErr.code === '23505') {
        if (photoUrls.length) {
          const { data: existingC, error: selErr } = await supabase
            .from('collections').select('photos, photo_url')
            .eq('user_id', user.id).eq('venue_id', venue.id).single()
          if (!selErr) {
            // seed photos[] from the existing cover so photos[0] === photo_url holds
            const existingPhotos = (existingC && existingC.photos && existingC.photos.length)
              ? existingC.photos
              : ((existingC && existingC.photo_url) ? [existingC.photo_url] : [])
            const merged = [...existingPhotos, ...photoUrls]
            const { data: updated, error: updErr } = await supabase
              .from('collections')
              .update({ photos: merged, photo_url: merged[0] })
              .eq('user_id', user.id).eq('venue_id', venue.id).select().single()
            if (updErr) throw updErr // surface via the catch, don't fake success
            savedRow = updated || null
          } else {
            // photos column not migrated — keep any existing cover, only set if missing
            const { data: legacy } = await supabase
              .from('collections').select('photo_url')
              .eq('user_id', user.id).eq('venue_id', venue.id).single()
            const { data: updated } = await supabase
              .from('collections').update({ photo_url: (legacy && legacy.photo_url) || cover })
              .eq('user_id', user.id).eq('venue_id', venue.id).select().single()
            savedRow = updated || null
          }
        } else {
          // No new photos — still read the row back so an already-collected
          // but UNRANKED venue (score null) can be offered the ranking flow.
          const { data: existingRow } = await supabase
            .from('collections').select('*')
            .eq('user_id', user.id).eq('venue_id', venue.id).maybeSingle()
          savedRow = existingRow || null
        }
      } else {
        throw collErr
      }
    }

    // The user says a still-active spot has closed → file a closed_down report,
    // which counts toward the community auto-close (2 distinct reporters).
    // Routed through onFlag, NOT a hand-rolled insert: a bare reason-less row is
    // INERT under 021 (the trigger filters on reason), so this promise — and the
    // step-3 copy that repeats it — would have counted toward precisely nothing.
    // Best-effort: their matchbook is already saved either way.
    const reportPending = closedByUser && !isRetired(venue)
    if (reportPending) onFlag?.(venue.id, 'closed_down')

    setAddedVenue(venue)
    setAlreadyHave(alreadyHave)
    setReportedClosed(reportPending)
    setReposted(false) // handleRetiredAnswer flips this back on if the repost lands
    // Offer ranking when the venue isn't the user's first ranked one and its
    // collection row currently has no score (newly added, or never ranked).
    setNeedsRanking(!isFirstRanked && !!savedRow && savedRow.score == null)
    onAdded(venue, savedRow || null)
    sessionRef.current = '' // start a fresh billing session for the next submit
    setStep(3)
  }

  // Manual entry (spec §2): geocode the typed address → insert a venue with
  // added_manually = true → collect it like any other. Falls back to the city
  // center if geocoding fails, so the venue always has coordinates for its pin.
  const handleAddManual = async () => {
    if (!user) return
    const name = manualName.trim()
    const address = manualAddress.trim()
    if (!name) { setManualErr('Add the venue name.'); return }
    if (!address) { setManualErr('Add the address.'); return }
    setManualAdding(true)
    setManualErr('')
    try {
      // Geocode the FULL typed address anywhere (the old flow was locked to NYC,
      // so you couldn't add a Nantucket spot at all). proximity=ip softly biases
      // to the searcher; require a real hit so a venue is never created with a
      // guessed/wrong location.
      const res = await fetch(
        `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(address)}` +
        `&proximity=ip&limit=1&access_token=${MAPBOX_TOKEN}`
      )
      const data = res.ok ? await res.json() : null
      const feat = data?.features?.[0]
      const coords = feat?.geometry?.coordinates
      if (!coords || coords.length < 2) {
        setManualAdding(false)
        setManualErr('Couldn’t find that address — include the street, town, and state (e.g. “326 Madaket Rd, Nantucket, MA”).')
        return
      }
      const [lng, lat] = coords
      const place = placeFromContext(feat?.properties)

      const venueRow = {
        name,
        address,
        neighborhood: place.neighborhood || null,
        city: place.city || 'Unknown',
        lat,
        lng,
        type: 'Spot',
        emoji: '🔥',
        bg_color: '#281808',
        sources: ['Submitted by ' + (user.email?.split('@')[0] || 'user')],
        created_by: user.id,
        verified: false,
        added_manually: true,
      }
      // Dedup: don't create a second venue for a place already on the map. Match
      // by name (case-insensitive) + proximity (~2km), so the same name in a
      // different city doesn't falsely merge but a genuine re-add does.
      let venue = null
      let inserted = false
      const { data: dupes } = await supabase
        .from('venues').select('*').ilike('name', name)
        .gte('lat', lat - 0.02).lte('lat', lat + 0.02)
        .gte('lng', lng - 0.02).lte('lng', lng + 0.02)
        .limit(1)
      if (dupes && dupes.length) venue = dupes[0]

      if (!venue) {
        if (placeClosed) { venueRow.status = 'closed'; venueRow.closed_at = new Date().toISOString() }
        // added_manually (007) may not be migrated — strip on a missing-column error.
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data, error } = await supabase.from('venues').insert(venueRow).select().single()
          if (!error) { venue = data; inserted = true; break }
          if (isMissingColumn(error) && 'added_manually' in venueRow) {
            delete venueRow.added_manually
            continue
          }
          throw error
        }
      }

      setPicked({ name, address, manual: true })
      try {
        await collectVenue(venue, placeClosed)
      } catch (collectErr) {
        // Only roll back a venue WE just created (an existing/deduped one stays).
        if (inserted) await supabase.from('venues').delete().eq('id', venue.id)
        throw collectErr
      }
      setShowManual(false)
    } catch (e) {
      if (e.code === 'RETIRED') { setShowManual(false); setRetiredPrompt({ venue: e.venue }); setManualAdding(false); return }
      console.error(e)
      // A failed manual add must not leave `picked` set to a mapbox_id-less
      // object — that would arm a dead-end "Add" button back on step 2.
      setPicked(null)
      setManualErr(e.message || 'Couldn’t add it. Try again.')
    }
    setManualAdding(false)
  }

  // Keepsake: a matchbook that isn't from a place (wedding, event, one-off).
  // Modeled as a venue row with kind='keepsake' and no real location, so the
  // whole collect/rank pipeline works unchanged — but it NEVER appears on the
  // map, in the nearby list, or on shared leaderboards. Each keepsake is its
  // own row (deliberately no dedup — your wedding isn't anyone else's).
  const handleAddKeepsake = async () => {
    if (!user) return
    const name = keepsakeName.trim()
    if (!name) { setKeepsakeErr('Give it a name — e.g. “Sarah & Tom’s wedding”.'); return }
    setKeepsakeAdding(true)
    setKeepsakeErr('')
    try {
      const venueRow = {
        name,
        address: '',
        neighborhood: null,
        city: '', // venues.city is NOT NULL — empty string reads as "no city" everywhere
        lat: 0,
        lng: 0, // (0,0) + kind guard both exclude it from every location surface
        type: 'Keepsake',
        emoji: '✨',
        bg_color: '#2E2440',
        sources: ['Keepsake'],
        created_by: user.id,
        verified: false,
        added_manually: true,
        kind: 'keepsake',
      }
      let venue = null, inserted = false
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data, error } = await supabase.from('venues').insert(venueRow).select().single()
        if (!error) { venue = data; inserted = true; break }
        // pre-migration DBs: strip columns they don't have yet (the (0,0) guard
        // still keeps the row off the map/list until migration 020 runs)
        if (isMissingColumn(error) && 'kind' in venueRow) { delete venueRow.kind; continue }
        if (isMissingColumn(error) && 'added_manually' in venueRow) { delete venueRow.added_manually; continue }
        throw error
      }
      setPicked({ name, address: 'Keepsake', manual: true, keepsake: true })
      try {
        await collectVenue(venue)
      } catch (collectErr) {
        if (inserted) await supabase.from('venues').delete().eq('id', venue.id)
        throw collectErr
      }
      setShowKeepsake(false)
    } catch (e) {
      console.error(e)
      setPicked(null) // same guard as manual — don't arm a dead-end step-2 Add
      setKeepsakeErr(e.message || 'Couldn’t add it. Try again.')
    }
    setKeepsakeAdding(false)
  }

  // The spot is retired but you have its matchbook — so when did you get it?
  // A recent one is live proof the place has them again, and reposts it. An old
  // one proves nothing about today, so it stays retired and stays a keepsake of
  // a dead spot. 'year' is the ambiguous middle: collect, don't repost, let the
  // reports stand for review.
  const handleRetiredAnswer = async (recency) => {
    const venue = retiredPrompt?.venue
    if (!venue) return
    setRetiredAdding(true)
    setRetiredErr('')
    try {
      // Collect FIRST: repost_venue only accepts a caller who has the matchbook.
      await collectVenue(venue, false, true)
      if (recency === 'month') {
        const { error } = await supabase.rpc('repost_venue', { p_venue_id: venue.id })
        if (error) {
          // The matchbook is already saved — a failed repost is not worth losing
          // it over. It just stays retired until someone else confirms.
          console.error('Repost failed', error)
        } else {
          const back = { ...venue, status: 'active', closed_at: null }
          setAddedVenue(back)
          setReposted(true)
          onAdded(back, null) // push the un-retired venue back into the map
        }
      }
      setRetiredPrompt(null)
    } catch (e) {
      console.error(e)
      setRetiredErr(e.message || 'Couldn’t add it. Try again.')
    }
    setRetiredAdding(false)
  }

  // "Skip for now" from the step-3 confirmation: the spot stays UNRANKED
  // (score null) — no invented median position. It waits in Rankings → Mine's
  // "Unranked" section with a Rank button, so it's never stranded.
  const skipRanking = () => {
    ;(onRankingDone || onBack)()
  }

  const Steps = () => (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
      {[1, 2, 3].map(s => (
        <div key={s} style={{ height: 4, borderRadius: 2, width: s === step ? 28 : 12, background: s === step ? C.dark : s < step ? C.amber : C.border, transition: 'all .2s' }} />
      ))}
    </div>
  )

  // "This place has closed" — shown once a venue is picked, and in the manual
  // sheet (closed spots often vanish from search, so manual is their main path).
  const closedToggle = (
    <div onClick={() => setPlaceClosed(v => !v)}
      style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', border: `1.5px solid ${placeClosed ? C.amberBd : C.border}`, background: placeClosed ? C.amberBg : C.card, borderRadius: 13, cursor: 'pointer', marginBottom: 12, transition: 'all .15s' }}>
      <div style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${placeClosed ? C.amber : C.borderStr}`, background: placeClosed ? C.amber : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {placeClosed && <i className="ti ti-check" style={{ fontSize: 13, color: '#fff' }} />}
      </div>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: placeClosed ? C.amber : C.text }}>This place has closed</div>
        <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>Your matchbook becomes a collector's item, and we'll flag the spot as closed on the map.</div>
      </div>
    </div>
  )

  // Step 4 is the comparison flow — render it as a full-screen replacement so
  // Submit's own status bar / Back button / progress dots don't double up.
  if (step === 4 && addedVenue) {
    return (
      <ComparisonFlow
        newVenue={addedVenue}
        newPhoto={photoUrls[0] || null}
        rankedItems={rankedItems}
        user={user}
        onDone={() => (onRankingDone || onBack)()}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: C.bg, position: 'relative' }}>
      <SBar />
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 16px 0', flexShrink: 0, gap: 10 }}>
        <button onClick={step === 1 ? onBack : () => setStep(s => s - 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: C.amber, fontSize: 13, fontWeight: 700 }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />{step === 1 ? 'Cancel' : 'Back'}
        </button>
        <div style={{ flex: 1 }}><Steps /></div>
        <div style={{ width: 52 }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px 28px' }}>
        {step === 1 && (
          <>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-.4px', marginBottom: 4 }}>Found a matchbook?</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.5 }}>Add photos of the matchbook for your collection. Optional — you can skip it.</div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handlePhotoSelect}
              style={{ display: 'none' }}
            />

            {photos.length === 0 ? (
              <div onClick={() => fileInputRef.current?.click()} style={{ border: `2px dashed ${C.border}`, borderRadius: 18, height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', background: C.surface }}>
                <div style={{ width: 60, height: 60, background: C.dark, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <i className="ti ti-camera" style={{ fontSize: 26, color: '#fff' }} />
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Take photos</div>
                <div style={{ fontSize: 12, color: C.muted }}>or upload from your library</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {photos.map(p => (
                  <div key={p.id} style={{ position: 'relative', aspectRatio: '1', borderRadius: 12, overflow: 'hidden', background: '#2A2824' }}>
                    <img src={p.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: p.status === 'done' ? 1 : 0.5 }} />
                    {p.status === 'uploading' && (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid #fff', animation: 'spin 1s linear infinite' }} />
                      </div>
                    )}
                    {p.status === 'error' && (
                      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(212,60,60,0.35)', color: '#fff' }}>
                        <i className="ti ti-alert-triangle" style={{ fontSize: 18 }} />
                      </div>
                    )}
                    <button onClick={() => removePhoto(p.id)} style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff', fontSize: 14, lineHeight: '20px', cursor: 'pointer', padding: 0 }}>×</button>
                  </div>
                ))}
                <div onClick={() => fileInputRef.current?.click()} style={{ aspectRatio: '1', borderRadius: 12, border: `2px dashed ${C.borderStr}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: C.surface }}>
                  <i className="ti ti-plus" style={{ fontSize: 22, color: C.muted }} />
                </div>
              </div>
            )}

            {uploadErr && (
              <div style={{ fontSize: 12, color: C.red, marginTop: 10, lineHeight: 1.4 }}>{uploadErr}</div>
            )}

            <PrimaryBtn onClick={() => setStep(2)} disabled={uploadingAny} style={{ marginTop: 16 }}>
              {uploadingAny ? 'Uploading…' : photoUrls.length ? 'Next — find the venue' : 'Skip & find the venue'}
            </PrimaryBtn>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </>
        )}

        {step === 2 && (
          <>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-.4px', marginBottom: 4 }}>Which venue is this?</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>Search by name. Address fills in automatically.</div>

            <div style={{ position: 'relative', marginBottom: 12 }}>
              <i className="ti ti-search" style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: C.muted }} />
              <input
                value={query}
                onChange={e => handleQueryChange(e.target.value)}
                placeholder="Search venue name…"
                autoFocus
                style={{ width: '100%', padding: '13px 13px 13px 40px', border: `1.5px solid ${query ? C.dark : C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 14, fontWeight: 500, outline: 'none' }}
              />
              {searching && <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, borderRadius: '50%', border: `2px solid ${C.border}`, borderTop: `2px solid ${C.dark}`, animation: 'spin 1s linear infinite' }} />}
            </div>

            {searchErr && (
              <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{searchErr}</div>
            )}

            {results.length > 0 && (
              <Card style={{ padding: 0, maxHeight: '46vh', overflowY: 'auto', marginBottom: 16 }}>
                {results.map((r, i) => {
                  // A place already in your collection can't be added again — flag it
                  // and make the row non-selectable so you can't re-submit it.
                  const mine = collectedMapboxIds.has(r.mapbox_id)
                  return (
                    <div key={r.id} onClick={mine ? undefined : () => { setPicked(r); setQuery(r.name); setAddErr(''); setPlaceClosed(false) }}
                      style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', borderBottom: i < results.length - 1 ? `0.5px solid ${C.border}` : 'none', cursor: mine ? 'default' : 'pointer', background: picked?.id === r.id ? C.greenBg : 'transparent', opacity: mine ? 0.6 : 1, transition: 'background .1s' }}>
                      <div style={{ width: 38, height: 38, borderRadius: 10, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <i className="ti ti-map-pin" style={{ fontSize: 17, color: picked?.id === r.id ? C.green : C.muted }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{r.name}</div>
                        <div style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.address}</div>
                      </div>
                      {mine
                        ? <span style={{ fontSize: 10.5, fontWeight: 800, color: C.amber, letterSpacing: '.3px', flexShrink: 0, whiteSpace: 'nowrap' }}>✓ IN COLLECTION</span>
                        : picked?.id === r.id && <i className="ti ti-check" style={{ fontSize: 16, color: C.green, flexShrink: 0 }} />}
                    </div>
                  )
                })}
              </Card>
            )}

            {query.trim().length >= 2 && !searching && results.length === 0 && !searchErr && !picked && (
              <div style={{ textAlign: 'center', fontSize: 13, color: C.muted, margin: '2px 0 12px' }}>No matches found</div>
            )}

            {/* Manual-entry escape hatch (spec §2) — closed/missing venues */}
            <button onClick={() => { setManualName(query.trim()); setManualAddress(''); setManualErr(''); setPlaceClosed(false); setShowManual(true) }}
              style={{ width: '100%', padding: 13, border: `1.5px dashed ${C.borderStr}`, borderRadius: 13, background: 'transparent', color: C.text, fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>
              Can't find it? Add it by address
            </button>
            <button onClick={() => { setKeepsakeName(query.trim()); setKeepsakeErr(''); setShowKeepsake(true) }}
              style={{ width: '100%', padding: 13, border: `1.5px dashed ${C.borderStr}`, borderRadius: 13, background: 'transparent', color: C.text, fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 16 }}>
              ✨ Not from a place? Add a keepsake
            </button>

            {picked && closedToggle}
            {addErr && (
              <div style={{ fontSize: 12, color: C.red, marginBottom: 10, lineHeight: 1.4 }}>{addErr}</div>
            )}
            <PrimaryBtn onClick={handleAdd} disabled={!picked || adding}>
              {adding ? 'Adding to map…' : picked ? `Add ${picked.name}` : 'Select a venue first'}
            </PrimaryBtn>
          </>
        )}

        {step === 3 && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>{reposted ? '🔥' : reportedClosed ? '📍' : alreadyHave ? '✓' : '🔥'}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: '-.4px', marginBottom: 8 }}>{reposted ? "It's back on the map." : reportedClosed ? "Thanks — we've noted it." : alreadyHave ? 'You already have this one.' : picked?.keepsake ? "It's in your collection." : isRetired(addedVenue) ? "A collector's item." : "It's on the map."}</div>
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.7, marginBottom: 24 }}>
              {reposted
                ? <>You got one recently, so <span style={{ fontWeight: 700, color: C.text }}>{picked?.name}</span> is live again for everyone. Nice find.</>
                : reportedClosed
                ? <>Your matchbook from <span style={{ fontWeight: 700, color: C.text }}>{picked?.name}</span> is saved. It's still on the map for now — it'll show as closed once a few collectors confirm it's gone.</>
                : alreadyHave
                ? <><span style={{ fontWeight: 700, color: C.text }}>{picked?.name}</span> is already in your collection — no need to add it twice.</>
                : picked?.keepsake
                ? <><span style={{ fontWeight: 700, color: C.text }}>{picked?.name}</span> is saved as a keepsake — yours to rank, never on the map.</>
                : isRetired(addedVenue)
                ? <><span style={{ fontWeight: 700, color: C.text }}>{picked?.name}</span> {addedVenue?.status === 'discontinued' ? "doesn't make them anymore" : 'may be gone'}, but its matchbook lives on in your collection.</>
                : <><span style={{ fontWeight: 700, color: C.text }}>{picked?.name}</span> is live and in your collection. Everyone nearby can find it.</>}
            </div>
            {needsRanking ? (
              <>
                {addErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, lineHeight: 1.4 }}>{addErr}</div>}
                <PrimaryBtn onClick={() => setStep(4)} style={{ marginBottom: 10 }}>Rank this matchbook →</PrimaryBtn>
                <OutlineBtn onClick={skipRanking}>Skip for now</OutlineBtn>
              </>
            ) : (
              <>
                <PrimaryBtn onClick={onBack} style={{ marginBottom: 10 }}>Back to map</PrimaryBtn>
                <OutlineBtn onClick={() => { setStep(1); clearPhotos(); setQuery(''); setResults([]); setPicked(null); setPlaceClosed(false); setReportedClosed(false); setReposted(false); setRetiredPrompt(null); setSearchErr(''); setAddErr('') }}>Submit another</OutlineBtn>
              </>
            )}
          </div>
        )}
      </div>

      {/* Manual-entry bottom sheet (spec §2) */}
      {showManual && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => !manualAdding && (setShowManual(false), setPlaceClosed(false))} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', maxHeight: '88%', overflowY: 'auto', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Add it manually</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>For a spot our search can't find. Type its full address and we'll place it on the map from that.</div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', marginBottom: 7 }}>VENUE NAME</div>
            <input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="e.g. Millie's"
              style={{ width: '100%', padding: '13px 14px', border: `1.5px solid ${C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 15, fontWeight: 500, outline: 'none', marginBottom: 16 }} />

            <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', marginBottom: 7 }}>FULL ADDRESS</div>
            <input value={manualAddress} onChange={e => setManualAddress(e.target.value)} placeholder="Street, town, state" autoCapitalize="words"
              style={{ width: '100%', padding: '13px 14px', border: `1.5px solid ${C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 15, fontWeight: 500, outline: 'none', marginBottom: 6 }} />
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 18, lineHeight: 1.5 }}>Include the town + state so it lands right — e.g. “326 Madaket Rd, Nantucket, MA”.</div>

            {closedToggle}
            {manualErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{manualErr}</div>}
            <PrimaryBtn onClick={handleAddManual} disabled={manualAdding}>{manualAdding ? 'Adding…' : 'Continue'}</PrimaryBtn>
          </div>
        </div>
      )}

      {/* Retired spot: you have the matchbook, so when did you get it? A recent
          one reposts the spot; an old one is just a collector's item. */}
      {retiredPrompt && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => { if (!retiredAdding) { setRetiredPrompt(null); if (picked?.manual) setPicked(null) } }} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', maxHeight: '88%', overflowY: 'auto', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>When did you get this one?</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>
              <span style={{ fontWeight: 700, color: C.text }}>{retiredPrompt.venue?.name}</span> is marked{' '}
              {retiredPrompt.venue?.status === 'discontinued' ? 'as no longer making matchbooks' : 'closed'}. If you picked this up recently, that's proof it's back — and it goes straight back on the map.
            </div>
            {[
              { key: 'month', title: 'In the last month', sub: 'Puts the spot back on the map for everyone', accent: true },
              { key: 'year', title: 'In the last year', sub: 'Saved to your collection — too old to prove it\'s back' },
              { key: 'older', title: 'Longer ago than that', sub: 'A collector\'s item — the spot stays retired' },
            ].map(o => (
              <button key={o.key} onClick={() => handleRetiredAnswer(o.key)} disabled={retiredAdding}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '14px', border: `1.5px solid ${o.accent ? C.amberBd : C.border}`, borderRadius: 14, background: o.accent ? C.amberBg : C.card, cursor: retiredAdding ? 'default' : 'pointer', marginBottom: 10, textAlign: 'left', opacity: retiredAdding ? 0.6 : 1 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: o.accent ? C.card : C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <i className={`ti ${o.accent ? 'ti-flame' : 'ti-clock'}`} style={{ fontSize: 20, color: o.accent ? C.amber : C.sec }} />
                </div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: o.accent ? C.amber : C.text }}>{o.title}</div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>{o.sub}</div>
                </div>
              </button>
            ))}
            {retiredErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, lineHeight: 1.4 }}>{retiredErr}</div>}
            {/* Cancelling from the MANUAL path would strand a mapbox_id-less
                `picked` on step 2 and arm a dead-end Add button — same guard the
                manual catch applies, which the RETIRED early-return jumps over. */}
            <button onClick={() => { setRetiredPrompt(null); if (picked?.manual) setPicked(null) }} disabled={retiredAdding} style={{ width: '100%', padding: 13, marginTop: 4, background: 'none', border: 'none', color: C.muted, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Keepsake bottom sheet — matchbooks that aren't from a place */}
      {showKeepsake && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => !keepsakeAdding && setShowKeepsake(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', maxHeight: '88%', overflowY: 'auto', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>✨ Add a keepsake</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>
              For matchbooks that aren't from a place — a wedding, a party, a one-off. It joins your collection and rankings, but never appears on the map or leaderboards.
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', marginBottom: 7 }}>WHAT'S IT FROM?</div>
            <input value={keepsakeName} onChange={e => setKeepsakeName(e.target.value)} placeholder="e.g. Sarah & Tom's wedding" autoCapitalize="words" maxLength={80}
              style={{ width: '100%', padding: '13px 14px', border: `1.5px solid ${C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 15, fontWeight: 500, outline: 'none', marginBottom: 18 }} />

            {keepsakeErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{keepsakeErr}</div>}
            <PrimaryBtn onClick={handleAddKeepsake} disabled={keepsakeAdding}>{keepsakeAdding ? 'Adding…' : 'Add to my collection'}</PrimaryBtn>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── REPORT SHEET (spec §4/§5) ───────────────────────────
// Bottom sheet: "Not available here" (reports) + "This isn't a real matchbook"
// (fake_reports). Reusable from the Explore detail and the Rankings row menu.
// Why a spot is unavailable. The reason DECIDES the outcome (migration 021):
// only "the place shut down" can close a venue, only "stopped making them" can
// retire its matchbooks. The other two are advisory and reverse themselves the
// moment someone collects there again.
const REPORT_REASONS = [
  { key: 'out_temporarily', icon: 'ti-clock-pause', title: 'They’re out right now', sub: 'Staff said they plan to restock' },
  { key: 'discontinued', icon: 'ti-flame-off', title: 'They don’t make them anymore', sub: 'The place is still open — the matchbooks are done' },
  { key: 'closed_down', icon: 'ti-building-store', title: 'The place has closed down', sub: 'Out of business for good' },
  { key: 'unknown', icon: 'ti-help-circle', title: 'Not sure', sub: 'Just weren’t any — no reason given' },
]

function ReportSheet({ venue, onClose, onNotAvailable, onFake }) {
  const [mode, setMode] = useState('menu') // menu | why | fake
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!venue) return null

  // Handlers return false on a failed write — keep the sheet open + show the
  // error instead of closing as if the report landed.
  const runNotAvailable = async (reasonKey) => {
    setBusy(true)
    setErr('')
    const ok = await onNotAvailable(venue.id, reasonKey)
    setBusy(false)
    if (ok === false) { setErr('Couldn’t send that — check your connection and try again.'); return }
    onClose()
  }
  const runFake = async () => {
    setBusy(true)
    setErr('')
    const ok = await onFake(venue.id, reason.trim())
    setBusy(false)
    if (ok === false) { setErr('Couldn’t send that — check your connection and try again.'); return }
    onClose()
  }

  const option = { width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '14px', border: `1.5px solid ${C.border}`, borderRadius: 14, background: C.card, cursor: 'pointer', marginBottom: 10, textAlign: 'left' }
  const iconWrap = { width: 44, height: 44, borderRadius: 12, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={() => !busy && onClose()} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
        <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 16 }}>{mode === 'why' ? 'What happened?' : 'Report a problem'}</div>

        {mode === 'menu' ? (
          <>
            <button onClick={() => { setErr(''); setMode('why') }} disabled={busy} style={option}>
              <div style={iconWrap}><i className="ti ti-map-pin-off" style={{ fontSize: 20, color: C.sec }} /></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Not available here</div>
                <div style={{ fontSize: 12, color: C.muted }}>Couldn't get a matchbook at this spot</div>
              </div>
            </button>
            <button onClick={() => setMode('fake')} disabled={busy} style={option}>
              <div style={iconWrap}><i className="ti ti-flag" style={{ fontSize: 20, color: C.red }} /></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>This isn't a real matchbook</div>
                <div style={{ fontSize: 12, color: C.muted }}>Photo looks fake, stock, or wrong venue</div>
              </div>
            </button>
            {err && <div style={{ fontSize: 12, color: C.red, margin: '2px 0 10px', lineHeight: 1.4 }}>{err}</div>}
            <button onClick={onClose} disabled={busy} style={{ width: '100%', padding: 13, marginTop: 4, background: 'none', border: 'none', color: C.muted, fontSize: 15, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>Cancel</button>
          </>
        ) : mode === 'why' ? (
          <>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
              Only "closed down" and "don't make them anymore" retire a spot — and it takes two collectors to agree.
            </div>
            {REPORT_REASONS.map(r => (
              <button key={r.key} onClick={() => runNotAvailable(r.key)} disabled={busy} style={option}>
                <div style={iconWrap}><i className={`ti ${r.icon}`} style={{ fontSize: 20, color: r.key === 'closed_down' ? C.red : C.sec }} /></div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{r.title}</div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>{r.sub}</div>
                </div>
              </button>
            ))}
            {err && <div style={{ fontSize: 12, color: C.red, margin: '2px 0 10px', lineHeight: 1.4 }}>{err}</div>}
            <button onClick={() => setMode('menu')} disabled={busy} style={{ width: '100%', padding: 12, marginTop: 4, background: 'none', border: 'none', color: C.muted, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Back</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>What's wrong with it? <span style={{ color: C.muted }}>(optional)</span> A person reviews every report.</div>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="e.g. this is a stock photo, not an actual matchbook"
              style={{ width: '100%', padding: 12, border: `1.5px solid ${C.border}`, borderRadius: 12, background: C.card, color: C.text, fontSize: 14, outline: 'none', resize: 'none', marginBottom: 14, fontFamily: 'inherit', lineHeight: 1.4 }} />
            {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, lineHeight: 1.4 }}>{err}</div>}
            <PrimaryBtn onClick={runFake} disabled={busy}>{busy ? 'Reporting…' : 'Submit report'}</PrimaryBtn>
            <button onClick={() => setMode('menu')} disabled={busy} style={{ width: '100%', padding: 12, marginTop: 8, background: 'none', border: 'none', color: C.muted, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Back</button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── COMPARISON FLOW ─────────────────────────────────────
// Binary-search insertion into the user's ranked list. Completing (or "too
// close to call") writes a full position-derived respread of the list — see
// finishAt. Abandoning mid-session (tab nav) writes NOTHING: an uncompared spot
// simply stays score=null, which is a legitimate state — it waits in Rankings'
// "Unranked" section with a Rank button until the user places it.
function ComparisonFlow({ newVenue, newPhoto, rankedItems, user, onDone, initialScore = null, reRank = false }) {
  // Opponents = the user's existing ranked list, defensively excluding the new
  // venue itself (it must never compare against itself — which is exactly what
  // makes this reusable for a re-rank: the spot is pulled out of its own list).
  const opponents = useMemo(
    () => rankedItems.filter(i => i.venue_id !== newVenue.id),
    [rankedItems, newVenue.id]
  )

  const [lo, setLo] = useState(0)
  const [hi, setHi] = useState(opponents.length - 1)
  const [doneCount, setDoneCount] = useState(0)
  const [saving, setSaving] = useState(false)  // brief lock: one answer per shown matchup
  const [writeErr, setWriteErr] = useState('')
  const savingRef = useRef(false)   // synchronous re-entrancy lock (state lags a render)
  const finishedRef = useRef(false) // guarantees the single score write + onDone happen once

  const totalSteps = Math.max(1, Math.ceil(Math.log2(opponents.length + 1)))
  const mid = Math.floor((lo + hi) / 2)
  const opponent = opponents[mid]
  const finished = !opponent || lo > hi

  // Your head-to-head choices decide the ORDER; scores are then derived from the
  // final positions for the WHOLE list — 10.0 at the top down to 5.0 at the
  // bottom, evenly spaced, ALWAYS unique. Interpolating between neighbors isn't
  // enough: neighbors can be TIED (legacy seeds / old-Elo data), and the midpoint
  // of two equal scores is another tie, whose display order falls to sort
  // stability — exactly how a spot you just beat could still display above you.
  // Rewriting the full spacing makes ties impossible, so the displayed order
  // provably matches the comparisons, and every session also repairs the spacing
  // of older rows in passing. One atomic batch write; retried on failure.
  const finishAt = useCallback(async (insertIdx) => {
    if (finishedRef.current) return
    finishedRef.current = true
    const order = [
      ...opponents.slice(0, insertIdx).map(o => o.venue_id),
      newVenue.id,
      ...opponents.slice(insertIdx).map(o => o.venue_id),
    ]
    const n = order.length
    const rows = order.map((venue_id, i) => ({
      user_id: user.id,
      venue_id,
      score: n === 1 ? 7.5 : 10 - (5 * i) / (n - 1),
    }))
    const { error } = await supabase.from('collections')
      .upsert(rows, { onConflict: 'user_id,venue_id' })
    if (error) {
      finishedRef.current = false // release so the user can retry
      console.error('Ranking write failed', error)
      setWriteErr('Couldn’t save — tap again.')
      return
    }
    onDone()
  }, [opponents, user.id, newVenue.id, onDone])

  // Terminal condition (search converged / no opponents) — run as an effect. `lo`
  // is the final insertion slot; captured fresh in the render where finished flips.
  useEffect(() => {
    if (finished) finishAt(lo)
  }, [finished]) // eslint-disable-line react-hooks/exhaustive-deps

  // Release the one-answer-per-matchup lock once the next matchup has rendered.
  useEffect(() => { savingRef.current = false; setSaving(false) }, [lo, hi])

  if (finished) return null

  const oppRank = mid + 1

  const pick = (newWon) => {
    if (savingRef.current || finishedRef.current) return
    savingRef.current = true
    setSaving(true)
    setWriteErr('')

    // The comparisons audit log is OPTIONAL (spec §3) — best-effort, fire-and-forget
    // so a missing/unmigrated comparisons table can never block ranking.
    supabase.from('comparisons').insert({
      user_id: user.id,
      winner_venue_id: newWon ? newVenue.id : opponent.venue_id,
      loser_venue_id: newWon ? opponent.venue_id : newVenue.id,
    }).then(({ error }) => { if (error) console.warn('comparisons log skipped:', error.message) })

    setDoneCount(n => n + 1)
    // Descending list: a WIN moves the new spot toward the top (search the upper
    // half), a LOSS toward the bottom. finishAt fires from the [finished] effect
    // once the slot collapses (newLo > newHi). No DB write per tap; no venue moves.
    setLo(newWon ? lo : mid + 1)
    setHi(newWon ? mid - 1 : hi)
  }

  // "Too close to call": place the spot adjacent to the current matchup opponent.
  const skip = () => { if (!savingRef.current && !finishedRef.current) finishAt(mid) }

  const newIni = venueInitials(newVenue.name)
  const oppIni = venueInitials(opponent.venue?.name || '')
  const oppPhoto = opponent.photo_url || (opponent.photos && opponent.photos[0]) || null
  // Show the actual matchbook photo (prominently) when there is one, else the
  // initials disc — so the head-to-head is between the photos you took.
  const avatar = (photo, bg, ini) => photo
    ? <img src={photo} alt="" style={{ width: 120, height: 120, borderRadius: 16, objectFit: 'cover', marginBottom: 12, border: `1px solid ${C.border}` }} />
    : <div style={{ width: 88, height: 88, borderRadius: '50%', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, fontWeight: 700, color: '#fff', marginBottom: 12 }}>{ini}</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg }}>
      <SBar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 20px 16px', overflowY: 'auto' }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.5px', marginBottom: 4, textAlign: 'center' }}>{reRank ? 'Re-rank this spot' : 'Where does this rank?'}</div>
        <div style={{ fontSize: 14, color: C.muted, marginBottom: 18, textAlign: 'center' }}>Tap the one you liked more</div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
          {Array.from({ length: totalSteps }, (_, i) => (
            <div key={i} style={{ height: 4, width: i === doneCount ? 28 : (i < doneCount ? 24 : 12), borderRadius: 2, background: i <= doneCount ? C.amber : C.border, transition: 'all .2s' }} />
          ))}
        </div>

        <div onClick={() => pick(true)}
          style={{ width: '100%', background: C.amberBg, border: `2px solid ${C.amberBd}`, borderRadius: 20, padding: '28px 16px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1, marginBottom: 14, position: 'relative' }}>
          <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: C.amberBg, border: `1.5px solid ${C.amberBd}`, borderRadius: 99, padding: '3px 16px', fontSize: 11, fontWeight: 800, color: C.amber, letterSpacing: '.8px', whiteSpace: 'nowrap' }}>{reRank ? 'THIS SPOT' : 'NEW'}</div>
          {avatar(newPhoto, '#1A1918', newIni)}
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 4, textAlign: 'center' }}>{newVenue.name}</div>
          <div style={{ fontSize: 13, color: C.sec }}>{newVenue.neighborhood || newVenue.city || (isKeepsake(newVenue) ? 'Keepsake' : '')}</div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, letterSpacing: '1px', marginBottom: 14 }}>VS</div>

        <div onClick={() => pick(false)}
          style={{ width: '100%', background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 20, padding: '28px 16px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1, marginBottom: 16, position: 'relative' }}>
          <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 99, padding: '3px 16px', fontSize: 11, fontWeight: 800, color: C.muted, letterSpacing: '.8px', whiteSpace: 'nowrap' }}>CURRENTLY #{oppRank}</div>
          {avatar(oppPhoto, opponent.venue?.bg_color || '#3D2B1A', oppIni)}
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 4, textAlign: 'center' }}>{opponent.venue?.name || ''}</div>
          <div style={{ fontSize: 13, color: C.sec }}>{opponent.venue?.neighborhood || opponent.venue?.city || ''}</div>
        </div>

        {writeErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, textAlign: 'center', lineHeight: 1.4 }}>{writeErr}</div>}

        <button onClick={skip} disabled={saving} style={{ background: 'none', border: 'none', fontSize: 14, color: C.muted, cursor: saving ? 'default' : 'pointer', textDecoration: 'underline', marginBottom: 10 }}>
          Too close to call — skip
        </button>
        <div style={{ fontSize: 11, color: C.muted, textAlign: 'center', lineHeight: 1.5 }}>Your picks set the order — there's no wrong answer</div>
      </div>
    </div>
  )
}

// Per-row action menu on the Mine list: re-rank (redo the head-to-heads) or
// report. Matches ReportSheet's bottom-sheet styling.
function RankActionsSheet({ item, onReRank, onUnrank, onReport, onClose }) {
  const option = { width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '14px', border: `1.5px solid ${C.border}`, borderRadius: 14, background: C.card, cursor: 'pointer', marginBottom: 10, textAlign: 'left' }
  const iconWrap = { width: 44, height: 44, borderRadius: 12, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
        <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue?.name}</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>Currently #{item.rank} · {Number(item.score).toFixed(1)}</div>
        <button onClick={onReRank} style={option}>
          <div style={iconWrap}><i className="ti ti-arrows-sort" style={{ fontSize: 20, color: C.amber }} /></div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Re-rank this spot</div>
            <div style={{ fontSize: 12, color: C.muted }}>Redo the head-to-heads to move it</div>
          </div>
        </button>
        <button onClick={onUnrank} style={option}>
          <div style={iconWrap}><i className="ti ti-arrow-bar-to-down" style={{ fontSize: 20, color: C.sec }} /></div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Move to unranked</div>
            <div style={{ fontSize: 12, color: C.muted }}>Take it out of your list until you rank it</div>
          </div>
        </button>
        <button onClick={onReport} style={option}>
          <div style={iconWrap}><i className="ti ti-flag" style={{ fontSize: 20, color: C.sec }} /></div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Report a problem</div>
            <div style={{ fontSize: 12, color: C.muted }}>Not available, or not a real matchbook</div>
          </div>
        </button>
        <button onClick={onClose} style={{ width: '100%', padding: 13, marginTop: 4, background: 'none', border: 'none', color: C.muted, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}

// ─── RANKINGS SCREEN ─────────────────────────────────────
function Rankings({ collection, venues, onFlag, onFakeReport, onReRank, onUnrank, onRemove, onAddPhotos, onSheetOpenChange }) {
  const [tab, setTab] = useState('mine')
  const [reporting, setReporting] = useState(null) // venue being reported
  const [actions, setActions] = useState(null)     // ranked item whose ··· menu is open
  const [detail, setDetail] = useState(null)       // { item, venue } — any row opened as a card
  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))

  useEffect(() => {
    onSheetOpenChange?.(!!reporting || !!actions)
    return () => onSheetOpenChange?.(false)
  }, [reporting, actions]) // eslint-disable-line react-hooks/exhaustive-deps
  // Attach venue and drop venue-less rows BEFORE numbering, so rank is always
  // contiguous with the rendered list (no gaps if a venue hasn't loaded yet).
  const ranked = collection
    .filter(i => i.score != null)
    .map(item => ({ ...item, venue: venueMap[item.venue_id] }))
    .filter(i => i.venue)
    .sort((a, b) => b.score - a.score)
    .map((item, idx) => ({ ...item, rank: idx + 1 }))

  // Uncompared spots (map "Got it" / skipped) wait here, OUTSIDE the ranking,
  // until the user places them via the Rank button — only head-to-head choices
  // can put something in the ordered list.
  const unranked = collection
    .filter(i => i.score == null)
    .map(item => ({ ...item, venue: venueMap[item.venue_id] }))
    .filter(i => i.venue)

  // Friends rankings: per-venue avg score across people you follow (RPC; the rows
  // come back already sorted best-first). null = loading, [] = loaded empty.
  const [friendsRows, setFriendsRows] = useState(null)
  useEffect(() => {
    if (tab !== 'friends') return
    let cancelled = false
    setFriendsRows(null)
    supabase.rpc('friends_rankings').then(({ data, error }) => {
      if (cancelled) return
      setFriendsRows(error ? [] : (data || []))
    })
    return () => { cancelled = true }
  }, [tab])

  const friendsRanked = (friendsRows || [])
    .map(r => ({ ...r, venue: venueMap[r.venue_id] }))
    .filter(r => r.venue && !isKeepsake(r.venue))
    .map((r, idx) => ({ ...r, rank: idx + 1 }))

  // Cities to switch between = the real cities present in the venue set, busiest
  // first (so New York, where most spots are, is the default).
  const cityList = useMemo(() => {
    const counts = {}
    venues.forEach(v => { if (v.city) counts[v.city] = (counts[v.city] || 0) + 1 })
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  }, [venues])
  const [cityChoice, setCityChoice] = useState('')
  useEffect(() => { if (!cityChoice && cityList.length) setCityChoice(cityList[0]) }, [cityList, cityChoice])

  // City rankings: per-venue avg score across ALL collectors, filtered to the
  // chosen city (city_rankings RPC, sorted best-first). World: same, globally.
  const [cityRows, setCityRows] = useState(null)
  useEffect(() => {
    if (tab !== 'city' || !cityChoice) return
    let cancelled = false
    setCityRows(null)
    supabase.rpc('city_rankings', { target_city: cityChoice }).then(({ data, error }) => {
      if (!cancelled) setCityRows(error ? [] : (data || []))
    })
    return () => { cancelled = true }
  }, [tab, cityChoice])

  const [worldRows, setWorldRows] = useState(null)
  useEffect(() => {
    if (tab !== 'world') return
    let cancelled = false
    setWorldRows(null)
    supabase.rpc('world_rankings').then(({ data, error }) => {
      if (!cancelled) setWorldRows(error ? [] : (data || []))
    })
    return () => { cancelled = true }
  }, [tab])

  const cityRanked = (cityRows || []).map(r => ({ ...r, venue: venueMap[r.venue_id] })).filter(r => r.venue && !isKeepsake(r.venue)).map((r, idx) => ({ ...r, rank: idx + 1 }))
  const worldRanked = (worldRows || []).map(r => ({ ...r, venue: venueMap[r.venue_id] })).filter(r => r.venue && !isKeepsake(r.venue)).map((r, idx) => ({ ...r, rank: idx + 1 }))

  // Pale medal fills with dark, hue-matched digits (matches the mockup).
  const rankCircle = (n) => ({
    width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, flexShrink: 0,
    background: n === 1 ? '#F5E0A8' : n === 2 ? '#E2E2E2' : n === 3 ? '#E8C2A0' : C.surface,
    color: n === 1 ? '#7A5A0A' : n === 2 ? '#737373' : n === 3 ? '#7A4A1A' : C.muted,
  })

  // Shared renderer for the aggregate tabs (Friends / City / World) — identical
  // rows, only the subtitle differs.
  const aggList = (rows, subtitle) => (
    <div style={{ padding: '4px 16px' }}>
      {rows.map(item => (
        <div key={item.venue_id} onClick={() => openRow(item.venue)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer' }}>
          <div style={rankCircle(item.rank)}>{item.rank}</div>
          <div style={{ width: 42, height: 42, borderRadius: 11, background: item.venue.bg_color || C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0, letterSpacing: '-.2px' }}>
            {venueInitials(item.venue.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
            <div style={{ fontSize: 12, color: C.muted }}>{subtitle(item)}</div>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.amber, flexShrink: 0 }}>{Number(item.avg_score).toFixed(1)}</div>
        </div>
      ))}
      <div style={{ height: 24 }} />
    </div>
  )
  const collectorsLabel = (n) => `${n} ${n === 1 ? 'collector' : 'collectors'}`

  // EVERY row opens the same card — Mine, and the City/World/Friends boards,
  // which used to be dead taps. If the spot is in your collection the card is
  // the full matchbook page (photos, rank); if not, it's read-only.
  const openRow = (venue) => {
    const mine = collection.find(c => c.venue_id === venue.id)
    setDetail({ item: mine ? { ...mine, venue } : null, venue })
  }

  if (detail) {
    return (
      <MatchbookDetail
        item={detail.item}
        venue={detail.venue}
        backLabel="Rankings"
        onBack={() => setDetail(null)}
        onReRank={onReRank ? (it) => { setDetail(null); onReRank(it) } : null}
        onRemove={onRemove ? (id) => { onRemove(id); setDetail(null) } : null}
        onAddPhotos={onAddPhotos}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
      <SBar />
      <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: '-.6px', marginBottom: 12 }}>Rankings</div>
        <div style={{ display: 'flex', borderBottom: `0.5px solid ${C.border}` }}>
          {['Mine', 'Friends', 'City', 'World'].map(t => (
            <div key={t} onClick={() => setTab(t.toLowerCase())}
              style={{ padding: '8px 14px 9px', fontSize: 14, fontWeight: tab === t.toLowerCase() ? 700 : 500, color: tab === t.toLowerCase() ? C.text : C.muted, cursor: 'pointer', borderBottom: tab === t.toLowerCase() ? `2px solid ${C.text}` : '2px solid transparent', marginBottom: -1, transition: 'color .15s' }}>
              {t}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'mine' ? (
          (ranked.length === 0 && unranked.length === 0) ? (
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🏆</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No rankings yet</div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Submit your first matchbook to start building your list</div>
            </div>
          ) : (
            <div style={{ padding: '4px 16px' }}>
              {ranked.map(item => (
                <div key={item.id} onClick={() => openRow(item.venue)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer' }}>
                  <div style={rankCircle(item.rank)}>{item.rank}</div>
                  <div style={{ width: 42, height: 42, borderRadius: 11, background: item.venue.bg_color || C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0, letterSpacing: '-.2px' }}>
                    {venueInitials(item.venue.name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{item.venue.neighborhood || item.venue.city || (isKeepsake(item.venue) ? 'Keepsake' : '')}</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: C.amber, flexShrink: 0 }}>{Number(item.score).toFixed(1)}</div>
                  <button onClick={(e) => { e.stopPropagation(); setActions(item) }} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: '4px 2px', fontSize: 18, flexShrink: 0, letterSpacing: '.5px' }}>···</button>
                </div>
              ))}
              {unranked.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', padding: '18px 0 6px' }}>
                    UNRANKED · {unranked.length}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, paddingBottom: 6 }}>
                    Collected but not placed yet — rank them to add them to your list.
                  </div>
                  {unranked.map(item => (
                    <div key={item.id} onClick={() => openRow(item.venue)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer' }}>
                      <div style={{ width: 42, height: 42, borderRadius: 11, background: item.venue.bg_color || C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0, letterSpacing: '-.2px', opacity: 0.75 }}>
                        {venueInitials(item.venue.name)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                        <div style={{ fontSize: 12, color: C.muted }}>{item.venue.neighborhood || item.venue.city || (isKeepsake(item.venue) ? 'Keepsake' : '')}</div>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); onReRank?.(item) }}
                        style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 700, padding: '7px 16px', borderRadius: 99, border: 'none', background: C.amber, color: '#fff', cursor: 'pointer' }}>
                        Rank
                      </button>
                    </div>
                  ))}
                </>
              )}
              <div style={{ height: 24 }} />
            </div>
          )
        ) : tab === 'friends' ? (
          (friendsRows === null) ? (
            // Only a null (not-yet-fetched) state is "loading"; a returned-but-
            // unresolvable row set falls through to the empty state, never hangs.
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem', color: C.muted, fontSize: 13 }}>Loading…</div>
          ) : friendsRanked.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No friends rankings yet</div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Follow collectors from your Profile — once they've ranked spots, your friends' combined list shows here.</div>
            </div>
          ) : (
            aggList(friendsRanked, item => `${item.venue.neighborhood || item.venue.city} · ${item.rankers} ${item.rankers === 1 ? 'friend' : 'friends'}`)
          )
        ) : tab === 'city' ? (
          <>
            <div style={{ padding: '10px 16px 4px', flexShrink: 0 }}>
              <div style={{ position: 'relative' }}>
                <select value={cityChoice} onChange={e => setCityChoice(e.target.value)}
                  style={{ width: '100%', padding: '11px 14px', border: `1.5px solid ${C.amberBd}`, borderRadius: 12, background: C.amberBg, color: C.amber, fontSize: 14, fontWeight: 700, appearance: 'none', WebkitAppearance: 'none', cursor: 'pointer', outline: 'none' }}>
                  {cityList.length === 0 && <option value="">No cities yet</option>}
                  {cityList.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <i className="ti ti-chevron-down" style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: C.amber, fontSize: 16, pointerEvents: 'none' }} />
              </div>
            </div>
            {cityList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem 1.5rem', color: C.muted, fontSize: 13 }}>No cities on the map yet.</div>
            ) : (cityRows === null) ? (
              <div style={{ textAlign: 'center', padding: '3rem 1.5rem', color: C.muted, fontSize: 13 }}>Loading…</div>
            ) : cityRanked.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📍</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>Nothing ranked in {cityChoice} yet</div>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Be the first — rank a spot here and it tops the city board.</div>
              </div>
            ) : (
              aggList(cityRanked, item => `${item.venue.neighborhood || item.venue.city} · ${collectorsLabel(item.rankers)}`)
            )}
          </>
        ) : (
          (worldRows === null) ? (
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem', color: C.muted, fontSize: 13 }}>Loading…</div>
          ) : worldRanked.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🌎</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No world rankings yet</div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Once collectors start ranking spots, the best places everywhere show up here.</div>
            </div>
          ) : (
            aggList(worldRanked, item => `${item.venue.city || item.venue.neighborhood} · ${collectorsLabel(item.rankers)}`)
          )
        )}
      </div>

      {actions && (
        <RankActionsSheet
          item={actions}
          onClose={() => setActions(null)}
          onReRank={() => { const it = actions; setActions(null); onReRank?.(it) }}
          onUnrank={() => { const it = actions; setActions(null); onUnrank?.(it) }}
          onReport={() => { const v = actions.venue; setActions(null); setReporting(v) }}
        />
      )}

      {reporting && (
        <ReportSheet
          venue={reporting}
          onClose={() => setReporting(null)}
          onNotAvailable={onFlag}
          onFake={onFakeReport}
        />
      )}
    </div>
  )
}

// ─── PROFILE SCREEN ──────────────────────────────────────
function ProfileScreen({ user, displayName, collection, onSignOut, onDeleteAccount, isAdmin, pendingReports = 0, onOpenAdmin, onOpenInvite, following = [], onUnfollow, blocked = [], onUnblock, onOpenFind, onViewCollector, avatarUrl, onAvatarChange, onSheetOpenChange }) {
  const [confirmDelete, setConfirmDelete] = useState(false) // delete-account confirm sheet open
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteErr, setDeleteErr] = useState('')

  useEffect(() => {
    onSheetOpenChange?.(confirmDelete)
    return () => onSheetOpenChange?.(false)
  }, [confirmDelete]) // eslint-disable-line react-hooks/exhaustive-deps

  const runDelete = async () => {
    setDeleting(true)
    setDeleteErr('')
    const err = await onDeleteAccount?.()
    // On success the app signs out and unmounts this screen; only reached on error.
    setDeleting(false)
    if (err) setDeleteErr('Couldn’t delete your account — check your connection and try again.')
  }
  const byCity = Object.entries(collection.filter(i => i.venue).reduce((m, i) => {
    const c = isKeepsake(i.venue) ? 'Keepsakes' : (i.venue.city || 'Unknown'); m[c] = (m[c] || 0) + 1; return m
  }, {})).sort((a, b) => b[1] - a[1])
  const name = displayName || user.user_metadata?.display_name || user.email?.split('@')[0] || 'Collector'
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [avatarErr, setAvatarErr] = useState('')
  const avatarInputRef = useRef(null)

  const pickAvatar = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !user) return
    setUploadingAvatar(true)
    setAvatarErr('')
    try {
      const blob = await downscaleImage(file, 512, 0.85)
      const path = `${user.id}/avatar-${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage.from('matchbooks').upload(path, blob, { contentType: 'image/jpeg', upsert: false })
      if (upErr) throw upErr
      const url = supabase.storage.from('matchbooks').getPublicUrl(path).data.publicUrl
      const { error: updErr } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', user.id)
      if (updErr) throw updErr
      onAvatarChange?.(url)
    } catch (err) {
      console.error('Avatar upload failed', err)
      setAvatarErr('Couldn’t update your photo — try again.')
    }
    setUploadingAvatar(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SBar title="phillumeni" />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
            <div onClick={() => !uploadingAvatar && avatarInputRef.current?.click()} style={{ position: 'relative', width: 64, height: 64, cursor: 'pointer', flexShrink: 0 }}>
              {avatarUrl
                ? <img src={avatarUrl} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} />
                : <Av ini={name.slice(0, 2).toUpperCase()} bg={C.purpleBg} tc={C.purple} size={64} />}
              <div style={{ position: 'absolute', bottom: -2, right: -2, width: 24, height: 24, borderRadius: '50%', background: C.dark, border: '2px solid #fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-camera" style={{ fontSize: 12, color: '#fff' }} />
              </div>
              {uploadingAvatar && (
                <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid #fff', animation: 'spin 1s linear infinite' }} />
                </div>
              )}
            </div>
            <button onClick={onSignOut} style={{ fontSize: 12, color: C.muted, background: 'none', border: `0.5px solid ${C.border}`, borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>Sign out</button>
          </div>
          <input ref={avatarInputRef} type="file" accept="image/*" onChange={pickAvatar} style={{ display: 'none' }} />
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text, letterSpacing: '-.3px', marginBottom: 2 }}>{name}</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: avatarErr ? 6 : 14 }}>{user.email}</div>
          {avatarErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{avatarErr}</div>}

          <button onClick={onOpenInvite} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 13, marginBottom: 14, background: C.dark, color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer', letterSpacing: '-.1px' }}>
            <i className="ti ti-user-plus" style={{ fontSize: 16 }} />
            Invite friends
          </button>

          {/* Following — collectors you follow */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: following.length ? 8 : 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.4px' }}>
                FOLLOWING{following.length ? ` · ${following.length}` : ''}
              </div>
              <button onClick={onOpenFind} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: C.amber, fontSize: 12, fontWeight: 700 }}>
                <i className="ti ti-search" style={{ fontSize: 13 }} />Find collectors
              </button>
            </div>
            {following.length === 0 ? (
              <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>Follow other collectors to see them here.</div>
            ) : (
              following.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `0.5px solid ${C.border}` }}>
                  <div onClick={() => onViewCollector?.({ id: f.id, display_name: f.display_name || f.username, avatar_url: f.avatar_url, isFollowing: true })} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, cursor: 'pointer' }}>
                    {f.avatar_url
                      ? <img src={f.avatar_url} alt="" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                      : <div style={{ width: 34, height: 34, borderRadius: '50%', background: C.purpleBg, color: C.purple, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{(f.display_name || f.username || '?').slice(0, 2).toUpperCase()}</div>}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.display_name || f.username}</div>
                      <div style={{ fontSize: 11, color: C.muted }}>{f.matchbooks} {f.matchbooks === 1 ? 'matchbook' : 'matchbooks'}</div>
                    </div>
                  </div>
                  <button onClick={() => onUnfollow?.(f.id)} style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '5px 12px', borderRadius: 99, border: `1px solid ${C.border}`, background: 'transparent', color: C.sec, cursor: 'pointer' }}>Following</button>
                </div>
              ))
            )}
          </div>

          {/* Your trade record — the same thing other collectors see before
              they accept your offer. Accountability only works if it's public. */}
          <TradeRecord userId={user?.id} name={name} />

          {/* Blocked — only appears once you've blocked someone. A block you
              can't undo isn't a feature, it's a trap (and Apple checks). */}
          {blocked.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', marginBottom: 8 }}>BLOCKED · {blocked.length}</div>
              {blocked.map(b => (
                <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `0.5px solid ${C.border}` }}>
                  {b.avatar_url
                    ? <img src={b.avatar_url} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, filter: 'grayscale(1)', opacity: 0.6 }} />
                    : <Av ini={(b.display_name || '?').slice(0, 2).toUpperCase()} bg={C.surface} tc={C.muted} size={32} />}
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: C.sec, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.display_name}</div>
                  <button onClick={() => onUnblock?.(b.id)} style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '5px 12px', borderRadius: 99, border: `1px solid ${C.border}`, background: 'transparent', color: C.sec, cursor: 'pointer' }}>Unblock</button>
                </div>
              ))}
            </div>
          )}

          {isAdmin && (
            <button onClick={onOpenAdmin} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 14, background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 12, cursor: 'pointer', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
              <i className="ti ti-shield-check" style={{ fontSize: 20, color: C.amber }} />
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Reported photos</div>
                <div style={{ fontSize: 11, color: C.muted }}>Moderate flagged submissions</div>
              </div>
              {pendingReports > 0 && (
                <span style={{ minWidth: 22, height: 22, padding: '0 6px', borderRadius: 11, background: C.red, color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{pendingReports}</span>
              )}
              <i className="ti ti-chevron-right" style={{ fontSize: 16, color: C.muted }} />
            </button>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
            {[{ n: collection.length, l: 'matchbooks' }, { n: new Set(collection.map(i => i.venue?.city).filter(Boolean)).size, l: 'cities' }, { n: collection.filter(i => i.score != null).length, l: 'ranked' }].map((s, i) => (
              <div key={i} style={{ background: C.surface, borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{s.n}</div>
                <div style={{ fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 600, marginTop: 1 }}>{s.l}</div>
              </div>
            ))}
          </div>

          {byCity.length > 0 && (
            <Card style={{ padding: '11px 14px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 8 }}>By city</div>
              {byCity.map(([city, n]) => (
                <div key={city} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                  <span style={{ fontSize: 13, color: C.sec }}>{city}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{n}</span>
                </div>
              ))}
            </Card>
          )}
        </div>

        {collection.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: C.muted, fontSize: 13 }}>Start collecting to build your profile</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, padding: 2 }}>
            {collection.map(item => item.venue && (
              <div key={item.id} style={{ aspectRatio: '1', background: item.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, position: 'relative', overflow: 'hidden' }}>
                {item.photo_url
                  ? <img src={item.photo_url} alt="" loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }} />
                  : item.venue.emoji}
                {isRetired(item.venue) && (
                  <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 8, fontWeight: 700, letterSpacing: .3, padding: '1px 5px', borderRadius: 99 }}>
                    {item.venue.status === 'discontinued' ? 'NO MATCHES' : 'CLOSED'}
                  </div>
                )}
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent,rgba(0,0,0,0.6))', padding: '12px 4px 4px' }}>
                  <div style={{ fontSize: 9, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ padding: '22px 16px 8px', textAlign: 'center' }}>
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, color: C.muted, textDecoration: 'underline' }}>Privacy Policy</a>
          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 10, letterSpacing: '.3px' }}>build {__BUILD_STAMP__}</div>
          <button onClick={() => { setDeleteErr(''); setDeleteConfirmText(''); setConfirmDelete(true) }}
            style={{ display: 'block', margin: '16px auto 0', background: 'none', border: 'none', padding: 4, color: C.red, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Delete account
          </button>
        </div>
        <div style={{ height: 24 }} />
      </div>

      {confirmDelete && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => !deleting && setConfirmDelete(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px calc(24px + env(safe-area-inset-bottom))', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 8 }}>Delete your account?</div>
            <div style={{ fontSize: 13.5, color: C.sec, lineHeight: 1.6, marginBottom: 16 }}>
              This permanently erases your profile, your whole collection and rankings, your follows, and the photos you uploaded. <span style={{ color: C.text, fontWeight: 700 }}>It can't be undone.</span>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Type <span style={{ fontWeight: 800, color: C.text }}>DELETE</span> to confirm.</div>
            <input value={deleteConfirmText} onChange={e => setDeleteConfirmText(e.target.value)} placeholder="DELETE" autoCapitalize="characters" autoCorrect="off"
              style={{ width: '100%', padding: '12px 14px', border: `1.5px solid ${C.border}`, borderRadius: 12, background: C.card, color: C.text, fontSize: 15, fontWeight: 700, outline: 'none', marginBottom: 14, letterSpacing: '1.5px' }} />
            {deleteErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{deleteErr}</div>}
            <button onClick={runDelete} disabled={deleting || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
              style={{ width: '100%', padding: 14, background: (deleting || deleteConfirmText.trim().toUpperCase() !== 'DELETE') ? '#E7A7A7' : C.red, color: '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: (deleting || deleteConfirmText.trim().toUpperCase() !== 'DELETE') ? 'default' : 'pointer', marginBottom: 6 }}>
              {deleting ? 'Deleting…' : 'Permanently delete my account'}
            </button>
            <button onClick={() => !deleting && setConfirmDelete(false)} disabled={deleting} style={{ width: '100%', padding: 12, background: 'none', border: 'none', color: C.muted, fontSize: 15, fontWeight: 600, cursor: deleting ? 'default' : 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── INVITE SCREEN ───────────────────────────────────────
// PWA invite: a personal link ({origin}/?invite=<user.id>) + the native share
// sheet (Web Share, works on iOS Safari/PWA). Contacts + "who's on the app"
// matching is the native-app milestone, not this.
function InviteScreen({ user, onBack }) {
  // Key the referral on the stable user id, not username — usernames get suffixed
  // on collision (handle_new_user) and can be reused after deletion, which would
  // break/mis-credit the count. The id is unambiguous and permanent.
  const origin = (typeof window !== 'undefined' && window.location?.origin) || 'https://phillumeni.vercel.app'
  const link = `${origin}/?invite=${user.id}`
  const [copied, setCopied] = useState(false)
  const [joined, setJoined] = useState(null)

  useEffect(() => {
    let cancelled = false
    supabase.rpc('my_referral_count').then(({ data, error }) => {
      if (!cancelled && !error && typeof data === 'number') setJoined(data)
    })
    return () => { cancelled = true }
  }, [])

  const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 2000) }
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); flash() } catch { /* clipboard blocked */ }
  }
  const share = async () => {
    const text = "I'm collecting matchbooks on Phillumeni — come hunt with me."
    try {
      if (navigator.share) await navigator.share({ title: 'Phillumeni', text, url: link })
      else { await navigator.clipboard.writeText(`${text} ${link}`); flash() }
    } catch { /* user dismissed the share sheet */ }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: C.bg }}>
      <SBar />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px 0', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: C.amber, fontSize: 13, fontWeight: 700 }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />Profile
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: 22 }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: C.amberBg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
            <i className="ti ti-users" style={{ fontSize: 26, color: C.amber }} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Invite friends</div>
          <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.5, maxWidth: 260 }}>It's a better hunt when your people are collecting too.</div>
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.4px', marginBottom: 7 }}>YOUR INVITE LINK</div>
        <div onClick={copyLink} style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.card, border: `0.5px solid ${C.border}`, borderRadius: 12, padding: '12px 14px', cursor: 'pointer', marginBottom: 12 }}>
          <i className="ti ti-link" style={{ fontSize: 16, color: C.muted, flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.replace(/^https?:\/\//, '')}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: copied ? C.green : C.amber, flexShrink: 0 }}>{copied ? 'Copied' : 'Copy'}</span>
        </div>

        <PrimaryBtn onClick={share}>
          <i className="ti ti-share" style={{ fontSize: 15, marginRight: 7 }} />Invite via Messages
        </PrimaryBtn>
        <div style={{ fontSize: 11.5, color: C.muted, textAlign: 'center', marginTop: 10, lineHeight: 1.5 }}>
          Opens your share sheet — pick Messages, WhatsApp, anyone.
        </div>

        {joined != null && joined > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 22, padding: '12px 14px', background: C.surface, borderRadius: 12 }}>
            <i className="ti ti-gift" style={{ fontSize: 18, color: C.amber }} />
            <span style={{ fontSize: 13, color: C.sec }}>
              <span style={{ fontWeight: 700, color: C.text }}>{joined}</span> {joined === 1 ? 'friend has' : 'friends have'} joined from your link
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── FIND COLLECTORS (follow discovery) ──────────────────
// Username search → follow/unfollow. Reads come from a SECURITY DEFINER RPC
// (profiles are owner-only); follows are written directly under their own RLS.
function FindCollectors({ onFollow, onUnfollow, onView, onBack }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [err, setErr] = useState('')
  const timer = useRef(null)
  const seq = useRef(0)

  const search = async (raw) => {
    const term = raw.trim()
    const my = ++seq.current // bump first so clearing the box invalidates in-flight queries
    if (term.length < 1) { setResults([]); setSearching(false); return }
    setSearching(true)
    setErr('')
    const { data, error } = await supabase.rpc('search_collectors', { q: term })
    if (my !== seq.current) return
    setSearching(false)
    if (error) { setResults([]); setErr('Couldn’t search right now. Try again.'); return }
    setResults(data || [])
  }
  const onChange = (v) => { setQ(v); clearTimeout(timer.current); timer.current = setTimeout(() => search(v), 350) }

  const toggle = async (r) => {
    setBusyId(r.id)
    const ok = r.is_following ? await onUnfollow(r.id) : await onFollow(r.id)
    if (ok) setResults(prev => prev.map(x => (x.id === r.id ? { ...x, is_following: !x.is_following } : x)))
    setBusyId(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: C.bg }}>
      <SBar />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px 0', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: C.amber, fontSize: 13, fontWeight: 700 }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />Profile
        </button>
      </div>

      <div style={{ padding: '8px 16px 0', flexShrink: 0 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: C.text, letterSpacing: '-.5px', margin: '6px 0 12px' }}>Find collectors</div>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <i className="ti ti-search" style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', fontSize: 15, color: C.muted }} />
          <input value={q} onChange={e => onChange(e.target.value)} placeholder="Search by name" autoFocus
            style={{ width: '100%', padding: '12px 12px 12px 40px', border: `1.5px solid ${q ? C.dark : C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 14, fontWeight: 500, outline: 'none' }} />
          {searching && <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, borderRadius: '50%', border: `2px solid ${C.border}`, borderTop: `2px solid ${C.dark}`, animation: 'spin 1s linear infinite' }} />}
        </div>
        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{err}</div>}
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 24px' }}>
        {results.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 0', borderBottom: `0.5px solid ${C.border}` }}>
            <div onClick={() => onView?.({ id: r.id, display_name: r.display_name || r.username, avatar_url: r.avatar_url, isFollowing: r.is_following })} style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 1, minWidth: 0, cursor: 'pointer' }}>
              {r.avatar_url
                ? <img src={r.avatar_url} alt="" style={{ width: 38, height: 38, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                : <div style={{ width: 38, height: 38, borderRadius: '50%', background: C.purpleBg, color: C.purple, fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{(r.display_name || r.username || '?').slice(0, 2).toUpperCase()}</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.display_name || r.username}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{r.matchbooks} {r.matchbooks === 1 ? 'matchbook' : 'matchbooks'}</div>
              </div>
            </div>
            <button onClick={() => toggle(r)} disabled={busyId === r.id}
              style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, padding: '7px 16px', borderRadius: 99, cursor: busyId === r.id ? 'default' : 'pointer', border: r.is_following ? `1px solid ${C.border}` : 'none', background: r.is_following ? 'transparent' : C.dark, color: r.is_following ? C.sec : '#fff', opacity: busyId === r.id ? 0.6 : 1 }}>
              {r.is_following ? 'Following' : 'Follow'}
            </button>
          </div>
        ))}
        {q.trim().length >= 1 && !searching && results.length === 0 && !err && (
          <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: C.muted, fontSize: 13 }}>No collectors match “{q.trim()}”.</div>
        )}
        {q.trim().length === 0 && (
          <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: C.muted, fontSize: 13, lineHeight: 1.6 }}>Search a name to follow other collectors and compare lists.</div>
        )}
      </div>
    </div>
  )
}

// ─── COLLECTOR PROFILE (a collector you follow) ──────────
// Follow-gated: collector_profile() returns their ranked collection only if you
// follow them (migration 016). Reached from the Following list + Find collectors.
function CollectorProfile({ collector, isFollowing, onFollow, onUnfollow, onBlock, onBack }) {
  const [rows, setRows] = useState(null) // null = loading, [] = none/locked
  const [following, setFollowing] = useState(!!isFollowing)
  const [busy, setBusy] = useState(false)
  const [confirmBlock, setConfirmBlock] = useState(false)
  const [blockErr, setBlockErr] = useState('')

  useEffect(() => {
    let cancelled = false
    setRows(null)
    supabase.rpc('collector_profile', { target: collector.id }).then(({ data, error }) => {
      if (cancelled) return
      setRows(error ? [] : (data || []))
    })
    return () => { cancelled = true }
  }, [collector.id, following])

  const toggle = async () => {
    setBusy(true)
    const ok = following ? await onUnfollow(collector.id) : await onFollow(collector.id)
    if (ok) setFollowing(!following)
    setBusy(false)
  }

  const ranked = (rows || []).map((r, idx) => ({ ...r, rank: idx + 1 }))
  const cities = new Set((rows || []).map(r => r.city).filter(Boolean)).size
  const rankCircle = (n) => ({
    width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, flexShrink: 0,
    background: n === 1 ? '#F5E0A8' : n === 2 ? '#E2E2E2' : n === 3 ? '#E8C2A0' : C.surface,
    color: n === 1 ? '#7A5A0A' : n === 2 ? '#737373' : n === 3 ? '#7A4A1A' : C.muted,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: C.bg }}>
      <SBar />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px 0', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: C.amber, fontSize: 13, fontWeight: 700 }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />Back
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
          {collector.avatar_url
            ? <img src={collector.avatar_url} alt="" style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
            : <Av ini={(collector.display_name || '?').slice(0, 2).toUpperCase()} bg={C.purpleBg} tc={C.purple} size={60} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 800, color: C.text, letterSpacing: '-.4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{collector.display_name}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 1 }}>
              {following ? `${ranked.length} ranked${cities ? ` · ${cities} ${cities === 1 ? 'city' : 'cities'}` : ''}` : 'Follow to see their collection'}
            </div>
            <TradeRecord userId={collector.id} name={collector.display_name} compact />
          </div>
          <button onClick={toggle} disabled={busy}
            style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 700, padding: '8px 16px', borderRadius: 99, cursor: busy ? 'default' : 'pointer', border: following ? `1px solid ${C.border}` : 'none', background: following ? 'transparent' : C.dark, color: following ? C.sec : '#fff', opacity: busy ? 0.6 : 1 }}>
            {following ? 'Following' : 'Follow'}
          </button>
          {onBlock && (
            <button onClick={() => { setBlockErr(''); setConfirmBlock(true) }}
              style={{ flexShrink: 0, background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: '4px 2px', fontSize: 18, letterSpacing: '.5px' }}>···</button>
          )}
        </div>

        {rows === null ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: C.muted, fontSize: 13 }}>Loading…</div>
        ) : !following ? (
          <div style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
            <i className="ti ti-lock" style={{ fontSize: 34, color: C.borderStr }} />
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: '12px 0 6px' }}>Followers only</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Follow {collector.display_name} to see their ranked matchbooks.</div>
          </div>
        ) : ranked.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1.5rem', color: C.muted, fontSize: 13 }}>{collector.display_name} hasn't ranked anything yet.</div>
        ) : (
          <div>
            {ranked.map(item => (
              <div key={item.venue_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `0.5px solid ${C.border}` }}>
                <div style={rankCircle(item.rank)}>{item.rank}</div>
                {item.photo
                  ? <img src={item.photo} alt="" style={{ width: 42, height: 42, borderRadius: 11, objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 42, height: 42, borderRadius: 11, background: item.bg_color || C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0, letterSpacing: '-.2px' }}>{venueInitials(item.name)}</div>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{item.neighborhood || item.city}</div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.amber, flexShrink: 0 }}>{Number(item.score).toFixed(1)}</div>
              </div>
            ))}
            <div style={{ height: 24 }} />
          </div>
        )}
      </div>

      {/* Block — App Store 1.2 requires this, and the trade chat will rest on it */}
      {confirmBlock && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => !busy && setConfirmBlock(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Block {collector.display_name}?</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>
              You'll disappear from each other — no collections, no search, no following, either direction. They aren't told. You can undo this from your Profile.
            </div>
            {blockErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{blockErr}</div>}
            <button onClick={async () => {
              setBusy(true); setBlockErr('')
              const ok = await onBlock?.(collector.id)
              setBusy(false)
              if (ok === false) { setBlockErr('Couldn’t block them — try again.'); return }
              setConfirmBlock(false); onBack?.()
            }} disabled={busy}
              style={{ width: '100%', padding: 14, background: C.red, color: '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: busy ? 'default' : 'pointer', marginBottom: 8, opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Blocking…' : `Block ${collector.display_name}`}
            </button>
            <button onClick={() => setConfirmBlock(false)} disabled={busy} style={{ width: '100%', padding: 13, background: 'none', border: 'none', color: C.muted, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ADMIN: REPORTED PHOTOS QUEUE (spec §4/§5) ───────────
// Gated by profiles.is_admin. Accept → delete venue (FK cascade clears every
// collector's copy + score). Reject → mark resolved, venue untouched.
// Availability reports, grouped per spot, with the human-readable reason each
// collector gave. Two live reports of the same reason retire a venue (021), so
// this is where a wrong call gets caught — and reversed, which nothing else in
// the app can do.
function ClosureQueue({ groups, names, onResolve }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState('')
  const reasonLabel = (k) => REPORT_REASONS.find(r => r.key === k)?.title || 'No reason given (legacy)'

  const act = async (venueId, reopen) => {
    setBusy(venueId)
    setErr('')
    const ok = await onResolve?.(venueId, reopen)
    setBusy(null)
    if (ok === false) setErr('Couldn’t save that — try again.')
  }

  if (!groups.length) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>Nothing reported</div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>When collectors report a spot as out, discontinued, or closed, it lands here.</div>
      </div>
    )
  }

  return (
    <>
      {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{err}</div>}
      {groups.map(({ venue, rows }) => (
        <Card key={venue.id} style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: C.text, letterSpacing: '-.2px' }}>{venue.name}</span>
            {isRetired(venue)
              ? <Tag label={retiredLabel(venue)} bg={C.redBg} color={C.red} />
              : <Tag label="Still live" bg={C.greenBg} color={C.green} />}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>{venue.address || venue.city}</div>
          {rows.map(r => (
            <div key={r.id || `${r.user_id}-${r.venue_id}`} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 0', borderTop: `0.5px solid ${C.border}` }}>
              <i className="ti ti-point-filled" style={{ fontSize: 11, color: r.reason === 'closed_down' ? C.red : C.muted, flexShrink: 0 }} />
              <div style={{ fontSize: 12.5, color: C.sec, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 700, color: C.text }}>{reasonLabel(r.reason)}</span>
                {' — '}{names[r.user_id] || 'a collector'}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => act(venue.id, true)} disabled={busy === venue.id}
              style={{ flex: 1, padding: '10px', borderRadius: 11, border: 'none', background: C.green, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy === venue.id ? 0.6 : 1 }}>
              {isRetired(venue) ? 'Put it back on the map' : 'Dismiss — it’s fine'}
            </button>
            <button onClick={() => act(venue.id, false)} disabled={busy === venue.id}
              style={{ flex: 1, padding: '10px', borderRadius: 11, border: `1.5px solid ${C.border}`, background: 'transparent', color: C.sec, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy === venue.id ? 0.6 : 1 }}>
              Clear reports, leave as is
            </button>
          </div>
        </Card>
      ))}
    </>
  )
}

function AdminQueue({ reports, venues, closureReports = [], chatReports = [], onAccept, onReject, onResolveReports, onResolveChatReport, onBack }) {
  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))
  const [names, setNames] = useState({}) // user id → display_name (best-effort, admin read)
  const [busyId, setBusyId] = useState(null)
  const [actionErr, setActionErr] = useState('')
  const [adminTab, setAdminTab] = useState('photos') // photos | closures

  // Closure reports arrive one row per reporter — group by venue so you review
  // a SPOT ("2 people say it shut down"), not a stream of disconnected votes.
  const closureGroups = useMemo(() => {
    const byVenue = new Map()
    closureReports.forEach(r => {
      const v = r.venue || venueMap[r.venue_id]
      if (!v) return
      if (!byVenue.has(r.venue_id)) byVenue.set(r.venue_id, { venue: v, rows: [] })
      byVenue.get(r.venue_id).rows.push(r)
    })
    // Retired spots first (those are the ones a mistake actually hurts), then
    // the spots closest to the 2-report threshold.
    return [...byVenue.values()].sort((a, b) =>
      (isRetired(b.venue) ? 1 : 0) - (isRetired(a.venue) ? 1 : 0) || b.rows.length - a.rows.length)
  }, [closureReports, venues]) // eslint-disable-line react-hooks/exhaustive-deps

  // Venue comes from the embedded FK join (r.venue); fall back to the client
  // array. Never drop a report — keep the queue count in sync with the badge.
  const enriched = reports.map(r => ({ ...r, venue: r.venue || venueMap[r.venue_id] }))

  // Resolve submitter + reporter names (needs migration 008's admin-read on
  // profiles; degrades to "a collector" if absent).
  useEffect(() => {
    const ids = [...new Set([
      ...enriched.flatMap(r => [r.reporter_id, r.venue?.created_by]),
      ...closureReports.map(r => r.user_id), // closure reporters need names too
      ...chatReports.map(r => r.reporter_id),
    ].filter(Boolean))]
    if (!ids.length) return
    supabase.from('profiles').select('id, display_name').in('id', ids).then(({ data }) => {
      if (data) setNames(Object.fromEntries(data.map(p => [p.id, p.display_name])))
    })
    // closureReports must be a dep: the two queues load independently, so a
    // closures-only arrival would otherwise never re-run this and every closure
    // reporter would render as "a collector" for the whole session.
  }, [reports, closureReports, chatReports]) // eslint-disable-line react-hooks/exhaustive-deps

  const uname = (id) => (id && names[id]) ? names[id] : 'a collector'

  const accept = async (r) => { setBusyId(r.id); setActionErr(''); const ok = await onAccept(r.venue_id, r.id); setBusyId(null); if (ok === false) setActionErr('Couldn’t remove that venue — try again.') }
  const reject = async (r) => { setBusyId(r.id); setActionErr(''); const ok = await onReject(r.id); setBusyId(null); if (ok === false) setActionErr('Couldn’t reject that report — try again.') }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: C.bg }}>
      <SBar />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px 0', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: C.amber, fontSize: 13, fontWeight: 700 }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />Profile
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 24px' }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: '-.6px', marginTop: 6, marginBottom: 12 }}>Review</div>
        <div style={{ display: 'flex', borderBottom: `0.5px solid ${C.border}`, marginBottom: 16 }}>
          {[{ k: 'photos', l: 'Photos', n: enriched.length }, { k: 'closures', l: 'Closures', n: closureGroups.length }, { k: 'chats', l: 'Chats', n: chatReports.length }].map(t => (
            <div key={t.k} onClick={() => setAdminTab(t.k)}
              style={{ padding: '8px 14px 9px', fontSize: 14, fontWeight: adminTab === t.k ? 700 : 500, color: adminTab === t.k ? C.text : C.muted, cursor: 'pointer', borderBottom: adminTab === t.k ? `2px solid ${C.text}` : '2px solid transparent', marginBottom: -1 }}>
              {t.l}{t.n > 0 ? ` · ${t.n}` : ''}
            </div>
          ))}
        </div>
        {actionErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 14, lineHeight: 1.4 }}>{actionErr}</div>}

        {adminTab === 'chats' ? (
          chatReports.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No reported conversations</div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Trade-chat reports land here for review.</div>
            </div>
          ) : chatReports.map(r => (
            <Card key={r.id} style={{ padding: 13, marginBottom: 12 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, marginBottom: 2 }}>
                {uname(r.reporter_id)} reported {r.reported_name || 'a collector'}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8 }}>
                {r.chat_id ? `Trade chat #${r.chat_id}` : 'Chat no longer exists'} · {agoLabel(r.created_at)}
              </div>
              {r.detail && <div style={{ background: C.surface, borderRadius: 11, padding: '9px 12px', marginBottom: 10, fontSize: 12.5, color: C.sec, fontStyle: 'italic', lineHeight: 1.5 }}>“{r.detail}”</div>}
              <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
                Read the chat via SQL (trade_messages, chat_id {r.chat_id ?? '—'}). Heavy-handed tools if needed: block guidance, or account action.
              </div>
              <button onClick={() => onResolveChatReport?.(r.id)}
                style={{ width: '100%', padding: '10px', borderRadius: 11, border: `1.5px solid ${C.border}`, background: 'transparent', color: C.sec, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                Mark resolved
              </button>
            </Card>
          ))
        ) : adminTab === 'closures' ? (
          <ClosureQueue groups={closureGroups} names={names} onResolve={onResolveReports} />
        ) : enriched.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>Queue is clear</div>
            <div style={{ fontSize: 13, color: C.muted }}>No reported photos to review right now.</div>
          </div>
        ) : (
          <>
            {enriched.map(r => {
              const busy = busyId === r.id
              const v = r.venue
              return (
                <Card key={r.id} style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
                  <div style={{ height: 150, background: v?.bg_color || C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: 78, height: 78, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, color: 'rgba(255,255,255,0.92)', letterSpacing: '.5px' }}>
                      {v ? venueInitials(v.name) : '?'}
                    </div>
                  </div>
                  <div style={{ padding: '14px 16px 16px' }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: C.text, letterSpacing: '-.3px' }}>{v?.name || 'Unknown venue'}</div>
                    <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
                      Submitted by {uname(v?.created_by)}{v?.neighborhood ? ` · ${v.neighborhood}` : ''}
                    </div>
                    <div style={{ background: C.amberBg, borderRadius: 12, padding: '10px 12px', fontSize: 13, color: C.amber, lineHeight: 1.5, marginBottom: 14 }}>
                      Reported: {r.reason ? `"${r.reason}"` : '(no note)'} — {uname(r.reporter_id)}
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => accept(r)} disabled={busy} style={{ flex: 1, padding: 13, background: C.red, color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                        {busy ? '…' : 'Accept — remove'}
                      </button>
                      <button onClick={() => reject(r)} disabled={busy} style={{ flex: 1, padding: 13, background: C.card, color: C.text, border: `1.5px solid ${C.border}`, borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                        Reject
                      </button>
                    </div>
                  </div>
                </Card>
              )
            })}
            <div style={{ background: C.surface, borderRadius: 12, padding: '12px 14px', fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              Accepting deletes the venue. Every collector's "got it" and score for it disappears automatically — the existing FK cascade handles it, no extra code.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── AUTH SCREENS ────────────────────────────────────────
function AuthScreen({ onDone }) {
  const [mode, setMode] = useState('signup') // signup | login | reset
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const handleSubmit = async () => {
    setLoading(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'reset') {
        // Email a recovery link; returning to the app fires PASSWORD_RECOVERY.
        const redirectTo = (typeof window !== 'undefined' && window.location?.origin) || undefined
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
        if (error) throw error
        setNotice('If that email has an account, a reset link is on its way. Open it on this device.')
        setLoading(false)
        return
      }
      if (mode === 'signup') {
        const cleanName = name.trim()
        if (!cleanName) { setError('Please enter your name.'); setLoading(false); return }
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: cleanName } },
        })
        if (error) throw error
        // When email confirmation is required, signUp returns no session and the
        // user is NOT logged in yet. Don't drop them into the app on a null session.
        if (!data.session) {
          setNotice('Account created. Check your email to confirm, then sign in.')
          setMode('login')
          setPassword('')
          setLoading(false)
          return
        }
        onDone()
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onDone()
      }
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  const switchMode = (m) => { setMode(m); setError(''); setNotice('') }

  const inputStyle = {
    display: 'block', width: '100%', padding: '13px 14px',
    border: `1.5px solid rgba(255,255,255,0.14)`, borderRadius: 13,
    background: 'rgba(255,255,255,0.07)', color: '#fff', fontSize: 14,
    fontWeight: 500, marginBottom: 10, outline: 'none',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1A1918' }}>
      <div style={{ paddingTop: 'max(12px, env(safe-area-inset-top))', flexShrink: 0 }} />

      <div style={{ flex: 1, padding: '24px 24px 0', overflowY: 'auto' }}>
        <div style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <MbIcon size={60} />
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 24, fontWeight: 300, color: '#fff', letterSpacing: '-.4px' }}>phillumeni</div>
        </div>

        <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-.4px', marginBottom: 4 }}>
          {mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Welcome back'}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 22 }}>
          {mode === 'signup' ? 'Free forever. Start collecting.' : mode === 'reset' ? "We'll email you a link to set a new one." : 'Sign in to your collection.'}
        </div>

        {mode === 'signup' && (
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" maxLength={80} style={inputStyle} />
        )}
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" type="email" style={inputStyle} />
        {mode !== 'reset' && (
          <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" type="password" style={inputStyle} />
        )}

        {mode === 'login' && (
          <div style={{ textAlign: 'right', marginBottom: 4 }}>
            <span onClick={() => switchMode('reset')} style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', cursor: 'pointer' }}>Forgot password?</span>
          </div>
        )}

        {notice && <div style={{ color: '#6ACBAB', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>{notice}</div>}
        {error && <div style={{ color: '#F08080', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>{error}</div>}

        <button onClick={handleSubmit} disabled={loading || !email || (mode !== 'reset' && !password) || (mode === 'signup' && !name.trim())}
          style={{ width: '100%', padding: 15, background: loading ? 'rgba(200,123,10,0.5)' : '#C87B0A', color: '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: loading ? 'default' : 'pointer', letterSpacing: '-.2px', marginTop: 4, marginBottom: 14, boxShadow: '0 2px 12px rgba(200,123,10,0.35)' }}>
          {loading ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>

        <div style={{ textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.35)' }}>
          {mode === 'reset' ? (
            <span onClick={() => switchMode('login')} style={{ color: C.amber, cursor: 'pointer', fontWeight: 700 }}>Back to sign in</span>
          ) : (
            <>
              {mode === 'signup' ? 'Already have an account? ' : 'New here? '}
              <span onClick={() => switchMode(mode === 'signup' ? 'login' : 'signup')} style={{ color: C.amber, cursor: 'pointer', fontWeight: 700 }}>
                {mode === 'signup' ? 'Sign in' : 'Create account'}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── SET NEW PASSWORD (recovery) ─────────────────────────
// Shown after the user opens a password-reset link (App detects PASSWORD_RECOVERY
// and a temporary session is already active). updateUser sets the new password.
function ResetPassword({ onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (password.length < 6) { setError('Use at least 6 characters.'); return }
    if (password !== confirm) { setError('Those don’t match.'); return }
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) { setError(error.message); return }
    onDone()
  }

  const inputStyle = {
    display: 'block', width: '100%', padding: '13px 14px',
    border: `1.5px solid rgba(255,255,255,0.14)`, borderRadius: 13,
    background: 'rgba(255,255,255,0.07)', color: '#fff', fontSize: 14,
    fontWeight: 500, marginBottom: 10, outline: 'none',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1A1918' }}>
      <div style={{ paddingTop: 'max(12px, env(safe-area-inset-top))', flexShrink: 0 }} />
      <div style={{ flex: 1, padding: '24px 24px 0', overflowY: 'auto' }}>
        <div style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <MbIcon size={60} />
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 24, fontWeight: 300, color: '#fff', letterSpacing: '-.4px' }}>phillumeni</div>
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-.4px', marginBottom: 4 }}>Set a new password</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 22 }}>Almost there — choose a new password.</div>

        <input value={password} onChange={e => setPassword(e.target.value)} placeholder="New password" type="password" style={inputStyle} />
        <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Confirm new password" type="password" style={inputStyle} />

        {error && <div style={{ color: '#F08080', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>{error}</div>}

        <button onClick={submit} disabled={loading || !password || !confirm}
          style={{ width: '100%', padding: 15, background: loading ? 'rgba(200,123,10,0.5)' : '#C87B0A', color: '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: loading ? 'default' : 'pointer', letterSpacing: '-.2px', marginTop: 4, boxShadow: '0 2px 12px rgba(200,123,10,0.35)' }}>
          {loading ? 'Saving…' : 'Save password & sign in'}
        </button>

        <div style={{ textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.35)', marginTop: 16 }}>
          <span onClick={async () => { await supabase.auth.signOut(); onDone() }} style={{ color: C.amber, cursor: 'pointer', fontWeight: 700 }}>Cancel</span>
        </div>
      </div>
    </div>
  )
}

// ─── ADD YOUR NAME (existing-user migration) ─────────────
// One-time prompt for accounts created before real names existed (display_name
// blank or still equal to the old auto handle). Writes profiles.display_name so
// the name-search can find them. Not skippable — a name is now required to be a
// findable member, and it's a single field.
function NamePrompt({ user, onSaved }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const clean = name.trim()
    if (!clean) { setError('Please enter your name.'); return }
    setSaving(true)
    setError('')
    // profiles.display_name feeds the search/following RPCs; auth metadata is the
    // durable "has set a name" signal that stops this prompt re-appearing. Require
    // BOTH to land before dismissing, so a failed metadata write can't strand the
    // user in a re-prompt loop next login.
    const { error: e1 } = await supabase.from('profiles').update({ display_name: clean }).eq('id', user.id)
    if (e1) { setSaving(false); setError('Couldn’t save that — check your connection and try again.'); return }
    const { error: e2 } = await supabase.auth.updateUser({ data: { display_name: clean } })
    setSaving(false)
    if (e2) { setError('Couldn’t save that — check your connection and try again.'); return }
    onSaved(clean)
  }

  const inputStyle = {
    display: 'block', width: '100%', padding: '13px 14px',
    border: `1.5px solid rgba(255,255,255,0.14)`, borderRadius: 13,
    background: 'rgba(255,255,255,0.07)', color: '#fff', fontSize: 14,
    fontWeight: 500, marginBottom: 10, outline: 'none',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1A1918' }}>
      <div style={{ paddingTop: 'max(12px, env(safe-area-inset-top))', flexShrink: 0 }} />
      <div style={{ flex: 1, padding: '24px 24px 0', overflowY: 'auto' }}>
        <div style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <MbIcon size={60} />
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 24, fontWeight: 300, color: '#fff', letterSpacing: '-.4px' }}>phillumeni</div>
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-.4px', marginBottom: 4 }}>What's your name?</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 22, lineHeight: 1.5 }}>We switched from usernames to real names so friends can actually find you. This is how you'll show up.</div>

        <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" maxLength={80} autoFocus style={inputStyle}
          onKeyDown={e => { if (e.key === 'Enter') submit() }} />

        {error && <div style={{ color: '#F08080', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>{error}</div>}

        <button onClick={submit} disabled={saving || !name.trim()}
          style={{ width: '100%', padding: 15, background: saving ? 'rgba(200,123,10,0.5)' : '#C87B0A', color: '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: saving ? 'default' : 'pointer', letterSpacing: '-.2px', marginTop: 4, boxShadow: '0 2px 12px rgba(200,123,10,0.35)' }}>
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}

// ─── TAB BAR ─────────────────────────────────────────────
// ─── TRADES ──────────────────────────────────────────────
// Peer-to-peer matchbook exchange (docs/trades-spec.md). Identity is the real
// name — 017 removed usernames, so the spec's @handles are display names here.

const CANCEL_META = {
  mutual:       { icon: '🤝', label: 'Mutual cancel' },
  they_ghosted: { icon: '👻', label: 'Didn’t follow through' },
  i_backed_out: { icon: '🙋', label: 'Backed out' },
}

// A trader's record, shown wherever you're deciding whether to deal with them.
// The whole trust model: phillumeni can't enforce a trade, so it makes the
// history visible instead.
function TradeRecord({ userId, name, compact = false }) {
  const [rec, setRec] = useState(null)
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase.rpc('trade_record', { p_user: userId }).then(({ data, error }) => {
      if (!cancelled) setRec(error ? null : (data?.[0] || null)) // pre-023: no RPC, render nothing
    })
    return () => { cancelled = true }
  }, [userId])
  if (!rec) return null
  const entries = Array.isArray(rec.entries) ? rec.entries : []

  if (compact) {
    return (
      <span style={{ fontSize: 12, fontWeight: 700, color: rec.cancelled > 0 ? C.muted : C.green }}>
        ✓ {rec.completed} {rec.completed === 1 ? 'trade' : 'trades'}
        {rec.cancelled > 0 && <span style={{ color: C.red }}> · {rec.cancelled} cancelled</span>}
      </span>
    )
  }
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        <div style={{ background: C.greenBg, border: `1px solid ${C.green}33`, borderRadius: 12, padding: '10px', textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.green }}>{rec.completed}</div>
          <div style={{ fontSize: 9, color: C.green, marginTop: 1, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700 }}>Trades ✓</div>
        </div>
        <div style={{ background: rec.cancelled > 0 ? C.redBg : C.surface, border: `1px solid ${rec.cancelled > 0 ? C.red + '33' : 'transparent'}`, borderRadius: 12, padding: '10px', textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: rec.cancelled > 0 ? C.red : C.muted }}>{rec.cancelled}</div>
          <div style={{ fontSize: 9, color: rec.cancelled > 0 ? C.red : C.muted, marginTop: 1, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700 }}>Cancelled</div>
        </div>
      </div>
      {rec.cancelled === 0 && rec.completed > 0 && (
        <div style={{ background: C.greenBg, border: `1px solid ${C.green}33`, borderRadius: 12, padding: '11px 13px', marginBottom: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: C.green, marginBottom: 2 }}>✓ Perfect trade record</div>
          <div style={{ fontSize: 12, color: C.sec, lineHeight: 1.5 }}>{rec.completed} {rec.completed === 1 ? 'trade' : 'trades'}, no cancellations. Other collectors see this before accepting an offer.</div>
        </div>
      )}
      {/* What actually got traded — spec §4.9's chips, ~6 visible + overflow */}
      {Array.isArray(rec.chips) && rec.chips.length > 0 && (
        <div style={{ background: C.greenBg, border: `1px solid ${C.green}33`, borderRadius: 12, padding: '11px 13px', marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.green, letterSpacing: '.4px', marginBottom: 8 }}>{rec.completed} COMPLETED {rec.completed === 1 ? 'TRADE' : 'TRADES'}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {rec.chips.slice(0, 6).map((ch, i) => (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, background: C.card, borderRadius: 99, padding: '5px 11px', fontSize: 12.5, fontWeight: 700, color: C.text }}>
                <span>{ch.emoji}</span>{ch.name}
              </span>
            ))}
            {rec.chips.length > 6 && (
              <span style={{ background: C.card, borderRadius: 99, padding: '5px 11px', fontSize: 12.5, fontWeight: 700, color: C.muted }}>+{rec.chips.length - 6} more</span>
            )}
          </div>
        </div>
      )}
      {/* Blamed cancellations are the red mark; mutual cancels list neutrally —
          a red "CANCELLED · 2" over a "Perfect record" was reading as a bug. */}
      {(() => {
        const blamed = entries.filter(e => e.reason !== 'mutual')
        const mutual = entries.filter(e => e.reason === 'mutual')
        const row = (e, i, red) => {
          const m = CANCEL_META[e.reason] || {}
          return (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderTop: i ? `0.5px solid ${red ? C.red + '22' : C.border}` : 'none' }}>
              <span style={{ fontSize: 13 }}>{m.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                  {e.reason === 'they_ghosted' && e.by ? `Reported by ${e.by}` : m.label}
                </div>
                <div style={{ fontSize: 11.5, color: C.muted }}>
                  {e.reason === 'they_ghosted' ? m.label : e.reason === 'mutual' ? 'No blame either side' : 'Cancelled by them'}
                  {e.at ? ` · ${new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}
                </div>
              </div>
            </div>
          )
        }
        return (
          <>
            {blamed.length > 0 && (
              <div style={{ background: C.redBg, border: `1px solid ${C.red}22`, borderRadius: 12, padding: '11px 13px', marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.red, letterSpacing: '.4px', marginBottom: 8 }}>CANCELLED TRADES · {blamed.length}</div>
                {blamed.map((e, i) => row(e, i, true))}
              </div>
            )}
            {mutual.length > 0 && (
              <div style={{ background: C.surface, borderRadius: 12, padding: '11px 13px', marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, letterSpacing: '.4px', marginBottom: 8 }}>MUTUAL CANCELS · {mutual.length}</div>
                {mutual.map((e, i) => row(e, i, false))}
              </div>
            )}
          </>
        )
      })()}
    </>
  )
}

// Browse every listing, plus the trades you're already in. The city chips filter
// by the MATCHBOOK's city — what you're hunting, not where the trader lives.
function Trades({ user, onOffer, onOpenChat, onSeenOffers, onSheetOpenChange }) {
  const [tab, setTab] = useState('browse') // browse | mine
  const [allRows, setAllRows] = useState(null)
  const [city, setCity] = useState('')
  const [chats, setChats] = useState(null)
  const [withdrawing, setWithdrawing] = useState(null)

  // Fetch ONCE unfiltered; the city filter is client-side. Filtering server-side
  // derived the chips from the filtered set — pick a city and every other chip
  // vanished, including your way back to All.
  useEffect(() => {
    let cancelled = false
    setAllRows(null)
    supabase.rpc('browse_trades').then(({ data, error }) => {
      if (!cancelled) setAllRows(error ? [] : (data || []))
    })
    return () => { cancelled = true }
  }, [tab])

  useEffect(() => {
    let cancelled = false
    supabase.rpc('my_trades').then(({ data, error }) => {
      if (!cancelled) setChats(error ? [] : (data || []))
    })
    return () => { cancelled = true }
  }, [tab])

  // Your outgoing offers — the only place a declined offer is ever announced.
  // Opening the tab marks them seen, which clears them from the badge.
  const [myOffers, setMyOffers] = useState(null)
  useEffect(() => {
    if (tab !== 'mine') return
    let cancelled = false
    supabase.rpc('my_offers').then(({ data, error }) => {
      if (!cancelled) setMyOffers(error ? [] : (data || []))
      supabase.rpc('mark_offers_seen').then(() => onSeenOffers?.())
    })
    return () => { cancelled = true }
  }, [tab])

  const cities = useMemo(() => [...new Set((allRows || []).map(r => r.city).filter(Boolean))].sort(), [allRows])
  const rows = allRows === null ? null : allRows.filter(r => !city || r.city === city)
  const active = (chats || []).filter(c => c.status === 'active')

  const withdraw = async (r) => {
    setWithdrawing(r.listing_id)
    const { error } = await supabase.rpc('decline_offer', { p_offer_id: r.my_offer_id })
    if (!error) setAllRows(prev => (prev || []).map(x => (x.listing_id === r.listing_id ? { ...x, my_offer_id: null, offer_count: Math.max(0, x.offer_count - 1) } : x)))
    setWithdrawing(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
      <SBar />
      <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: '-.6px', marginBottom: 2 }}>Trades</div>
        <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>Swap matchbooks with other collectors. No addresses, ever.</div>
        <div style={{ display: 'flex', borderBottom: `0.5px solid ${C.border}` }}>
          {[{ k: 'browse', l: 'Browse' }, { k: 'mine', l: 'My trades', n: active.length }].map(t => (
            <div key={t.k} onClick={() => setTab(t.k)}
              style={{ padding: '8px 14px 9px', fontSize: 14, fontWeight: tab === t.k ? 700 : 500, color: tab === t.k ? C.text : C.muted, cursor: 'pointer', borderBottom: tab === t.k ? `2px solid ${C.text}` : '2px solid transparent', marginBottom: -1 }}>
              {t.l}{t.n > 0 ? ` · ${t.n}` : ''}
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'browse' ? (
          <>
            {cities.length > 0 && (
              <div style={{ display: 'flex', gap: 7, overflowX: 'auto', padding: '12px 16px 4px' }}>
                {[{ v: '', l: 'All' }, ...cities.map(c => ({ v: c, l: c }))].map(c => (
                  <button key={c.v} onClick={() => setCity(c.v)}
                    style={{ flexShrink: 0, padding: '7px 15px', borderRadius: 99, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: city === c.v ? 'none' : `1px solid ${C.border}`, background: city === c.v ? C.dark : 'transparent', color: city === c.v ? '#fff' : C.sec }}>
                    {c.l}
                  </button>
                ))}
              </div>
            )}
            {rows === null ? (
              <div style={{ textAlign: 'center', padding: '4rem 1.5rem', color: C.muted, fontSize: 13 }}>Loading…</div>
            ) : rows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🔄</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>Nothing up for trade yet</div>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>List one from your Collection — the For trade tab — and it shows up here for everyone.</div>
              </div>
            ) : (
              <div style={{ padding: '10px 16px 24px' }}>
                {rows.map(r => (
                  <Card key={r.listing_id} style={{ padding: 0, marginBottom: 12, overflow: 'hidden' }}>
                    <div style={{ position: 'relative', height: 150, background: r.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {(r.photo_url || r.cover_photo_url)
                        ? <img src={r.photo_url || r.cover_photo_url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : <span style={{ fontSize: 46 }}>{r.emoji}</span>}
                      {r.offer_count > 0 && (
                        <span style={{ position: 'absolute', top: 10, left: 10, background: C.amber, color: '#fff', fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 99 }}>
                          {r.offer_count} {r.offer_count === 1 ? 'offer' : 'offers'}
                        </span>
                      )}
                      <span style={{ position: 'absolute', top: 10, right: 10, background: r.photo_url ? 'rgba(0,0,0,0.7)' : C.surface, color: r.photo_url ? '#fff' : C.muted, fontSize: 10.5, fontWeight: 700, padding: '4px 9px', borderRadius: 99 }}>
                        {(r.photo_url || r.cover_photo_url) ? '📷 Photo' : 'No photo'}
                      </span>
                    </div>
                    <div style={{ padding: '12px 14px' }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, letterSpacing: '-.2px' }}>{r.venue_name}</div>
                      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>{[r.neighborhood, r.city].filter(Boolean).join(', ')}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        {r.owner_avatar
                          ? <img src={r.owner_avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                          : <Av ini={(r.owner_name || '?').slice(0, 2).toUpperCase()} bg={C.purpleBg} tc={C.purple} size={28} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.owner_name}</div>
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: C.green }}>✓ {r.owner_trades} {r.owner_trades === 1 ? 'trade' : 'trades'}</div>
                        </div>
                        {r.my_offer_id
                          ? <button onClick={() => withdraw(r)} disabled={withdrawing === r.listing_id}
                              style={{ flexShrink: 0, padding: '8px 14px', borderRadius: 99, border: `1.5px solid ${C.amberBd}`, background: C.amberBg, color: C.amber, fontSize: 11.5, fontWeight: 800, letterSpacing: '.3px', cursor: 'pointer', opacity: withdrawing === r.listing_id ? 0.6 : 1 }}>
                              {withdrawing === r.listing_id ? '…' : 'SENT · WITHDRAW'}
                            </button>
                          : <button onClick={() => onOffer?.(r)}
                              style={{ flexShrink: 0, padding: '9px 20px', borderRadius: 99, border: 'none', background: C.dark, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Offer</button>}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        ) : chats === null ? (
          <div style={{ textAlign: 'center', padding: '4rem 1.5rem', color: C.muted, fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={{ padding: '10px 16px 24px' }}>
            {chats.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2.5rem 1.5rem 1.5rem' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🤝</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No trades yet</div>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Make an offer on something in Browse. Once it's accepted, the chat opens here.</div>
              </div>
            )}
            {chats.map(c => (
              <div key={c.chat_id} onClick={() => onOpenChat?.(c)}
                style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '12px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer', opacity: c.status === 'active' ? 1 : 0.6 }}>
                {c.other_avatar
                  ? <img src={c.other_avatar} alt="" style={{ width: 42, height: 42, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <Av ini={(c.other_name || '?').slice(0, 2).toUpperCase()} bg={C.purpleBg} tc={C.purple} size={42} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.other_name || 'A departed collector'}</div>
                  <div style={{ fontSize: 12, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.listing_emoji} {c.listing_venue} ⇄ {(c.offered_names || []).join(' + ')}
                  </div>
                </div>
                {c.status === 'active'
                  ? (c.completed_by && c.completed_by !== user?.id
                      ? <Tag label="Confirm ✓" bg={C.greenBg} color={C.green} />
                      : <i className="ti ti-chevron-right" style={{ fontSize: 16, color: C.muted, flexShrink: 0 }} />)
                  : <Tag label={c.status === 'completed' ? 'Done ✓' : 'Cancelled'} bg={c.status === 'completed' ? C.greenBg : C.surface} color={c.status === 'completed' ? C.green : C.muted} />}
              </div>
            ))}

            {/* Outgoing offers — where "declined" finally gets said out loud */}
            {(myOffers || []).length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', padding: '18px 0 6px' }}>OFFERS YOU'VE MADE</div>
                {(myOffers || []).map(o => (
                  <div key={o.offer_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: `0.5px solid ${C.border}` }}>
                    <span style={{ fontSize: 18, flexShrink: 0 }}>{o.venue_emoji}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.venue_name}</div>
                      <div style={{ fontSize: 11.5, color: C.muted }}>to {o.owner_name} · {agoLabel(o.created_at)}</div>
                    </div>
                    <Tag
                      label={o.status === 'pending' ? 'Pending' : o.status === 'accepted' ? 'Accepted ✓' : o.status === 'withdrawn' ? 'Withdrawn' : 'Declined'}
                      bg={o.status === 'accepted' ? C.greenBg : o.status === 'pending' ? C.amberBg : C.surface}
                      color={o.status === 'accepted' ? C.green : o.status === 'pending' ? C.amber : C.muted}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Offer a bundle of your own matchbooks for one of theirs (spec §4.4).
function MakeOffer({ listing, collection, myListings, onSend, onBack }) {
  const [picked, setPicked] = useState([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sent, setSent] = useState(false)

  // Anything already committed to another trade can't be offered again — the
  // server rejects it too, but a greyed row explains why before you tap.
  const lockedIds = useMemo(
    () => new Set((myListings || []).filter(l => l.status === 'in_trade').map(l => l.venue_id)),
    [myListings]
  )
  const photoOf = (l) => (myListings || []).find(x => x.venue_id === l.venue_id)?.photo_url
  const mine = useMemo(
    () => (collection || []).filter(i => i.venue && !isKeepsake(i.venue)).sort((a, b) => a.venue.name.localeCompare(b.venue.name)),
    [collection]
  )
  const names = mine.filter(i => picked.includes(i.venue_id)).map(i => i.venue.name)

  const send = async () => {
    setBusy(true); setErr('')
    const res = await onSend?.(listing.listing_id, picked, note)
    setBusy(false)
    if (res?.error) { setErr(res.error); return }
    setSent(true)
  }

  if (sent) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <SBar title="Trades" />
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 64, margin: '30px 0 16px' }}>📮</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: '-.4px', marginBottom: 8 }}>Offer sent.</div>
          <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.7, marginBottom: 24 }}>
            <span style={{ fontWeight: 700, color: C.text }}>{listing.owner_name}</span> sees your offer alongside any others. If they pick yours, a private chat opens here.
          </div>
          <PrimaryBtn onClick={onBack}>Back to trades</PrimaryBtn>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SBar title="Trades" />
      <div style={{ padding: '10px 16px 0' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 13, color: C.amber, cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0 8px' }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Browse
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 24px' }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.5px', marginBottom: 12 }}>Offer a trade to {listing.owner_name}</div>

        <div style={{ borderRadius: 14, overflow: 'hidden', marginBottom: 18, border: `0.5px solid ${C.border}` }}>
          <div style={{ height: 110, background: listing.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {(listing.photo_url || listing.cover_photo_url)
              ? <img src={listing.photo_url || listing.cover_photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={{ fontSize: 40 }}>{listing.emoji}</span>}
          </div>
          <div style={{ background: C.surface, padding: '10px 13px' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.muted, letterSpacing: '.5px' }}>THEY'RE LISTING</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{listing.venue_name} · {listing.city}</div>
          </div>
        </div>

        <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, letterSpacing: '.5px', marginBottom: 8 }}>WHAT YOU'RE OFFERING — PICK ONE OR MORE</div>
        {mine.length === 0 && (
          <div style={{ background: C.surface, borderRadius: 12, padding: '14px', fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 14 }}>
            You need a matchbook in your collection before you can offer a trade.
          </div>
        )}
        {mine.map(i => {
          const on = picked.includes(i.venue_id)
          const locked = lockedIds.has(i.venue_id)
          const ph = photoOf(i)
          return (
            <button key={i.venue_id} disabled={locked}
              onClick={() => setPicked(p => (on ? p.filter(x => x !== i.venue_id) : [...p, i.venue_id]))}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', marginBottom: 9, textAlign: 'left', borderRadius: 14, cursor: locked ? 'default' : 'pointer', border: `1.5px solid ${on ? C.amberBd : C.border}`, background: on ? C.amberBg : C.card, opacity: locked ? 0.5 : 1 }}>
              {ph
                ? <img src={ph} alt="" style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
                : <div style={{ width: 44, height: 44, borderRadius: 10, background: i.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>{i.venue.emoji}</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.venue.name}</div>
                <div style={{ fontSize: 11.5, color: C.muted }}>
                  {[i.venue.neighborhood || i.venue.city, locked ? 'in an active trade' : (ph ? '📷 photo added' : 'no photo')].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, border: `1.5px solid ${on ? C.amber : C.borderStr}`, background: on ? C.amber : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {on && <i className="ti ti-check" style={{ fontSize: 13, color: '#fff' }} />}
              </div>
            </button>
          )
        })}

        <div style={{ background: picked.length ? C.amberBg : C.redBg, border: `1px solid ${picked.length ? C.amberBd : C.red + '44'}`, borderRadius: 12, padding: '11px 13px', margin: '4px 0 16px', fontSize: 13, fontWeight: 700, color: picked.length ? C.amber : C.red, lineHeight: 1.4 }}>
          {picked.length
            ? `Offering ${picked.length} ${picked.length === 1 ? 'matchbook' : 'matchbooks'}: ${names.join(' + ')}`
            : 'Pick at least one matchbook to offer'}
        </div>

        <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, letterSpacing: '.5px', marginBottom: 7 }}>NOTE (OPTIONAL)</div>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="e.g. both pristine — happy to sort logistics in chat"
          style={{ width: '100%', padding: 12, border: `1.5px solid ${C.border}`, borderRadius: 12, background: C.card, color: C.text, fontSize: 14, outline: 'none', resize: 'none', marginBottom: 14, fontFamily: 'inherit', lineHeight: 1.4 }} />

        <div style={{ background: C.greenBg, borderRadius: 12, padding: '11px 13px', fontSize: 12.5, color: C.sec, lineHeight: 1.5, marginBottom: 14 }}>
          <i className="ti ti-lock" style={{ fontSize: 12, marginRight: 6, color: C.green }} />
          If accepted, a private chat opens. phillumeni never touches what you share there.
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, lineHeight: 1.4 }}>{err}</div>}
        <PrimaryBtn onClick={send} disabled={!picked.length || busy}>{busy ? 'Sending…' : 'Send offer'}</PrimaryBtn>
      </div>
    </div>
  )
}

// Every pending offer on one of your listings, oldest first. Accepting one
// auto-declines the rest — that happens in the RPC, as one transaction.
function BidInbox({ listing, onAccept, onDecline, onBack }) {
  const [offers, setOffers] = useState(null)
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    supabase.rpc('listing_offers', { p_listing_id: listing.id }).then(({ data, error }) => {
      setOffers(error ? [] : (data || []))
    })
  }, [listing.id])
  useEffect(() => { load() }, [load])

  const act = async (o, accept) => {
    setBusy(o.offer_id); setErr('')
    const res = accept ? await onAccept?.(o) : await onDecline?.(o)
    setBusy(null)
    if (res?.error) { setErr(res.error); load(); return }
    if (!accept) load() // accept navigates into the chat; decline just refreshes
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SBar title="Trades" />
      <div style={{ padding: '10px 16px 0' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 13, color: C.amber, cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0 10px' }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Collection
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          {listing.photo_url
            ? <img src={listing.photo_url} alt="" style={{ width: 62, height: 62, borderRadius: 12, objectFit: 'cover', flexShrink: 0 }} />
            : <div style={{ width: 62, height: 62, borderRadius: 12, background: listing.venue?.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, flexShrink: 0 }}>{listing.venue?.emoji}</div>}
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px' }}>{listing.venue?.name}</div>
            <div style={{ fontSize: 12.5, color: C.muted }}>
              {listing.venue?.neighborhood || listing.venue?.city} · {(offers || []).length} {(offers || []).length === 1 ? 'offer' : 'offers'}
            </div>
          </div>
        </div>

        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{err}</div>}

        {offers === null ? (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', color: C.muted, fontSize: 13 }}>Loading…</div>
        ) : offers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>No offers yet</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>It's listed and visible to everyone. Offers land here.</div>
          </div>
        ) : offers.map(o => {
          const names = o.offered_names || []
          const emojis = o.offered_emojis || []
          const photos = o.offered_photos || [] // aligned with names; '' = no trade photo
          return (
            <Card key={o.offer_id} style={{ padding: 13, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
                {o.offerer_avatar
                  ? <img src={o.offerer_avatar} alt="" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  : <Av ini={(o.offerer_name || '?').slice(0, 2).toUpperCase()} bg={C.purpleBg} tc={C.purple} size={34} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text }}>{o.offerer_name}</div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: C.green }}>✓ {o.offerer_trades} {o.offerer_trades === 1 ? 'trade' : 'trades'}</div>
                </div>
                <div style={{ fontSize: 11.5, color: C.muted, flexShrink: 0 }}>{agoLabel(o.created_at)}</div>
              </div>

              {/* 1 or 2 get their own cards; 3+ collapse to a stack + a list,
                  per the spec's bundle display rules */}
              <div style={{ background: C.surface, borderRadius: 11, padding: '10px 12px', marginBottom: 9 }}>
                {names.length <= 2 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {names.map((n, i) => (
                      <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {i > 0 && <span style={{ color: C.amber, fontWeight: 800, marginRight: 2 }}>+</span>}
                        {photos[i]
                          ? <img src={photos[i]} alt="" loading="lazy" style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'cover' }} />
                          : <span style={{ fontSize: 17 }}>{emojis[i]}</span>}
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{n}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div style={{ display: 'flex', flexShrink: 0 }}>
                      {emojis.slice(0, 3).map((e, i) => (
                        <span key={i} style={{ fontSize: 16, marginLeft: i ? -6 : 0, background: C.card, borderRadius: '50%', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.border}` }}>{e}</span>
                      ))}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.4 }}>{names.join(' + ')}</div>
                  </div>
                )}
              </div>

              {o.note && (
                <div style={{ background: C.surface, borderRadius: 11, padding: '9px 12px', marginBottom: 10, fontSize: 12.5, color: C.sec, fontStyle: 'italic', lineHeight: 1.5 }}>“{o.note}”</div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => act(o, true)} disabled={busy === o.offer_id}
                  style={{ flex: 2, padding: '12px', borderRadius: 12, border: 'none', background: C.dark, color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: busy === o.offer_id ? 0.6 : 1 }}>
                  Accept → chat
                </button>
                <button onClick={() => act(o, false)} disabled={busy === o.offer_id}
                  style={{ flex: 1, padding: '12px', borderRadius: 12, border: `1.5px solid ${C.border}`, background: 'transparent', color: C.muted, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: busy === o.offer_id ? 0.6 : 1 }}>
                  Decline
                </button>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// The private half of a trade. phillumeni doesn't moderate what's said here —
// which is exactly why block (022) had to exist before this shipped.
function TradeChat({ chat, user, onComplete, onCancel, onBlock, onBack }) {
  const [msgs, setMsgs] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [menu, setMenu] = useState(false)
  const [cancelSheet, setCancelSheet] = useState(false)
  const [recap, setRecap] = useState(false)        // shown to whoever's tap completes it
  const [reportSheet, setReportSheet] = useState(false)
  const [reportText, setReportText] = useState('')
  const [reportDone, setReportDone] = useState(false)
  const [status, setStatus] = useState(chat.status)
  const [completedBy, setCompletedBy] = useState(chat.completed_by)
  const [mutualBy, setMutualBy] = useState(chat.mutual_requested_by || null)
  const endRef = useRef(null)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('trade_messages').select('*').eq('chat_id', chat.chat_id).order('created_at')
    if (!error) setMsgs(data || [])
    const { data: c } = await supabase.from('trade_chats').select('status, completed_by, mutual_requested_by').eq('id', chat.chat_id).maybeSingle()
    if (c) { setStatus(c.status); setCompletedBy(c.completed_by); setMutualBy(c.mutual_requested_by) }
  }, [chat.chat_id])
  useEffect(() => { load() }, [load])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [msgs])

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setText(''); setErr('')
    const { error } = await supabase.from('trade_messages').insert({ chat_id: chat.chat_id, sender_id: user.id, content: body })
    if (error) {
      // The usual cause isn't the network — it's the other party having closed
      // the trade. Re-sync so the archived banner appears instead of a
      // permanently "active" chat where every send fails generically.
      setErr('Couldn’t send that.'); setText(body); load(); return
    }
    load()
  }
  const complete = async () => {
    setBusy(true); setErr('')
    const res = await onComplete?.(chat.chat_id)
    setBusy(false)
    if (res?.error) { setErr(res.error); return }
    if (res?.data === 'completed') setRecap(true) // spec §4.7: recap on completion
    load()
  }

  const sendReport = async () => {
    setBusy(true); setErr('')
    const { error } = await supabase.from('chat_reports').insert({
      reporter_id: user.id, reported_id: chat.other_id, reported_name: chat.other_name,
      chat_id: chat.chat_id, detail: reportText.trim() || null,
    })
    setBusy(false)
    if (error) { setErr('Couldn’t send that report — try again.'); return }
    setReportDone(true)
  }
  const doCancel = async (reason) => {
    setBusy(true); setErr('')
    const res = await onCancel?.(chat.chat_id, reason)
    setBusy(false); setCancelSheet(false)
    if (res?.error) { setErr(res.error); return }
    load()
  }

  const closed = status !== 'active'
  const iConfirmed = completedBy === user?.id
  const theyConfirmed = completedBy && completedBy !== user?.id

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative', background: C.bg }}>
      <div style={{ background: C.dark, padding: '10px 16px 12px', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', fontSize: 12.5, color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontWeight: 700, padding: '2px 0 8px' }}>‹ Trades</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          {chat.other_avatar
            ? <img src={chat.other_avatar} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
            : <Av ini={(chat.other_name || '?').slice(0, 2).toUpperCase()} bg={C.purpleBg} tc={C.purple} size={40} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{chat.other_name}</div>
            <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>✓ {chat.other_trades} {chat.other_trades === 1 ? 'trade' : 'trades'}</div>
          </div>
          <button onClick={() => setMenu(true)} style={{ flexShrink: 0, width: 34, height: 34, borderRadius: '50%', background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', fontSize: 16, cursor: 'pointer', letterSpacing: '.5px' }}>···</button>
        </div>
      </div>

      {/* What's actually being swapped, pinned so neither side forgets the deal */}
      <div style={{ background: '#111', padding: '9px 16px', flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>
          {chat.listing_emoji} {chat.listing_venue} ⇄ {(chat.offered_names || []).join(' + ')}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
        <div style={{ textAlign: 'center', fontSize: 12, color: C.muted, marginBottom: 14 }}>Trade accepted · Chat unlocked</div>
        {(msgs || []).map(m => (
          m.kind === 'system' ? (
            <div key={m.id} style={{ textAlign: 'center', fontSize: 12, color: C.muted, margin: '12px 0', fontStyle: 'italic' }}>{m.content}</div>
          ) : (
            <div key={m.id} style={{ display: 'flex', justifyContent: m.sender_id === user?.id ? 'flex-end' : 'flex-start', marginBottom: 9 }}>
              <div style={{ maxWidth: '78%', padding: '9px 13px', borderRadius: 16, fontSize: 14, lineHeight: 1.4, background: m.sender_id === user?.id ? C.dark : C.surface, color: m.sender_id === user?.id ? '#fff' : C.text }}>
                {m.content}
              </div>
            </div>
          )
        ))}
        <div ref={endRef} />
      </div>

      {err && <div style={{ fontSize: 12, color: C.red, padding: '0 16px 6px', lineHeight: 1.4 }}>{err}</div>}

      {closed ? (
        <div style={{ padding: '14px 16px', textAlign: 'center', fontSize: 13, color: C.muted, background: C.surface, flexShrink: 0 }}>
          {status === 'completed' ? 'Trade complete — this chat is archived.' : 'Trade cancelled — this chat is archived.'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, padding: '10px 16px', flexShrink: 0, borderTop: `0.5px solid ${C.border}` }}>
            <input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Message…"
              style={{ flex: 1, padding: '11px 14px', border: `1.5px solid ${C.border}`, borderRadius: 99, background: C.card, color: C.text, fontSize: 14, outline: 'none' }} />
            <button onClick={send} disabled={!text.trim()} style={{ flexShrink: 0, width: 42, height: 42, borderRadius: '50%', border: 'none', background: text.trim() ? C.dark : C.border, color: '#fff', cursor: 'pointer' }}>
              <i className="ti ti-arrow-up" style={{ fontSize: 17 }} />
            </button>
          </div>
          <button onClick={complete} disabled={busy || iConfirmed}
            style={{ width: '100%', padding: 16, border: 'none', background: iConfirmed ? C.surface : C.green, color: iConfirmed ? C.muted : '#fff', fontSize: 15, fontWeight: 700, cursor: iConfirmed ? 'default' : 'pointer', flexShrink: 0 }}>
            {iConfirmed ? `Waiting for ${chat.other_name} to confirm…` : theyConfirmed ? `${chat.other_name} marked it done — confirm ✓` : 'Mark trade complete ✓'}
          </button>
        </>
      )}

      {menu && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => setMenu(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            {!closed && (
              <button onClick={() => { setMenu(false); setCancelSheet(true) }} style={{ width: '100%', padding: 14, marginBottom: 8, border: `1.5px solid ${C.border}`, borderRadius: 14, background: C.card, color: C.text, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Cancel this trade</button>
            )}
            <button onClick={() => { setMenu(false); setReportText(''); setReportDone(false); setReportSheet(true) }}
              style={{ width: '100%', padding: 14, marginBottom: 8, border: `1.5px solid ${C.border}`, borderRadius: 14, background: C.card, color: C.text, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Report this conversation</button>
            <button onClick={async () => { setMenu(false); const ok = await onBlock?.(chat.other_id); if (ok !== false) onBack?.() }}
              style={{ width: '100%', padding: 14, marginBottom: 8, border: `1.5px solid ${C.red}44`, borderRadius: 14, background: C.redBg, color: C.red, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Block {chat.other_name}</button>
            <button onClick={() => setMenu(false)} style={{ width: '100%', padding: 13, background: 'none', border: 'none', color: C.muted, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Close</button>
          </div>
        </div>
      )}

      {cancelSheet && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => !busy && setCancelSheet(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', maxHeight: '88%', overflowY: 'auto' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Cancel this trade?</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>Pick the reason — it's logged on the relevant profile so the community knows.</div>
            {[
              // Mutual takes BOTH parties now (024) — a unilateral "mutual" was
              // just backing out with the blame filed off.
              mutualBy && mutualBy !== user?.id
                ? { k: 'mutual', t: `Agree — cancel with no blame`, s: `${chat.other_name} proposed a mutual cancel. Agreeing closes the trade with no record against either of you.` }
                : mutualBy === user?.id
                ? { k: 'mutual', t: 'Mutual cancel proposed', s: `Waiting for ${chat.other_name} to agree. No record either way until they do.` }
                : { k: 'mutual', t: 'Propose a mutual cancel', s: `Closes with no record — once ${chat.other_name} agrees.` },
              { k: 'they_ghosted', t: 'They didn’t follow through', s: `Agreed then went quiet. Logged on ${chat.other_name}'s profile.` },
              { k: 'i_backed_out', t: 'I’m backing out', s: 'You’re cancelling. Logged on your own profile.' },
            ].map(o => (
              <button key={o.k} onClick={() => doCancel(o.k)} disabled={busy}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 13, padding: '13px', marginBottom: 9, textAlign: 'left', border: `1.5px solid ${C.border}`, borderRadius: 14, background: C.card, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
                <div style={{ width: 40, height: 40, borderRadius: 11, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>{CANCEL_META[o.k].icon}</div>
                <div>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text }}>{o.t}</div>
                  <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>{o.s}</div>
                </div>
              </button>
            ))}
            <button onClick={() => setCancelSheet(false)} disabled={busy} style={{ width: '100%', padding: 13, background: 'none', border: 'none', color: C.muted, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Keep this trade open</button>
          </div>
        </div>
      )}

      {/* Recap (spec §4.7) — both matchbooks, both names, the date. */}
      {recap && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: C.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
          <div style={{ fontSize: 60, marginBottom: 14 }}>🤝</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: C.text, letterSpacing: '-.5px', marginBottom: 8 }}>Trade complete.</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            {chat.listing_emoji} {chat.listing_venue} ⇄ {(chat.offered_names || []).join(' + ')}
          </div>
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 6 }}>
            You and {chat.other_name || 'a fellow collector'} · {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </div>
          <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 22 }}>
            It's on both your trade records. The matchbooks are in your hands now — add yours to your collection whenever.
          </div>
          <PrimaryBtn onClick={() => setRecap(false)} style={{ maxWidth: 300 }}>Done</PrimaryBtn>
        </div>
      )}

      {/* Report → chat_reports → the admin queue. Its own table on purpose:
          fake_reports' Accept action deletes the VENUE. */}
      {reportSheet && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => !busy && setReportSheet(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            {reportDone ? (
              <>
                <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Report sent.</div>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>A person reviews every report. If you don't want to hear from {chat.other_name} at all, blocking them also ends this trade.</div>
                <PrimaryBtn onClick={() => setReportSheet(false)}>Done</PrimaryBtn>
              </>
            ) : (
              <>
                <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Report this conversation?</div>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 14 }}>Goes to a human, with the chat attached. {chat.other_name} isn't told.</div>
                <textarea value={reportText} onChange={e => setReportText(e.target.value)} rows={3} placeholder="What happened? (optional)"
                  style={{ width: '100%', padding: 12, border: `1.5px solid ${C.border}`, borderRadius: 12, background: C.card, color: C.text, fontSize: 14, outline: 'none', resize: 'none', marginBottom: 12, fontFamily: 'inherit', lineHeight: 1.4 }} />
                {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10, lineHeight: 1.4 }}>{err}</div>}
                <PrimaryBtn onClick={sendReport} disabled={busy}>{busy ? 'Sending…' : 'Send report'}</PrimaryBtn>
                <button onClick={() => setReportSheet(false)} disabled={busy} style={{ width: '100%', padding: 12, marginTop: 6, background: 'none', border: 'none', color: C.muted, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Never mind</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TabBar({ active, onNav, tradeBadge = 0 }) {
  const tabs = [
    { id: 'explore', icon: 'ti-map', l: 'Explore' },
    { id: 'rankings', icon: 'ti-trophy', l: 'Rankings' },
    { id: 'collection', icon: 'ti-stack-2', l: 'Collection' },
    { id: 'trades', icon: 'ti-arrows-exchange', l: 'Trades', badge: tradeBadge },
    { id: 'profile', icon: 'ti-user', l: 'Profile' },
  ]
  return (
    <div style={{ borderTop: `0.5px solid ${C.border}`, display: 'flex', padding: '9px 0 max(14px, env(safe-area-inset-bottom))', flexShrink: 0, background: C.card }}>
      {tabs.map(t => (
        <div key={t.id} onClick={() => onNav(t.id)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
          <div style={{ width: 30, height: 28, borderRadius: 8, background: active === t.id ? C.amberBg : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background .15s', position: 'relative' }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 20, color: active === t.id ? C.amber : C.muted, transition: 'color .15s' }} />
            {/* Offers/chats waiting on you. Push isn't built, so the badge IS the
                notification — it's the only way an offer finds you. */}
            {t.badge > 0 && (
              <span style={{ position: 'absolute', top: -2, right: -4, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: C.red, color: '#fff', fontSize: 9.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1.5px solid ${C.card}` }}>
                {t.badge > 9 ? '9+' : t.badge}
              </span>
            )}
          </div>
          <span style={{ fontSize: 10, fontWeight: active === t.id ? 700 : 500, color: active === t.id ? C.amber : C.muted, letterSpacing: active === t.id ? '-.1px' : 0 }}>{t.l}</span>
        </div>
      ))}
    </div>
  )
}

// ─── MAIN APP ────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [tab, setTab] = useState('explore')
  const [venues, setVenues] = useState([])
  const [collection, setCollection] = useState([]) // { id, user_id, venue_id, collected_at, venue }
  const [reported, setReported] = useState([]) // { id, venue_id }
  const [showSubmit, setShowSubmit] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(false) // arrived via a password-reset link
  const [venuesError, setVenuesError] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [myAvatar, setMyAvatar] = useState(null)
  const [myName, setMyName] = useState(null) // profiles.display_name — the user's real name
  const [showNamePrompt, setShowNamePrompt] = useState(false) // existing user with no real name yet
  const [fakeReports, setFakeReports] = useState([]) // pending fake_reports (admin only)
  const [closureReports, setClosureReports] = useState([]) // live availability reports (admin only)
  const [showAdmin, setShowAdmin] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showFind, setShowFind] = useState(false)
  const [viewingCollector, setViewingCollector] = useState(null) // { id, display_name, avatar_url, isFollowing }
  const [reRankTarget, setReRankTarget] = useState(null) // { venue, photo, score } — re-ranking a spot via head-to-heads
  const [following, setFollowing] = useState([]) // [{ id, display_name, avatar_url, matchbooks }]
  const [blocked, setBlocked] = useState([])     // [{ id, display_name, avatar_url }] — 022
  // Trades (023)
  const [myListings, setMyListings] = useState([])   // my trade_listings rows
  const [offerCounts, setOfferCounts] = useState({}) // listing_id → pending offers
  const [tradeBadge, setTradeBadge] = useState(0)    // offers + chats needing me
  const [offerTarget, setOfferTarget] = useState(null) // browse row → Make offer
  const [offersFor, setOffersFor] = useState(null)     // my listing → bid inbox
  const [openChat, setOpenChat] = useState(null)       // my_trades row → chat
  const [sheetOpen, setSheetOpen] = useState(false) // a bottom sheet is open → hide TabBar

  // Auth state
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user)
      setAuthLoading(false)
      if (!user) setShowAuth(true)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // Only swap the user object when the identity actually changes, so token
      // refreshes / focus events don't re-fire every [user]-keyed load + clobber
      // optimistic local state.
      setUser(prev => (prev?.id === session?.user?.id ? prev : (session?.user || null)))
      if (!session?.user) setShowAuth(true)
      // Opened a reset link → show the "set new password" screen before the app.
      if (event === 'PASSWORD_RECOVERY') { setRecoveryMode(true); setShowAuth(false) }
    })

    return () => subscription.unsubscribe()
  }, [])

  // Capture an inbound invite link (?invite=<user.id>) once, stash it, and clean
  // the URL so it isn't re-shared. Attribution happens after the user authenticates.
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get('invite')
      if (ref) {
        localStorage.setItem('phillumeni_ref', ref)
        window.history.replaceState({}, '', window.location.pathname)
      }
    } catch { /* no URL/storage access — skip */ }
  }, [])

  // Once authenticated, attribute the referral exactly once (only while
  // referred_by is null, never self-referral). Tolerates the column being
  // unmigrated and clears the pending ref only on a clean write.
  useEffect(() => {
    if (!user) return
    let ref = null
    try { ref = localStorage.getItem('phillumeni_ref') } catch { /* no storage */ }
    if (!ref) return
    const clear = () => { try { localStorage.removeItem('phillumeni_ref') } catch {} }
    if (ref === user.id) { clear(); return } // no self-referral
    // Attribute once (only while null). Clear on success OR if the column isn't
    // migrated (can't record it — stop retrying every login). Keep on transient.
    supabase.from('profiles').update({ referred_by: ref }).eq('id', user.id).is('referred_by', null)
      .then(({ error }) => { if (!error || isMissingColumn(error)) clear() })
  }, [user])

  // Load venues (retryable; surfaces errors instead of silently showing "no spots")
  const loadVenues = useCallback(() => {
    setVenuesError(false)
    supabase.from('venues').select('*').order('name').then(({ data, error }) => {
      if (error) { console.error('Failed to load venues', error); setVenuesError(true); return }
      setVenues(data || [])
    })
  }, [])

  useEffect(() => { loadVenues() }, [loadVenues])

  // Load collection
  useEffect(() => {
    if (!user) return
    supabase
      .from('collections')
      .select('*')
      .eq('user_id', user.id)
      .order('collected_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) { console.error('Failed to load collection', error); return }
        setCollection(data || [])
      })
  }, [user])

  // Load this user's reports so flagged venues stay hidden across reloads.
  // LIVE rows only: a repost (or an admin reopen) supersedes the old reports,
  // and the spot has to come back for the person who reported it too — otherwise
  // it's back for everyone except the one collector who'd most like to know.
  // Only the retiring reasons hide a pin, matching handleFlag.
  useEffect(() => {
    if (!user) { setReported([]); return }
    let cancelled = false
    const run = async () => {
      let { data, error } = await supabase
        .from('reports').select('venue_id, reason')
        .eq('user_id', user.id).is('superseded_at', null)
        .in('reason', ['closed_down', 'discontinued'])
      // pre-021 DBs have neither column — fall back to the old "any report hides it"
      if (error && isMissingColumn(error)) {
        ;({ data, error } = await supabase.from('reports').select('venue_id').eq('user_id', user.id))
      }
      if (cancelled) return
      if (error) { console.error('Failed to load reports', error); return }
      setReported(data || [])
    }
    run()
    return () => { cancelled = true }
  }, [user])

  // Load my profile flags (admin + avatar). Own profile is readable under the
  // owner-only SELECT policy. Tolerates avatar_url being unmigrated (pre-015).
  useEffect(() => {
    if (!user) { setIsAdmin(false); setMyAvatar(null); setMyName(null); return }
    // Existing users predate real names: they signed up before the name field, so
    // their auth metadata has no display_name (the old form set `username`). New
    // signups always carry display_name in metadata — so this targets ONLY legacy
    // accounts and never false-prompts a new user whose name happens to match
    // their email local part. NamePrompt writes display_name into metadata, so it
    // clears for good on the next login.
    if (!(user.user_metadata?.display_name || '').trim()) setShowNamePrompt(true)
    let cancelled = false
    ;(async () => {
      let { data, error } = await supabase.from('profiles').select('is_admin, avatar_url, display_name').eq('id', user.id).maybeSingle()
      if (error && isMissingColumn(error)) {
        ;({ data, error } = await supabase.from('profiles').select('is_admin, display_name').eq('id', user.id).maybeSingle())
      }
      if (cancelled || error) return
      setIsAdmin(!!data?.is_admin)
      setMyAvatar(data?.avatar_url || null)
      setMyName((data?.display_name || '').trim() || null)
    })()
    return () => { cancelled = true }
  }, [user])

  // Load the pending fake-report queue (RLS returns rows only to admins). The
  // venue is embedded via the FK join so a report is never dropped just because
  // its venue isn't in the client `venues` array (keeps badge + queue in sync).
  const loadFakeReports = useCallback(() => {
    if (!user) return
    supabase.from('fake_reports').select('*, venue:venues(*)').eq('status', 'pending')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) { console.error('Failed to load fake reports', error); return }
        setFakeReports(data || [])
      })
  }, [user])

  useEffect(() => { if (isAdmin) loadFakeReports() }, [isAdmin, loadFakeReports])

  // Closure reports (021 gave admins a read on `reports` — before that nobody
  // could see these, and they retired venues with no human in the loop).
  // Live rows only: superseded ones were already resolved or overtaken by a repost.
  const loadClosureReports = useCallback(() => {
    if (!user) return
    supabase.from('reports').select('*, venue:venues(*)').is('superseded_at', null)
      .then(({ data, error }) => {
        // pre-021 the column doesn't exist and admins have no read — stay empty
        if (error) { setClosureReports([]); return }
        setClosureReports(data || [])
      })
  }, [user])

  useEffect(() => { if (isAdmin) loadClosureReports() }, [isAdmin, loadClosureReports])

  // Trade-chat reports (024) — human review for conversations, admin-read RLS.
  const [chatReports, setChatReports] = useState([])
  const loadChatReports = useCallback(() => {
    if (!user) return
    supabase.from('chat_reports').select('*').eq('status', 'pending').order('created_at')
      .then(({ data, error }) => setChatReports(error ? [] : (data || []))) // pre-024: table absent → empty
  }, [user])
  useEffect(() => { if (isAdmin) loadChatReports() }, [isAdmin, loadChatReports])
  const handleResolveChatReport = async (id) => {
    const { error } = await supabase.from('chat_reports').update({ status: 'resolved' }).eq('id', id)
    if (error) { console.error('Resolve chat report failed', error); return false }
    setChatReports(prev => prev.filter(r => r.id !== id))
    return true
  }

  // Admin picks a venue's cover photo from the community gallery (025). The RPC
  // refuses URLs that weren't actually submitted for that venue.
  const handleSetCover = async (venueId, url) => {
    const { error } = await supabase.rpc('set_venue_cover', { p_venue_id: venueId, p_url: url })
    if (error) { console.error('Set cover failed', error); return false }
    setVenues(prev => prev.map(v => (v.id === venueId ? { ...v, cover_photo_url: url } : v)))
    return true
  }

  // Admin override: clear a venue's live reports, optionally putting it back on
  // the map (venues has no UPDATE policy at all, so this must go through the RPC).
  const handleResolveReports = async (venueId, reopen) => {
    const { error } = await supabase.rpc('admin_resolve_reports', { p_venue_id: venueId, p_reopen: reopen })
    if (error) { console.error('Resolve reports failed', error); return false }
    setClosureReports(prev => prev.filter(r => r.venue_id !== venueId))
    if (reopen) setVenues(prev => prev.map(v => (v.id === venueId ? { ...v, status: 'active', closed_at: null } : v)))
    return true
  }

  // Follow graph — who I follow (via SECURITY DEFINER RPC; profiles are locked down)
  const loadFollowing = useCallback(() => {
    if (!user) return
    supabase.rpc('following_list').then(({ data, error }) => {
      if (!error) setFollowing(data || [])
    })
  }, [user])

  useEffect(() => { if (user) loadFollowing() }, [user, loadFollowing])

  const handleFollow = async (userId) => {
    if (!user) return false
    const { error } = await supabase.from('follows').insert({ follower_id: user.id, following_id: userId })
    if (error && error.code !== '23505') { console.error('Follow failed', error); return false }
    loadFollowing()
    return true
  }
  const handleUnfollow = async (userId) => {
    if (!user) return false
    const { error } = await supabase.from('follows').delete().eq('follower_id', user.id).eq('following_id', userId)
    if (error) { console.error('Unfollow failed', error); return false }
    setFollowing(prev => prev.filter(f => f.id !== userId))
    return true
  }

  // Block (022). Goes through the RPC because a client can only delete its OWN
  // follow row — severing THEIR follow of you needs definer rights, and a block
  // that leaves them following you isn't a block.
  const handleBlock = async (userId) => {
    if (!user) return false
    const { error } = await supabase.rpc('block_user', { target: userId })
    if (error) { console.error('Block failed', error); return false }
    setFollowing(prev => prev.filter(f => f.id !== userId))
    loadBlocked()
    return true
  }
  const handleUnblock = async (userId) => {
    if (!user) return false
    const { error } = await supabase.from('blocks').delete().eq('blocker_id', user.id).eq('blocked_id', userId)
    if (error) { console.error('Unblock failed', error); return false }
    setBlocked(prev => prev.filter(b => b.id !== userId))
    return true
  }

  // ─── Trades (023) ──────────────────────────────────────
  const refreshTrades = useCallback(async () => {
    if (!user) { setMyListings([]); setOfferCounts({}); setTradeBadge(0); return }
    const [{ data: listings }, { data: counts }, { data: chats }, { data: outgoing }] = await Promise.all([
      supabase.from('trade_listings').select('*').eq('user_id', user.id).neq('status', 'removed'),
      supabase.rpc('my_listing_offer_counts'),
      supabase.rpc('my_trades'),
      supabase.rpc('my_offers'),
    ])
    setMyListings(listings || [])                       // pre-023: tables absent → null → []
    setOfferCounts(Object.fromEntries((counts || []).map(c => [c.listing_id, c.pending])))
    // The badge IS the notification — push isn't built, so an offer, a fresh
    // accept, a decline, or a waiting confirmation has no other way to find you.
    const pending = (counts || []).reduce((n, c) => n + c.pending, 0)
    const waiting = (chats || []).filter(c => c.status === 'active' && c.completed_by && c.completed_by !== user.id).length
    const freshAccepts = (chats || []).filter(c => c.status === 'active' && !c.is_mine && c.my_msgs === 0).length
    const unseenDeclines = (outgoing || []).filter(o => o.status === 'declined' && !o.seen).length
    setTradeBadge(pending + waiting + freshAccepts + unseenDeclines)
  }, [user])
  useEffect(() => { refreshTrades() }, [refreshTrades])
  // Keep it honest during a session: re-check on a slow tick and whenever the
  // app regains focus (same signal the SW-update check uses).
  useEffect(() => {
    const t = setInterval(refreshTrades, 60000)
    const onVis = () => document.visibilityState === 'visible' && refreshTrades()
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [refreshTrades])

  // List / unlist a matchbook. Both go through RPCs (024): a raw upsert could
  // flip an in_trade listing back to active — two live trades, one matchbook.
  const handleToggleTrade = async (item, list) => {
    if (!user) return false
    if (list) {
      const { error } = await supabase.rpc('list_for_trade', { p_venue_id: item.venue_id })
      if (error) { console.error('List failed', error); return false }
    } else {
      const existing = myListings.find(l => l.venue_id === item.venue_id)
      if (!existing) return true
      const { error } = await supabase.rpc('remove_listing', { p_listing_id: existing.id })
      if (error) { console.error('Unlist failed', error); return false }
    }
    refreshTrades()
    return true
  }

  const handleListingPhoto = async (listing, file) => {
    if (!user || !listing) return false
    try {
      const blob = await downscaleImage(file, 1600, 0.8)
      const path = `${user.id}/${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage.from('matchbooks').upload(path, blob, { contentType: 'image/jpeg', upsert: false })
      if (upErr) throw upErr
      const url = supabase.storage.from('matchbooks').getPublicUrl(path).data.publicUrl
      const { error } = await supabase.from('trade_listings').update({ photo_url: url }).eq('id', listing.id)
      if (error) throw error
      refreshTrades()
      return true
    } catch (e) { console.error('Listing photo failed', e); return false }
  }

  // Every rule in the spec is enforced server-side; surface whatever it says.
  const rpcOr = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) { console.error(fn, error); return { error: error.message || 'Something went wrong. Try again.' } }
    return { data }
  }
  const handleMakeOffer = (listingId, venueIds, note) =>
    rpcOr('make_offer', { p_listing_id: listingId, p_venue_ids: venueIds, p_note: note || null })
  const handleAcceptOffer = async (o) => {
    const res = await rpcOr('accept_offer', { p_offer_id: o.offer_id })
    if (res.error) return res
    await refreshTrades()
    const { data } = await supabase.rpc('my_trades')
    const chat = (data || []).find(c => c.chat_id === res.data)
    setOffersFor(null)
    if (chat) { setOpenChat(chat); setTab('trades') }
    return res
  }
  const handleDeclineOffer = async (o) => {
    const res = await rpcOr('decline_offer', { p_offer_id: o.offer_id })
    if (!res.error) refreshTrades()
    return res
  }
  const handleCompleteTrade = async (chatId) => {
    const res = await rpcOr('complete_trade', { p_chat_id: chatId })
    if (!res.error) refreshTrades()
    return res
  }
  const handleCancelTrade = async (chatId, reason) => {
    const res = await rpcOr('cancel_trade', { p_chat_id: chatId, p_reason: reason })
    if (!res.error) refreshTrades()
    return res
  }

  // Your own block list, with names — profiles are owner-only, so this needs the RPC.
  const loadBlocked = useCallback(() => {
    if (!user) { setBlocked([]); return }
    supabase.rpc('blocked_list').then(({ data, error }) => {
      setBlocked(error ? [] : (data || [])) // pre-022: no RPC, stay empty
    })
  }, [user])
  useEffect(() => { loadBlocked() }, [loadBlocked])

  // Load collection with venue data joined
  const refreshCollection = useCallback(async () => {
    if (!user) return
    const { data } = await supabase
      .from('collections')
      .select('*')
      .eq('user_id', user.id)
      .order('collected_at', { ascending: false })
    if (data) setCollection(data)
  }, [user])

  const handleCollect = async (venue) => {
    if (!user) return false
    // A venue collected from the map is UNRANKED (score null) until the user
    // places it via head-to-heads. It is NOT stranded: Rankings → Mine shows it
    // in the "Unranked" section with a Rank button. The old behavior seeded the
    // list median, silently squatting mid-ranking in a slot the user never chose
    // — the #1 source of "my rankings are wrong".
    const row = { user_id: user.id, venue_id: venue.id }
    const { data, error } = await supabase.from('collections').insert(row).select().single()
    if (error) {
      if (error.code === '23505') return true // already collected — treat as success
      console.error('Collect failed', error)
      return false
    }
    setCollection(prev => (prev.some(c => c.id === data.id) ? prev : [data, ...prev]))
    return true
  }

  const handleRemoveFromCollection = async (collectionId) => {
    const { error } = await supabase.from('collections').delete().eq('id', collectionId)
    // Only drop it locally if the DB really deleted it — otherwise it would
    // vanish from every screen and silently reappear on the next refresh.
    if (error) { console.error('Remove from collection failed', error); return }
    setCollection(prev => prev.filter(i => i.id !== collectionId))
  }

  // Add photos to a matchbook that's already collected (from its detail page) —
  // same downscale → storage → collections update as the post-collect prompt.
  // Returns the merged photo list so the open page can update in place.
  const handleAddPhotos = async (item, files) => {
    if (!user || !files.length) return null
    // Merge into the row's CURRENT photos from the DB, not the caller's item —
    // that item is a snapshot frozen at tap time (and post-collect uploads may
    // not be in local state at all); merging into it would overwrite photos.
    const { data: row, error: readErr } = await supabase.from('collections')
      .select('photos, photo_url').eq('user_id', user.id).eq('venue_id', item.venue_id).single()
    if (readErr) throw readErr
    const existing = (row?.photos && row.photos.length) ? row.photos : (row?.photo_url ? [row.photo_url] : [])
    const urls = []
    for (const f of files.slice(0, 6)) {
      const blob = await downscaleImage(f, 1600, 0.8)
      const path = `${user.id}/${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage.from('matchbooks').upload(path, blob, { contentType: 'image/jpeg', upsert: false })
      if (upErr) throw upErr
      urls.push(supabase.storage.from('matchbooks').getPublicUrl(path).data.publicUrl)
    }
    const merged = [...existing, ...urls]
    const { error } = await supabase.from('collections')
      .update({ photos: merged, photo_url: merged[0] })
      .eq('user_id', user.id).eq('venue_id', item.venue_id)
    if (error) throw error
    setCollection(prev => prev.map(c => (c.venue_id === item.venue_id ? { ...c, photos: merged, photo_url: merged[0] } : c)))
    return merged
  }

  // `reason` decides what happens (migration 021): only 'closed_down' can close a
  // venue, only 'discontinued' can retire its matchbooks. 'out_temporarily' and
  // 'unknown' are advisory — they never retire anything.
  //
  // ignoreDuplicates is FALSE so changing your mind rewrites the reason (the
  // trigger fires on update too). superseded_at MUST be reset: reports is
  // unique(user_id,venue_id), so a re-report can only ever UPDATE your existing
  // row — and if a repost superseded it, leaving that stamp in place would spend
  // you as a reporter forever, making a genuinely dead spot un-retirable by the
  // very people who know it's dead.
  // Columns may not exist pre-021, so strip and retry rather than lose the report.
  const handleFlag = async (venueId, reason = 'unknown') => {
    if (!user) return false
    const row = { user_id: user.id, venue_id: venueId, reason, superseded_at: null }
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await supabase
        .from('reports')
        .upsert(row, { onConflict: 'user_id,venue_id', ignoreDuplicates: false })
      if (!error) break
      if (isMissingColumn(error) && 'superseded_at' in row) { delete row.superseded_at; continue }
      if (isMissingColumn(error) && 'reason' in row) { delete row.reason; continue }
      console.error('Flag failed', error)
      return false
    }
    // Only the retiring reasons hide the pin from your own map. "They're out
    // right now" is a snapshot of one visit, not a verdict on the spot — hiding
    // it forever would bury a place that restocks next week.
    const hides = reason === 'closed_down' || reason === 'discontinued'
    if (hides) setReported(prev => (prev.some(r => r.venue_id === venueId) ? prev : [...prev, { venue_id: venueId }]))
    return true
  }

  // "This isn't a real matchbook" → fraud claim routed to human review (spec §4)
  const handleFakeReport = async (venueId, reason) => {
    if (!user) return false
    const { error } = await supabase
      .from('fake_reports')
      .insert({ reporter_id: user.id, venue_id: venueId, reason: reason || null })
    if (error) { console.error('Fake report failed', error); return false }
    // Reflect the new pending report in the admin badge/queue right away.
    if (isAdmin) loadFakeReports()
    return true
  }

  // Admin: Accept — delete the venue; FK cascade clears every collector's copy,
  // score, report, and the fake_reports rows pointing at it (spec §4).
  const handleAcceptReport = async (venueId, reportId) => {
    const { error } = await supabase.from('venues').delete().eq('id', venueId)
    if (error) { console.error('Accept (delete venue) failed', error); return false }
    setVenues(prev => prev.filter(v => v.id !== venueId))
    setCollection(prev => prev.filter(c => c.venue_id !== venueId))
    setReported(prev => prev.filter(r => r.venue_id !== venueId))
    setFakeReports(prev => prev.filter(r => r.venue_id !== venueId))
    return true
  }

  // Admin: Reject — keep the venue, mark the report resolved (spec §4).
  const handleRejectReport = async (reportId) => {
    const { error } = await supabase
      .from('fake_reports')
      .update({ status: 'rejected', resolved_by: user.id, resolved_at: new Date().toISOString() })
      .eq('id', reportId)
    if (error) { console.error('Reject report failed', error); return false }
    setFakeReports(prev => prev.filter(r => r.id !== reportId))
    return true
  }

  const handleAdded = (newVenue, collectionRow) => {
    // newVenue may already exist locally (dedup link) — REPLACE it rather than
    // keeping the local copy, so a status change (e.g. a repost flipping it back
    // to active) actually reaches the map instead of staying stale until reload.
    setVenues(prev => (prev.some(v => v.id === newVenue.id)
      ? prev.map(v => (v.id === newVenue.id ? newVenue : v))
      : [...prev, newVenue]))
    if (collectionRow) {
      // replace in place if it already exists (e.g. a re-collect that added a photo)
      setCollection(prev => (prev.some(c => c.id === collectionRow.id)
        ? prev.map(c => (c.id === collectionRow.id ? collectionRow : c))
        : [collectionRow, ...prev]))
    }
  }

  // Permanently delete the account + all data (App Store requirement).
  // Order matters: the user's uploaded FILES are deleted first via the Storage
  // API — Supabase refuses SQL DML on storage.objects (42501 "use the Storage
  // API instead"), so the RPC can't do it — and this needs the still-live
  // session. Then delete_my_account() erases the auth user, which cascades all
  // their rows. Any failure aborts BEFORE the account is touched, so a retry is
  // always safe. Returns an error to surface, or null on success.
  const handleDeleteAccount = async () => {
    try {
      const bucket = supabase.storage.from('matchbooks')
      for (let page = 0; page < 20; page++) { // safety cap ~2000 files
        const { data: files, error: listErr } = await bucket.list(user.id, { limit: 100 })
        if (listErr) throw listErr
        if (!files || files.length === 0) break
        const { error: rmErr } = await bucket.remove(files.map(f => `${user.id}/${f.name}`))
        if (rmErr) throw rmErr
        if (files.length < 100) break
      }
    } catch (e) {
      console.error('Storage cleanup failed; account NOT deleted', e)
      return e
    }
    const { error } = await supabase.rpc('delete_my_account')
    if (error) { console.error('Account deletion failed', error); return error }
    await handleSignOut()
    return null
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    setCollection([])
    setReported([])
    setIsAdmin(false)
    setMyAvatar(null)
    setMyName(null)
    setShowNamePrompt(false)
    setFakeReports([])
    setFollowing([])
    setShowAdmin(false)
    setShowInvite(false)
    setShowFind(false)
    setViewingCollector(null)
    setReRankTarget(null)
    setShowAuth(true)
  }

  // Enrich collection with venue data
  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))
  const enrichedCollection = collection.map(item => ({ ...item, venue: venueMap[item.venue_id] }))
  const collectionIds = useMemo(() => collection.map(i => i.venue_id), [collection])
  // Ranked items: collection rows with a score, sorted best-first (passed to Submit + Rankings)
  const rankedItems = useMemo(
    () => enrichedCollection.filter(i => i.score != null && i.venue).sort((a, b) => b.score - a.score),
    [enrichedCollection]
  )
  // mapbox_ids of venues already in your collection — lets Submit flag (and block)
  // a place you've already got right in the search results, instead of only at the
  // end of the flow.
  const collectedMapboxIds = useMemo(
    () => new Set(enrichedCollection.map(i => i.venue?.mapbox_id).filter(Boolean)),
    [enrichedCollection]
  )

  // Re-rank an already-ranked spot: pull it out of the list and re-place it via
  // the same head-to-head flow, seeded with its current photo + score.
  const startReRank = (item) => {
    if (!item?.venue) return
    setReRankTarget({
      venue: item.venue,
      photo: item.photo_url || (item.photos && item.photos[0]) || null,
      score: item.score,
      from: tab, // return the user to wherever they started ranking from
    })
  }

  // Demote a spot back to the Unranked section (score=null) — the cleanup tool
  // for legacy auto-seeded scores that squat in positions the user never chose.
  const handleUnrank = async (item) => {
    const { error } = await supabase.from('collections')
      .update({ score: null }).eq('user_id', user.id).eq('venue_id', item.venue_id)
    if (error) { console.error('Unrank failed', error); return }
    setCollection(prev => prev.map(c => (c.venue_id === item.venue_id ? { ...c, score: null } : c)))
  }

  // Tapping a bottom tab from anywhere (Submit, Admin, Invite, Find, Re-rank)
  // exits that flow and lands on the tab — so you're never stuck in a screen.
  // Tapping a tab exits whatever flow you're in — you're never stuck in a screen.
  const handleNav = (t) => {
    setShowSubmit(false)
    setShowAdmin(false)
    setShowInvite(false)
    setShowFind(false)
    setViewingCollector(null)
    setReRankTarget(null)
    setOfferTarget(null)
    setOffersFor(null)
    setOpenChat(null)
    setSheetOpen(false)
    if (t === 'trades') refreshTrades() // the badge must match what the tab shows
    setTab(t)
  }

  const phoneStyle = {
    maxWidth: 500, // fills every current iPhone edge-to-edge (SE→Pro Max); only caps the web view on desktop
    margin: '0 auto',
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    background: C.bg,
    position: 'relative',
    overflow: 'hidden',
  }

  if (authLoading) {
    return (
      <div style={{ ...phoneStyle, alignItems: 'center', justifyContent: 'center' }}>
        <MbIcon size={56} />
        <div style={{ marginTop: 16, fontFamily: 'Georgia, serif', fontSize: 20, fontWeight: 300, color: C.text }}>phillumeni</div>
      </div>
    )
  }

  if (recoveryMode) {
    return (
      <div style={phoneStyle}>
        <ResetPassword onDone={() => setRecoveryMode(false)} />
      </div>
    )
  }

  if (showAuth || !user) {
    return (
      <div style={phoneStyle}>
        <AuthScreen onDone={() => setShowAuth(false)} />
      </div>
    )
  }

  if (showNamePrompt) {
    return (
      <div style={phoneStyle}>
        <NamePrompt user={user} onSaved={(n) => { setMyName(n); setShowNamePrompt(false) }} />
      </div>
    )
  }

  return (
    <div style={phoneStyle}>
      {reRankTarget ? (
        <ComparisonFlow
          newVenue={reRankTarget.venue}
          newPhoto={reRankTarget.photo}
          initialScore={reRankTarget.score}
          rankedItems={rankedItems}
          user={user}
          reRank={reRankTarget.score != null} // unranked spots get first-time "Where does this rank?" copy
          onDone={() => { const back = reRankTarget.from || 'rankings'; setReRankTarget(null); refreshCollection(); setTab(back) }}
        />
      ) : showSubmit ? (
        <Submit
          onBack={() => setShowSubmit(false)}
          onAdded={handleAdded}
          user={user}
          rankedItems={rankedItems}
          collectedMapboxIds={collectedMapboxIds}
          onRankingDone={() => { refreshCollection(); setShowSubmit(false); setTab('rankings') }}
          onSheetOpenChange={setSheetOpen}
          onFlag={handleFlag}
        />
      ) : showAdmin ? (
        <AdminQueue
          reports={fakeReports}
          venues={venues}
          closureReports={closureReports}
          chatReports={chatReports}
          onAccept={handleAcceptReport}
          onReject={handleRejectReport}
          onResolveReports={handleResolveReports}
          onResolveChatReport={handleResolveChatReport}
          onBack={() => setShowAdmin(false)}
        />
      ) : openChat ? (
        <TradeChat
          chat={openChat}
          user={user}
          onComplete={handleCompleteTrade}
          onCancel={handleCancelTrade}
          onBlock={handleBlock}
          onBack={() => { setOpenChat(null); refreshTrades() }}
        />
      ) : offersFor ? (
        <BidInbox
          listing={offersFor}
          onAccept={handleAcceptOffer}
          onDecline={handleDeclineOffer}
          onBack={() => { setOffersFor(null); refreshTrades() }}
        />
      ) : offerTarget ? (
        <MakeOffer
          listing={offerTarget}
          collection={enrichedCollection}
          myListings={myListings}
          onSend={handleMakeOffer}
          onBack={() => { setOfferTarget(null); refreshTrades() }}
        />
      ) : showInvite ? (
        <InviteScreen user={user} onBack={() => setShowInvite(false)} />
      ) : showFind ? (
        <FindCollectors onFollow={handleFollow} onUnfollow={handleUnfollow} onView={(c) => { setShowFind(false); setViewingCollector(c) }} onBack={() => setShowFind(false)} />
      ) : viewingCollector ? (
        <CollectorProfile
          collector={viewingCollector}
          isFollowing={viewingCollector.isFollowing ?? following.some(f => f.id === viewingCollector.id)}
          onFollow={handleFollow}
          onUnfollow={handleUnfollow}
          onBlock={handleBlock}
          onBack={() => setViewingCollector(null)}
        />
      ) : (
        <>
          {tab === 'explore' && (
            <Explore
              venues={venues}
              collectionIds={collectionIds}
              reported={reported}
              onCollect={handleCollect}
              onFlag={handleFlag}
              onFakeReport={handleFakeReport}
              onSubmit={() => setShowSubmit(true)}
              venuesError={venuesError}
              onRetry={loadVenues}
              onSheetOpenChange={setSheetOpen}
              user={user}
              onRank={(venue, photos = []) => startReRank({
                venue,
                venue_id: venue.id,
                photo_url: photos[0] || null,
                photos,
                score: null, // fresh collect — first-time ranking copy
              })}
              isAdmin={isAdmin}
              onSetCover={handleSetCover}
            />
          )}
          {tab === 'rankings' && (
            <Rankings collection={collection} venues={venues} onFlag={handleFlag} onFakeReport={handleFakeReport} onReRank={startReRank} onUnrank={handleUnrank} onRemove={handleRemoveFromCollection} onAddPhotos={handleAddPhotos} onSheetOpenChange={setSheetOpen} />
          )}
          {tab === 'collection' && (
            <Collection
              items={enrichedCollection}
              venues={venues}
              onRemove={handleRemoveFromCollection}
              onSubmit={() => setShowSubmit(true)}
              onReRank={startReRank}
              onAddPhotos={handleAddPhotos}
              myListings={myListings}
              offerCounts={offerCounts}
              onToggleTrade={handleToggleTrade}
              onListingPhoto={handleListingPhoto}
              onOpenOffers={setOffersFor}
            />
          )}
          {tab === 'trades' && (
            <Trades
              user={user}
              onOffer={setOfferTarget}
              onOpenChat={setOpenChat}
              onSeenOffers={refreshTrades}
              onSheetOpenChange={setSheetOpen}
            />
          )}
          {tab === 'profile' && (
            <ProfileScreen
              user={user}
              displayName={myName}
              collection={enrichedCollection}
              onSignOut={handleSignOut}
              onDeleteAccount={handleDeleteAccount}
              isAdmin={isAdmin}
              pendingReports={fakeReports.length}
              onOpenAdmin={() => setShowAdmin(true)}
              onOpenInvite={() => setShowInvite(true)}
              following={following}
              onUnfollow={handleUnfollow}
              blocked={blocked}
              onUnblock={handleUnblock}
              onOpenFind={() => setShowFind(true)}
              onViewCollector={setViewingCollector}
              avatarUrl={myAvatar}
              onAvatarChange={setMyAvatar}
              onSheetOpenChange={setSheetOpen}
            />
          )}
        </>
      )}
      {!sheetOpen && <TabBar active={tab} onNav={handleNav} tradeBadge={tradeBadge} />}
    </div>
  )
}
