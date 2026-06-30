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

// Title-case a Mapbox poi_category (e.g. "fast food restaurant" -> "Fast Food Restaurant")
const titleCase = (s) => (s ? String(s).replace(/\b\w/g, (c) => c.toUpperCase()) : s)

// "Column not migrated yet" — Postgres reports an undefined column as 42703, but
// PostgREST's schema-cache check reports it as PGRST204 ("Could not find the 'X'
// column of 'Y' in the schema cache"). Treat both (and any schema-cache miss) as
// the column being absent, so the app degrades gracefully on a partial migration.
const isMissingColumn = (err) =>
  !!err && (err.code === '42703' || err.code === 'PGRST204' || /schema cache/i.test(err.message || ''))
const venueInitials = (name) => (name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')

function eloUpdate(scoreA, scoreB, aWon) {
  const S = 3, K = 0.5
  const expA = 1 / (1 + Math.pow(10, (scoreB - scoreA) / S))
  const newA = Math.min(10, Math.max(0, scoreA + K * ((aWon ? 1 : 0) - expA)))
  const newB = Math.min(10, Math.max(0, scoreB + K * ((aWon ? 0 : 1) - (1 - expA))))
  return [Math.round(newA * 10) / 10, Math.round(newB * 10) / 10]
}

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

const pinColor = (v, collected) => {
  if (v.status === 'closed') return C.muted
  if (collected) return C.amber   // yours — already in your collection
  return C.green                  // out there to grab
}

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

const SBar = ({ title, light }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 22px 0', fontSize: 12, flexShrink: 0, color: light ? 'rgba(255,255,255,0.4)' : C.muted }}>
    <span style={{ fontWeight: 500 }}>9:41</span>
    {title && <span style={{ fontWeight: 700, fontSize: 13, color: light ? '#fff' : C.text, letterSpacing: '-.2px' }}>{title}</span>}
    <span style={{ display: 'flex', gap: 4 }}><i className="ti ti-wifi" style={{ fontSize: 12 }} /><i className="ti ti-battery-2" style={{ fontSize: 12 }} /></span>
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
// Style a marker's DOM element for its venue + selected state (no recreation).
function styleMarkerEl(el, v, isSelected, collected) {
  el.style.cssText = [
    `width:${isSelected ? 34 : 28}px`,
    `height:${isSelected ? 34 : 28}px`,
    'border-radius:50%',
    `background:${pinColor(v, collected)}`,
    `border:${isSelected ? '3px' : '2.5px'} solid white`,
    'cursor:pointer',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-size:10px',
    'color:white',
    'font-weight:700',
    `box-shadow:0 ${isSelected ? 4 : 2}px ${isSelected ? 16 : 8}px rgba(0,0,0,${isSelected ? 0.4 : 0.25})`,
    'transition:all .15s',
  ].join(';')
  el.textContent = v.status === 'closed' ? '✕' : collected ? '✓' : '✦'
}

function AppMap({ venues, collectionIds, reportedIds, onSelectVenue, selectedVenue, filter }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const mapboxglRef = useRef(null)
  const markersRef = useRef(new Map()) // venue.id -> { marker, el, venue }
  const geolocateRef = useRef(null)
  const [mapReady, setMapReady] = useState(false)
  const selectedRef = useRef(selectedVenue)
  selectedRef.current = selectedVenue

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

      // Don't let a denied/timed-out location prompt fail silently; map stays on NYC.
      geolocate.on('error', (err) => {
        console.warn('Geolocation unavailable; staying centered on NYC.', err?.message || err)
      })

      map.on('load', () => {
        geolocate.trigger()
        if (!cancelled) setMapReady(true)
      })

      mapRef.current = map
      geolocateRef.current = geolocate
    })()

    return () => {
      cancelled = true
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
      markersRef.current.clear()
    }
  }, [])

  // Sync markers to the visible set: add new ones, update changed ones in place,
  // remove gone ones — never a full teardown/rebuild.
  useEffect(() => {
    const mapboxgl = mapboxglRef.current
    if (!mapboxgl || !mapRef.current) return

    // Collected venues stay ON the map (marked as yours) — only hide ones you
    // reported as unavailable. The closed ones stay visible (grey) as history.
    const visible = venues.filter(v => {
      if (reportedIds.includes(v.id)) return false
      if (filter === 'open') return v.is_open && v.status !== 'closed'
      if (filter === 'multi') return (v.sources || []).length >= 2
      return true
    })
    const visibleIds = new Set(visible.map(v => v.id))

    markersRef.current.forEach((entry, id) => {
      if (!visibleIds.has(id)) { entry.marker.remove(); markersRef.current.delete(id) }
    })

    visible.forEach(v => {
      const collected = collectionIds.includes(v.id)
      const existing = markersRef.current.get(v.id)
      if (existing) {
        existing.venue = v
        existing.collected = collected
        existing.marker.setLngLat([v.lng, v.lat])
        styleMarkerEl(existing.el, v, selectedRef.current?.id === v.id, collected)
        return
      }
      const el = document.createElement('div')
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const cur = selectedRef.current
        onSelectVenue(cur?.id === v.id ? null : v)
      })
      styleMarkerEl(el, v, selectedRef.current?.id === v.id, collected)
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([v.lng, v.lat]).addTo(mapRef.current)
      markersRef.current.set(v.id, { marker, el, venue: v, collected })
    })
  }, [venues, collectionIds, reportedIds, filter, mapReady])

  // Restyle in place when the selection changes — no marker teardown.
  useEffect(() => {
    markersRef.current.forEach((entry, id) => {
      styleMarkerEl(entry.el, entry.venue, selectedVenue?.id === id, entry.collected)
    })
  }, [selectedVenue])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

// ─── EXPLORE SCREEN ──────────────────────────────────────
function Explore({ venues, collectionIds, reported, onCollect, onFlag, onFakeReport, onSubmit, venuesError, onRetry, onSheetOpenChange }) {
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('all')
  const [reporting, setReporting] = useState(null) // venue being reported
  const [venuePhotos, setVenuePhotos] = useState([]) // anonymized gallery for the open venue
  const reportedIds = useMemo(() => reported.map(r => r.venue_id), [reported])

  // Tell the shell a sheet is open so it can hide the tab bar (sheet covers it).
  useEffect(() => {
    onSheetOpenChange?.(!!reporting)
    return () => onSheetOpenChange?.(false)
  }, [reporting]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the venue's community photo gallery (anonymized RPC; no-ops gracefully
  // if migration 009 hasn't run yet).
  useEffect(() => {
    if (!selected) { setVenuePhotos([]); return }
    let cancelled = false
    supabase.rpc('venue_photos', { p_venue_id: selected.id }).then(({ data, error }) => {
      if (cancelled) return
      if (error) { setVenuePhotos([]); return }
      setVenuePhotos(Array.isArray(data) ? data.filter(Boolean) : [])
    })
    return () => { cancelled = true }
  }, [selected])

  const listed = venues
    .filter(v => {
      if (reportedIds.includes(v.id)) return false
      if (v.status === 'closed') return false // closed venues aren't collectable
      if (filter === 'open') return v.is_open
      if (filter === 'multi') return (v.sources || []).length >= 2
      return true
    })
    .slice(0, 8)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px 0', flexShrink: 0 }}>
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
              <div style={{ width: 52, height: 52, borderRadius: 13, background: selected.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, flexShrink: 0 }}>
                {selected.emoji}
              </div>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, letterSpacing: '-.3px', marginBottom: 2 }}>{selected.name}</div>
                <div style={{ fontSize: 12, color: C.muted }}>{selected.address}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
              {selected.status === 'closed' && <Tag label="Closed" bg={C.redBg} color={C.red} />}
              {collectionIds.includes(selected.id) && <Tag label="✓ In your collection" bg={C.amberBg} color={C.amber} />}
              <Tag label={selected.type || 'Spot'} bg={C.surface} color={C.sec} />
            </div>

            {/* Community gallery — every matchbook submitted here, anonymized */}
            {venuePhotos.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.4px', textTransform: 'uppercase', marginBottom: 8 }}>
                  Matchbooks found here · {venuePhotos.length}
                </div>
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                  {venuePhotos.map((url, i) => (
                    <img key={i} src={url} alt="Matchbook" loading="lazy"
                      style={{ width: 104, height: 104, objectFit: 'cover', borderRadius: 12, flexShrink: 0, border: `0.5px solid ${C.border}`, background: C.surface }} />
                  ))}
                </div>
              </div>
            )}
            {selected.note && <div style={{ fontSize: 12, color: C.muted, fontStyle: 'italic', marginBottom: 14, lineHeight: 1.5 }}>{selected.note}</div>}
            {selected.status === 'closed' ? (
              <div style={{ padding: 12, background: C.surface, borderRadius: 12, fontSize: 13, color: C.sec, textAlign: 'center', fontWeight: 500, lineHeight: 1.5 }}>
                This spot has closed — its matchbooks are now collector's items.
              </div>
            ) : reportedIds.includes(selected.id) ? (
              <div style={{ padding: 12, background: C.redBg, borderRadius: 12, fontSize: 13, color: C.red, textAlign: 'center', fontWeight: 500 }}>Reported as unavailable</div>
            ) : collectionIds.includes(selected.id) ? (
              <>
                <div style={{ padding: 12, background: C.amberBg, borderRadius: 12, fontSize: 13, color: C.amber, textAlign: 'center', fontWeight: 600, marginBottom: 8 }}>
                  <i className="ti ti-check" style={{ fontSize: 13, marginRight: 5 }} />You've collected this one
                </div>
                <OutlineBtn onClick={() => setReporting(selected)} color={C.red}>
                  <i className="ti ti-flag" style={{ fontSize: 12, marginRight: 5 }} />Report a problem
                </OutlineBtn>
              </>
            ) : (
              <>
                <PrimaryBtn onClick={() => { onCollect(selected); setSelected(null) }} style={{ marginBottom: 8 }}>Got it — add to collection</PrimaryBtn>
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
              Every matchbook on this map was found by a real person. Be the first in NYC.
            </div>
            <PrimaryBtn onClick={onSubmit}>Submit the first one</PrimaryBtn>
          </div>
        ) : (
          <div style={{ padding: '12px 16px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{listed.length} spots nearby</div>
              <div style={{ fontSize: 11, color: C.muted }}>amber = yours</div>
            </div>
            {listed.map(v => (
              <div key={v.id} onClick={() => setSelected(v)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer' }}>
                <div style={{ width: 38, height: 38, borderRadius: 11, background: v.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>{v.emoji}</div>
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
          onNotAvailable={async (venueId) => { const ok = await onFlag(venueId); if (ok) setSelected(null); return ok }}
          onFake={onFakeReport}
        />
      )}
    </div>
  )
}

// ─── COLLECTION SCREEN ───────────────────────────────────
function Collection({ items, venues, onRemove }) {
  const [view, setView] = useState('grid')
  const [detail, setDetail] = useState(null)

  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))
  const collected = items.map(item => ({ ...item, venue: venueMap[item.venue_id] })).filter(i => i.venue)
  const nyc = collected.filter(i => i.venue.city === 'NYC')
  const nycTotal = Math.max(venues.filter(v => v.city === 'NYC').length, nyc.length, 1)
  const hoods = [...new Set(collected.map(i => i.venue.neighborhood).filter(Boolean))]

  if (detail) {
    const v = detail.venue
    const detailPhotos = (detail.photos && detail.photos.length) ? detail.photos : (detail.photo_url ? [detail.photo_url] : [])
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <SBar title="Collection" />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ padding: '10px 16px 0' }}>
            <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', fontSize: 13, color: C.amber, cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0 12px' }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Collection
            </button>
          </div>
          {detailPhotos.length ? (
            <img src={detailPhotos[0]} alt="Your matchbook" style={{ width: '100%', height: 210, objectFit: 'cover', display: 'block' }} />
          ) : (
            <div style={{ width: '100%', height: 210, background: v.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 72 }}>{v.emoji}</div>
          )}
          <div style={{ padding: '16px 16px 28px' }}>
            <div style={{ fontSize: 19, fontWeight: 700, color: C.text, letterSpacing: '-.3px', marginBottom: 4 }}>{v.name}</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>{v.address}</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
              <Tag label={`Collected ${new Date(detail.collected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`} bg={C.greenBg} color={C.green} />
              <Tag label={v.type || 'Spot'} bg={C.surface} color={C.sec} />
              {v.status === 'closed' && <Tag label="Closed — collector's item" bg={C.redBg} color={C.red} />}
            </div>
            {detailPhotos.length > 1 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                {detailPhotos.map((url, i) => (
                  <img key={i} src={url} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: i === 0 ? `2px solid ${C.amber}` : `0.5px solid ${C.border}` }} />
                ))}
              </div>
            )}
            {detailPhotos.length === 0 && (
              <div style={{ background: C.surface, borderRadius: 12, padding: '10px 12px', fontSize: 12, color: C.muted, marginBottom: 14, lineHeight: 1.5 }}>
                <i className="ti ti-camera" style={{ fontSize: 12, marginRight: 6 }} />No photos for this one yet
              </div>
            )}
            <OutlineBtn onClick={() => { onRemove(detail.id); setDetail(null) }} color={C.red}>Remove from collection</OutlineBtn>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SBar title="Collection" />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '14px 16px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-.4px' }}>Your collection</div>
            <div style={{ display: 'flex', gap: 2, background: C.surface, borderRadius: 9, padding: 3, border: `0.5px solid ${C.border}` }}>
              {['grid', 'list'].map(v => (
                <button key={v} onClick={() => setView(v)} style={{ width: 30, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', cursor: 'pointer', background: view === v ? C.card : 'transparent', color: view === v ? C.text : C.muted }}>
                  <i className={`ti ti-${v === 'grid' ? 'layout-grid' : 'list'}`} style={{ fontSize: 13 }} />
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
            {[{ n: collected.length, l: 'matchbooks' }, { n: new Set(collected.map(i => i.venue.city)).size, l: 'cities' }, { n: hoods.length, l: 'hoods' }, { n: collected.filter(i => (i.venue.sources || []).length >= 2).length, l: 'verified' }].map((s, i) => (
              <div key={i} style={{ background: C.surface, borderRadius: 12, padding: '9px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{s.n}</div>
                <div style={{ fontSize: 9, color: C.muted, marginTop: 1, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 600 }}>{s.l}</div>
              </div>
            ))}
          </div>

          {nyc.length > 0 && (
            <Card style={{ padding: '11px 14px', marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>NYC progress</div>
                <div style={{ fontSize: 12, color: C.muted }}>{nyc.length} of {nycTotal} found</div>
              </div>
              <div style={{ height: 5, background: C.surface, borderRadius: 3 }}>
                <div style={{ height: 5, background: C.green, borderRadius: 3, width: `${Math.min(100, Math.max(3, Math.round(nyc.length / nycTotal * 100)))}%`, transition: 'width .5s' }} />
              </div>
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
              <div key={item.id} onClick={() => setDetail(item)} style={{ aspectRatio: '1', background: item.photo_url ? `#000 url("${item.photo_url}") center/cover no-repeat` : (item.venue.bg_color || '#1A1A1A'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, cursor: 'pointer', position: 'relative' }}>
                {!item.photo_url && item.venue.emoji}
                {item.venue.status === 'closed' && (
                  <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 8, fontWeight: 700, letterSpacing: .3, padding: '1px 5px', borderRadius: 99 }}>CLOSED</div>
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
                <div style={{ width: 52, height: 52, borderRadius: 10, background: item.photo_url ? `#000 url("${item.photo_url}") center/cover no-repeat` : (item.venue.bg_color || '#1A1A1A'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>{!item.photo_url && item.venue.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {item.venue.neighborhood ? `${item.venue.neighborhood} · ${item.venue.city}` : item.venue.city}
                    {item.venue.status === 'closed' && <span style={{ color: C.red, fontWeight: 700 }}> · Closed</span>}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>{new Date(item.collected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

// ─── SUBMIT SCREEN ───────────────────────────────────────
function Submit({ onBack, onAdded, user, rankedItems = [], onRankingDone, onSheetOpenChange }) {
  const [step, setStep] = useState(1)
  const [photos, setPhotos] = useState([]) // { id, preview, url, path, status: 'uploading'|'done'|'error' }
  const photosRef = useRef(photos)
  photosRef.current = photos
  const [uploadErr, setUploadErr] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(null)
  const [adding, setAdding] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [addErr, setAddErr] = useState('')
  const [addedVenue, setAddedVenue] = useState(null)
  const [needsRanking, setNeedsRanking] = useState(false)
  // Manual entry ("can't find it") — spec §2
  const [showManual, setShowManual] = useState(false)
  const [manualCity, setManualCity] = useState('NYC')
  const [manualName, setManualName] = useState('')
  const [manualAddress, setManualAddress] = useState('')
  const [manualErr, setManualErr] = useState('')
  const [manualAdding, setManualAdding] = useState(false)
  const searchTimer = useRef(null)

  // The manual-entry sheet covers the screen — hide the shell's tab bar with it.
  useEffect(() => {
    onSheetOpenChange?.(showManual)
    return () => onSheetOpenChange?.(false)
  }, [showManual]) // eslint-disable-line react-hooks/exhaustive-deps
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
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('matchbooks')
          .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false })
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
      // Mapbox Search Box API — the v5 geocoder's POI search is deprecated
      const res = await fetch(
        `https://api.mapbox.com/search/searchbox/v1/suggest?q=${encodeURIComponent(query)}` +
        `&proximity=${NYC.lng},${NYC.lat}&types=poi&limit=6` +
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

      if (venue?.status === 'closed') {
        throw new Error('That spot is marked closed and can’t be collected.')
      }

      if (!venue) {
        // New venue — Search Box suggestions carry no coordinates, so retrieve them
        const res = await fetch(
          `https://api.mapbox.com/search/searchbox/v1/retrieve/${picked.mapbox_id}` +
          `?session_token=${getSession()}&access_token=${MAPBOX_TOKEN}`
        )
        if (!res.ok) throw new Error('Could not load that place — pick another.')
        const retrieved = await res.json()
        const coords = retrieved.features?.[0]?.geometry?.coordinates
        if (!coords || coords.length < 2) throw new Error('No location found for that place.')
        const [lng, lat] = coords

        const venueRow = {
          name: picked.name,
          address: picked.address.split(',').slice(0, 2).join(','),
          neighborhood: picked.address.split(',')[1]?.trim() || 'NYC',
          city: 'NYC',
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
      }

      await collectVenue(venue)
    } catch (e) {
      console.error(e)
      setAddErr(e.message || 'Something went wrong. Try again.')
    }
    setAdding(false)
  }

  // Collect a resolved venue into the user's collection, then trigger ranking.
  // Shared by the search path (handleAdd) and manual entry (handleAddManual).
  const collectVenue = async (venue) => {
    // Re-check the final venue (a create-race may have resolved to an auto-closed row).
    if (venue?.status === 'closed') {
      throw new Error('That spot is marked closed and can’t be collected.')
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
    if (collErr) {
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
            const { data: updated } = await supabase
              .from('collections')
              .update({ photos: merged, photo_url: merged[0] })
              .eq('user_id', user.id).eq('venue_id', venue.id).select().single()
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

    setAddedVenue(venue)
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
      const center = cityCenter(manualCity)
      let lng = center.lng, lat = center.lat
      try {
        const res = await fetch(
          `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(`${address}, ${cityLabel(manualCity)}`)}` +
          `&proximity=${center.lng},${center.lat}&limit=1&access_token=${MAPBOX_TOKEN}`
        )
        if (res.ok) {
          const data = await res.json()
          const coords = data.features?.[0]?.geometry?.coordinates
          if (coords && coords.length >= 2) { lng = coords[0]; lat = coords[1] }
        }
      } catch { /* keep the city-center fallback */ }

      const venueRow = {
        name,
        address,
        neighborhood: address.split(',')[1]?.trim() || null,
        city: manualCity,
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
      // added_manually (007) may not be migrated — strip on a missing-column error.
      let venue = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const { data, error } = await supabase.from('venues').insert(venueRow).select().single()
        if (!error) { venue = data; break }
        if (isMissingColumn(error) && 'added_manually' in venueRow) {
          delete venueRow.added_manually
          continue
        }
        throw error
      }

      setPicked({ name, address, manual: true })
      try {
        await collectVenue(venue)
      } catch (collectErr) {
        // The venue row is already committed but uncollected. Manual venues have
        // no mapbox_id, so a retry would duplicate it — roll it back first (the
        // creator-delete RLS policy permits deleting one's own unverified venue).
        await supabase.from('venues').delete().eq('id', venue.id)
        throw collectErr
      }
      setShowManual(false)
    } catch (e) {
      console.error(e)
      setManualErr(e.message || 'Couldn’t add it. Try again.')
    }
    setManualAdding(false)
  }

  // "Skip for now" from the step-3 confirmation: never leave the new venue at
  // score null. Seed it with the median of the ranked list (the score its first
  // comparison would have started from), then bow out.
  const skipRanking = async () => {
    if (addedVenue) {
      const medianScore = rankedItems[Math.floor((rankedItems.length - 1) / 2)]?.score
      const { error } = await supabase.from('collections')
        .update({ score: Math.round(((medianScore ?? 7.5)) * 10) / 10 })
        .eq('user_id', user.id).eq('venue_id', addedVenue.id)
      if (error) { // don't navigate away on a failed write — keep the user here to retry
        console.error('Skip-ranking score write failed', error)
        setAddErr('Couldn’t save — try again.')
        return
      }
    }
    ;(onRankingDone || onBack)()
  }

  const Steps = () => (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
      {[1, 2, 3].map(s => (
        <div key={s} style={{ height: 4, borderRadius: 2, width: s === step ? 28 : 12, background: s === step ? C.dark : s < step ? C.amber : C.border, transition: 'all .2s' }} />
      ))}
    </div>
  )

  // Step 4 is the comparison flow — render it as a full-screen replacement so
  // Submit's own status bar / Back button / progress dots don't double up.
  if (step === 4 && addedVenue) {
    return (
      <ComparisonFlow
        newVenue={addedVenue}
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
              <Card style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
                {results.map((r, i) => (
                  <div key={r.id} onClick={() => { setPicked(r); setQuery(r.name); setAddErr('') }}
                    style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', borderBottom: i < results.length - 1 ? `0.5px solid ${C.border}` : 'none', cursor: 'pointer', background: picked?.id === r.id ? C.greenBg : 'transparent', transition: 'background .1s' }}>
                    <div style={{ width: 38, height: 38, borderRadius: 10, background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <i className="ti ti-map-pin" style={{ fontSize: 17, color: picked?.id === r.id ? C.green : C.muted }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.address}</div>
                    </div>
                    {picked?.id === r.id && <i className="ti ti-check" style={{ fontSize: 16, color: C.green, flexShrink: 0 }} />}
                  </div>
                ))}
              </Card>
            )}

            {query.trim().length >= 2 && !searching && results.length === 0 && !searchErr && !picked && (
              <div style={{ textAlign: 'center', fontSize: 13, color: C.muted, margin: '2px 0 12px' }}>No matches found</div>
            )}

            {/* Manual-entry escape hatch (spec §2) — closed/missing venues */}
            <button onClick={() => { setManualName(query.trim()); setManualAddress(''); setManualErr(''); setShowManual(true) }}
              style={{ width: '100%', padding: 13, border: `1.5px dashed ${C.borderStr}`, borderRadius: 13, background: 'transparent', color: C.text, fontSize: 13, fontWeight: 700, cursor: 'pointer', marginBottom: 16 }}>
              Can't find it? This place might be closed
            </button>

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
            <div style={{ fontSize: 64, marginBottom: 16 }}>🔥</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: '-.4px', marginBottom: 8 }}>It's on the map.</div>
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.7, marginBottom: 24 }}>
              <span style={{ fontWeight: 700, color: C.text }}>{picked?.name}</span> is live and in your collection. Everyone nearby can find it.
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
                <OutlineBtn onClick={() => { setStep(1); clearPhotos(); setQuery(''); setResults([]); setPicked(null); setSearchErr(''); setAddErr('') }}>Submit another</OutlineBtn>
              </>
            )}
          </div>
        )}
      </div>

      {/* Manual-entry bottom sheet (spec §2) */}
      {showManual && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={() => !manualAdding && setShowManual(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
          <div style={{ position: 'relative', background: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: '10px 20px 24px', maxHeight: '88%', overflowY: 'auto', boxShadow: '0 -6px 24px rgba(0,0,0,0.18)' }}>
            <div style={{ width: 36, height: 4, background: C.borderStr, borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 6 }}>Add it manually</div>
            <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 18 }}>We'll geocode the address ourselves so it still shows up on the map correctly.</div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', marginBottom: 7 }}>CITY</div>
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <select value={manualCity} onChange={e => setManualCity(e.target.value)}
                style={{ width: '100%', padding: '13px 14px', border: `1.5px solid ${C.amberBd}`, borderRadius: 13, background: C.amberBg, color: C.amber, fontSize: 15, fontWeight: 700, appearance: 'none', WebkitAppearance: 'none', cursor: 'pointer', outline: 'none' }}>
                {CITIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <i className="ti ti-chevron-down" style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: C.amber, fontSize: 16, pointerEvents: 'none' }} />
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', marginBottom: 7 }}>VENUE NAME</div>
            <input value={manualName} onChange={e => setManualName(e.target.value)} placeholder="Venue name"
              style={{ width: '100%', padding: '13px 14px', border: `1.5px solid ${C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 15, fontWeight: 500, outline: 'none', marginBottom: 16 }} />

            <div style={{ fontSize: 11, fontWeight: 700, color: C.sec, letterSpacing: '.5px', marginBottom: 7 }}>ADDRESS</div>
            <input value={manualAddress} onChange={e => setManualAddress(e.target.value)} placeholder="Street, neighborhood…"
              style={{ width: '100%', padding: '13px 14px', border: `1.5px solid ${C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 15, fontWeight: 500, outline: 'none', marginBottom: 18 }} />

            {manualErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, lineHeight: 1.4 }}>{manualErr}</div>}
            <PrimaryBtn onClick={handleAddManual} disabled={manualAdding}>{manualAdding ? 'Adding…' : 'Continue'}</PrimaryBtn>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── REPORT SHEET (spec §4/§5) ───────────────────────────
// Bottom sheet: "Not available here" (reports) + "This isn't a real matchbook"
// (fake_reports). Reusable from the Explore detail and the Rankings row menu.
function ReportSheet({ venue, onClose, onNotAvailable, onFake }) {
  const [mode, setMode] = useState('menu') // menu | fake
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!venue) return null

  // Handlers return false on a failed write — keep the sheet open + show the
  // error instead of closing as if the report landed.
  const runNotAvailable = async () => {
    setBusy(true)
    setErr('')
    const ok = await onNotAvailable(venue.id)
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
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 16 }}>Report a problem</div>

        {mode === 'menu' ? (
          <>
            <button onClick={runNotAvailable} disabled={busy} style={option}>
              <div style={iconWrap}><i className="ti ti-map-pin-off" style={{ fontSize: 20, color: C.sec }} /></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Not available here</div>
                <div style={{ fontSize: 12, color: C.muted }}>This spot ran out or stopped having them</div>
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
// Binary-search insertion into the user's ranked list with Elo updates per tap.
// Invariant: the new venue ALWAYS leaves this screen with a non-null score —
// completing writes the Elo result; skipping/abandoning persists the fair
// baseline (the opponent's score) so a ranked submission can never go missing.
function ComparisonFlow({ newVenue, rankedItems, user, onDone }) {
  // Opponents = the user's existing ranked list, defensively excluding the new
  // venue itself (it must never compare against itself).
  const opponents = useMemo(
    () => rankedItems.filter(i => i.venue_id !== newVenue.id),
    [rankedItems, newVenue.id]
  )

  const [lo, setLo] = useState(0)
  const [hi, setHi] = useState(opponents.length - 1)
  const [doneCount, setDoneCount] = useState(0)
  const [newScore, setNewScore] = useState(null)
  const [liveScores, setLiveScores] = useState({})
  const [saving, setSaving] = useState(false)
  const [writeErr, setWriteErr] = useState('')
  const savingRef = useRef(false)   // synchronous re-entrancy lock (state lags a render)
  const finishedRef = useRef(false) // guarantees onDone + baseline-write happen once

  const totalSteps = Math.max(1, Math.ceil(Math.log2(opponents.length + 1)))
  const mid = Math.floor((lo + hi) / 2)
  const opponent = opponents[mid]
  const oppScore = opponent ? (liveScores[opponent.venue_id] ?? (opponent.score ?? 7.5)) : 7.5
  const curNewScore = newScore ?? oppScore
  const finished = !opponent || lo > hi

  // Finish exactly once: ensure the new venue has a persisted score, then exit.
  // newScore is null only if the user never completed a tap — seed the baseline.
  // finishedRef is claimed synchronously to block double-entry but RELEASED if the
  // baseline write fails, so the venue is never orphaned at score=null with no retry.
  const finish = useCallback(async (scoreSoFar) => {
    if (finishedRef.current) return
    finishedRef.current = true
    if (scoreSoFar == null) {
      const { error } = await supabase.from('collections')
        .update({ score: Math.round((oppScore ?? 7.5) * 10) / 10 })
        .eq('user_id', user.id).eq('venue_id', newVenue.id)
      if (error) {
        finishedRef.current = false // release so the user can retry
        console.error('Baseline score write failed', error)
        setWriteErr('Couldn’t save — tap again.')
        return
      }
    }
    onDone()
  }, [oppScore, user.id, newVenue.id, onDone])

  // Terminal condition (list exhausted) — run as an effect, never during render.
  useEffect(() => {
    if (finished) finish(newScore)
  }, [finished]) // eslint-disable-line react-hooks/exhaustive-deps

  if (finished) return null

  const oppRank = mid + 1

  const pick = async (newWon) => {
    if (savingRef.current || finishedRef.current) return
    savingRef.current = true
    setSaving(true)
    setWriteErr('')
    const [updNew, updOpp] = eloUpdate(curNewScore, oppScore, newWon)

    // Only the two collections.score writes are required (supabase-js resolves
    // with an { error } object rather than rejecting). On failure, do NOT advance
    // the search or mutate score state — surface an error and let the user retry.
    const results = await Promise.all([
      supabase.from('collections').update({ score: updNew }).eq('user_id', user.id).eq('venue_id', newVenue.id),
      supabase.from('collections').update({ score: updOpp }).eq('user_id', user.id).eq('venue_id', opponent.venue_id),
    ])
    const failed = results.find(r => r && r.error)
    savingRef.current = false
    setSaving(false)
    if (failed) {
      console.error('Comparison write failed', failed.error)
      setWriteErr('Couldn’t save that — check your connection and tap again.')
      return
    }

    // The comparisons audit log is OPTIONAL (spec §3) — best-effort, fire-and-forget
    // so a missing/unmigrated comparisons table can never block ranking.
    supabase.from('comparisons').insert({
      user_id: user.id,
      winner_venue_id: newWon ? newVenue.id : opponent.venue_id,
      loser_venue_id: newWon ? opponent.venue_id : newVenue.id,
    }).then(({ error }) => { if (error) console.warn('comparisons log skipped:', error.message) })

    setNewScore(updNew)
    setLiveScores(prev => ({ ...prev, [opponent.venue_id]: updOpp }))
    setDoneCount(n => n + 1)

    const newLo = newWon ? lo : mid + 1
    const newHi = newWon ? mid - 1 : hi
    if (newLo > newHi) { finish(updNew); return } // already scored — won't re-write
    setLo(newLo)
    setHi(newHi)
  }

  const skip = () => { if (!savingRef.current) finish(newScore) }

  const newIni = venueInitials(newVenue.name)
  const oppIni = venueInitials(opponent.venue?.name || '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg }}>
      <SBar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 20px 16px', overflowY: 'auto' }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-.5px', marginBottom: 4, textAlign: 'center' }}>Where does this rank?</div>
        <div style={{ fontSize: 14, color: C.muted, marginBottom: 18, textAlign: 'center' }}>Tap the one you liked more</div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
          {Array.from({ length: totalSteps }, (_, i) => (
            <div key={i} style={{ height: 4, width: i === doneCount ? 28 : (i < doneCount ? 24 : 12), borderRadius: 2, background: i <= doneCount ? C.amber : C.border, transition: 'all .2s' }} />
          ))}
        </div>

        <div onClick={() => pick(true)}
          style={{ width: '100%', background: C.amberBg, border: `2px solid ${C.amberBd}`, borderRadius: 20, padding: '28px 16px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1, marginBottom: 14, position: 'relative' }}>
          <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: C.amberBg, border: `1.5px solid ${C.amberBd}`, borderRadius: 99, padding: '3px 16px', fontSize: 11, fontWeight: 800, color: C.amber, letterSpacing: '.8px', whiteSpace: 'nowrap' }}>NEW</div>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#1A1918', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, color: '#fff', marginBottom: 12 }}>{newIni}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 4, textAlign: 'center' }}>{newVenue.name}</div>
          <div style={{ fontSize: 13, color: C.sec }}>{newVenue.neighborhood || newVenue.city || 'NYC'}</div>
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, letterSpacing: '1px', marginBottom: 14 }}>VS</div>

        <div onClick={() => pick(false)}
          style={{ width: '100%', background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 20, padding: '28px 16px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1, marginBottom: 16, position: 'relative' }}>
          <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 99, padding: '3px 16px', fontSize: 11, fontWeight: 800, color: C.muted, letterSpacing: '.8px', whiteSpace: 'nowrap' }}>CURRENTLY #{oppRank}</div>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: opponent.venue?.bg_color || '#3D2B1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 700, color: '#fff', marginBottom: 12 }}>{oppIni}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, letterSpacing: '-.4px', marginBottom: 4, textAlign: 'center' }}>{opponent.venue?.name || ''}</div>
          <div style={{ fontSize: 13, color: C.sec }}>{opponent.venue?.neighborhood || opponent.venue?.city || ''}</div>
        </div>

        {writeErr && <div style={{ fontSize: 12, color: C.red, marginBottom: 12, textAlign: 'center', lineHeight: 1.4 }}>{writeErr}</div>}

        <button onClick={skip} disabled={saving} style={{ background: 'none', border: 'none', fontSize: 14, color: C.muted, cursor: saving ? 'default' : 'pointer', textDecoration: 'underline', marginBottom: 10 }}>
          Too close to call — skip
        </button>
        <div style={{ fontSize: 11, color: C.muted, textAlign: 'center', lineHeight: 1.5 }}>Each tap also runs an Elo score update on both venues</div>
      </div>
    </div>
  )
}

// ─── RANKINGS SCREEN ─────────────────────────────────────
function Rankings({ collection, venues, onFlag, onFakeReport, onSheetOpenChange }) {
  const [tab, setTab] = useState('mine')
  const [reporting, setReporting] = useState(null) // venue being reported
  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))

  useEffect(() => {
    onSheetOpenChange?.(!!reporting)
    return () => onSheetOpenChange?.(false)
  }, [reporting]) // eslint-disable-line react-hooks/exhaustive-deps
  // Attach venue and drop venue-less rows BEFORE numbering, so rank is always
  // contiguous with the rendered list (no gaps if a venue hasn't loaded yet).
  const ranked = collection
    .filter(i => i.score != null)
    .map(item => ({ ...item, venue: venueMap[item.venue_id] }))
    .filter(i => i.venue)
    .sort((a, b) => b.score - a.score)
    .map((item, idx) => ({ ...item, rank: idx + 1 }))

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
    .filter(r => r.venue)
    .map((r, idx) => ({ ...r, rank: idx + 1 }))

  // Pale medal fills with dark, hue-matched digits (matches the mockup).
  const rankCircle = (n) => ({
    width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, flexShrink: 0,
    background: n === 1 ? '#F5E0A8' : n === 2 ? '#E2E2E2' : n === 3 ? '#E8C2A0' : C.surface,
    color: n === 1 ? '#7A5A0A' : n === 2 ? '#737373' : n === 3 ? '#7A4A1A' : C.muted,
  })

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
          ranked.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🏆</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No rankings yet</div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Submit your first matchbook to start building your list</div>
            </div>
          ) : (
            <div style={{ padding: '4px 16px' }}>
              {ranked.map(item => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `0.5px solid ${C.border}` }}>
                  <div style={rankCircle(item.rank)}>{item.rank}</div>
                  <div style={{ width: 42, height: 42, borderRadius: 11, background: item.venue.bg_color || C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0, letterSpacing: '-.2px' }}>
                    {venueInitials(item.venue.name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>{item.venue.neighborhood || item.venue.city}</div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: C.amber, flexShrink: 0 }}>{Number(item.score).toFixed(1)}</div>
                  <button onClick={() => setReporting(item.venue)} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: '4px 2px', fontSize: 18, flexShrink: 0, letterSpacing: '.5px' }}>···</button>
                </div>
              ))}
              <div style={{ height: 24 }} />
            </div>
          )
        ) : tab === 'friends' ? (
          (friendsRows === null || (friendsRows.length > 0 && friendsRanked.length === 0)) ? (
            // null = still loading; rows present but unresolved = venues not loaded yet
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem', color: C.muted, fontSize: 13 }}>Loading…</div>
          ) : friendsRanked.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No friends rankings yet</div>
              <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>Follow collectors from your Profile — once they've ranked spots, your friends' combined list shows here.</div>
            </div>
          ) : (
            <div style={{ padding: '4px 16px' }}>
              {friendsRanked.map(item => (
                <div key={item.venue_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `0.5px solid ${C.border}` }}>
                  <div style={rankCircle(item.rank)}>{item.rank}</div>
                  <div style={{ width: 42, height: 42, borderRadius: 11, background: item.venue.bg_color || C.dark, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0, letterSpacing: '-.2px' }}>
                    {venueInitials(item.venue.name)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {item.venue.neighborhood || item.venue.city} · {item.rankers} {item.rankers === 1 ? 'friend' : 'friends'}
                    </div>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: C.amber, flexShrink: 0 }}>{Number(item.avg_score).toFixed(1)}</div>
                </div>
              ))}
              <div style={{ height: 24 }} />
            </div>
          )
        ) : (
          <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🔜</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>Coming soon</div>
            <div style={{ fontSize: 13, color: C.muted }}>City and World rankings open up as more people collect</div>
          </div>
        )}
      </div>

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
function ProfileScreen({ user, collection, nycTotal, onSignOut, isAdmin, pendingReports = 0, onOpenAdmin, onOpenInvite, following = [], onUnfollow, onOpenFind }) {
  const nyc = collection.filter(i => i.venue?.city === 'NYC')
  const nycGoal = Math.max(nycTotal || 0, nyc.length, 1)
  const username = user.user_metadata?.username || user.email?.split('@')[0] || 'collector'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <SBar title="phillumeni" />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
            <Av ini={username.slice(0, 2).toUpperCase()} bg={C.purpleBg} tc={C.purple} size={64} />
            <button onClick={onSignOut} style={{ fontSize: 12, color: C.muted, background: 'none', border: `0.5px solid ${C.border}`, borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>Sign out</button>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text, letterSpacing: '-.3px', marginBottom: 2 }}>{username}</div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>{user.email}</div>

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
                  <div style={{ width: 34, height: 34, borderRadius: '50%', background: C.purpleBg, color: C.purple, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{(f.username || '?').slice(0, 2).toUpperCase()}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.username}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{f.matchbooks} {f.matchbooks === 1 ? 'matchbook' : 'matchbooks'}</div>
                  </div>
                  <button onClick={() => onUnfollow?.(f.id)} style={{ flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '5px 12px', borderRadius: 99, border: `1px solid ${C.border}`, background: 'transparent', color: C.sec, cursor: 'pointer' }}>Following</button>
                </div>
              ))
            )}
          </div>

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
            {[{ n: collection.length, l: 'matchbooks' }, { n: new Set(collection.map(i => i.venue?.city)).size, l: 'cities' }, { n: collection.filter(i => (i.venue?.sources || []).length >= 2).length, l: 'verified' }].map((s, i) => (
              <div key={i} style={{ background: C.surface, borderRadius: 12, padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{s.n}</div>
                <div style={{ fontSize: 9, color: C.muted, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 600, marginTop: 1 }}>{s.l}</div>
              </div>
            ))}
          </div>

          {nyc.length > 0 && (
            <Card style={{ padding: '11px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>NYC progress</div>
                <div style={{ fontSize: 12, color: C.muted }}>{nyc.length} of {nycGoal} found</div>
              </div>
              <div style={{ height: 5, background: C.surface, borderRadius: 3 }}>
                <div style={{ height: 5, background: C.green, borderRadius: 3, width: `${Math.min(100, Math.max(3, Math.round(nyc.length / nycGoal * 100)))}%` }} />
              </div>
            </Card>
          )}
        </div>

        {collection.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: C.muted, fontSize: 13 }}>Start collecting to build your profile</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, padding: 2 }}>
            {collection.map(item => item.venue && (
              <div key={item.id} style={{ aspectRatio: '1', background: item.photo_url ? `#000 url("${item.photo_url}") center/cover no-repeat` : (item.venue.bg_color || '#1A1A1A'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, position: 'relative' }}>
                {!item.photo_url && item.venue.emoji}
                {item.venue.status === 'closed' && (
                  <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.72)', color: '#fff', fontSize: 8, fontWeight: 700, letterSpacing: .3, padding: '1px 5px', borderRadius: 99 }}>CLOSED</div>
                )}
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent,rgba(0,0,0,0.6))', padding: '12px 4px 4px' }}>
                  <div style={{ fontSize: 9, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

// ─── INVITE SCREEN ───────────────────────────────────────
// PWA invite: a personal link ({origin}/?invite=<username>) + the native share
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
function FindCollectors({ onFollow, onUnfollow, onBack }) {
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
          <input value={q} onChange={e => onChange(e.target.value)} placeholder="Search by username" autoFocus
            style={{ width: '100%', padding: '12px 12px 12px 40px', border: `1.5px solid ${q ? C.dark : C.border}`, borderRadius: 13, background: C.card, color: C.text, fontSize: 14, fontWeight: 500, outline: 'none' }} />
          {searching && <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, borderRadius: '50%', border: `2px solid ${C.border}`, borderTop: `2px solid ${C.dark}`, animation: 'spin 1s linear infinite' }} />}
        </div>
        {err && <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{err}</div>}
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 24px' }}>
        {results.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 0', borderBottom: `0.5px solid ${C.border}` }}>
            <div style={{ width: 38, height: 38, borderRadius: '50%', background: C.purpleBg, color: C.purple, fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{(r.username || '?').slice(0, 2).toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.username}</div>
              <div style={{ fontSize: 11, color: C.muted }}>{r.matchbooks} {r.matchbooks === 1 ? 'matchbook' : 'matchbooks'}</div>
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
          <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: C.muted, fontSize: 13, lineHeight: 1.6 }}>Search a username to follow other collectors and compare lists.</div>
        )}
      </div>
    </div>
  )
}

// ─── ADMIN: REPORTED PHOTOS QUEUE (spec §4/§5) ───────────
// Gated by profiles.is_admin. Accept → delete venue (FK cascade clears every
// collector's copy + score). Reject → mark resolved, venue untouched.
function AdminQueue({ reports, venues, onAccept, onReject, onBack }) {
  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))
  const [names, setNames] = useState({}) // user id → username (best-effort, admin read)
  const [busyId, setBusyId] = useState(null)

  // Venue comes from the embedded FK join (r.venue); fall back to the client
  // array. Never drop a report — keep the queue count in sync with the badge.
  const enriched = reports.map(r => ({ ...r, venue: r.venue || venueMap[r.venue_id] }))

  // Resolve submitter + reporter usernames (needs migration 008's admin-read on
  // profiles; degrades to "a collector" if absent).
  useEffect(() => {
    const ids = [...new Set(enriched.flatMap(r => [r.reporter_id, r.venue?.created_by]).filter(Boolean))]
    if (!ids.length) return
    supabase.from('profiles').select('id, username').in('id', ids).then(({ data }) => {
      if (data) setNames(Object.fromEntries(data.map(p => [p.id, p.username])))
    })
  }, [reports]) // eslint-disable-line react-hooks/exhaustive-deps

  const uname = (id) => (id && names[id]) ? '@' + names[id] : 'a collector'

  const accept = async (r) => { setBusyId(r.id); await onAccept(r.venue_id, r.id); setBusyId(null) }
  const reject = async (r) => { setBusyId(r.id); await onReject(r.id); setBusyId(null) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: C.bg }}>
      <SBar />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px 0', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: C.amber, fontSize: 13, fontWeight: 700 }}>
          <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />Profile
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 24px' }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: '-.6px', marginTop: 6 }}>Reported photos</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 18 }}>{enriched.length} pending</div>

        {enriched.length === 0 ? (
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
  const [mode, setMode] = useState('signup') // signup | login
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const handleSubmit = async () => {
    setLoading(true)
    setError('')
    setNotice('')
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: username || email.split('@')[0] } },
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

  const inputStyle = {
    display: 'block', width: '100%', padding: '13px 14px',
    border: `1.5px solid rgba(255,255,255,0.14)`, borderRadius: 13,
    background: 'rgba(255,255,255,0.07)', color: '#fff', fontSize: 14,
    fontWeight: 500, marginBottom: 10, outline: 'none',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1A1918' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 22px 0', fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>
        <span>9:41</span>
        <span style={{ display: 'flex', gap: 4 }}><i className="ti ti-wifi" style={{ fontSize: 12 }} /><i className="ti ti-battery-2" style={{ fontSize: 12 }} /></span>
      </div>

      <div style={{ flex: 1, padding: '24px 24px 0', overflowY: 'auto' }}>
        <div style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <MbIcon size={60} />
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 24, fontWeight: 300, color: '#fff', letterSpacing: '-.4px' }}>phillumeni</div>
        </div>

        <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-.4px', marginBottom: 4 }}>
          {mode === 'signup' ? 'Create account' : 'Welcome back'}
        </div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginBottom: 22 }}>
          {mode === 'signup' ? 'Free forever. Start collecting.' : 'Sign in to your collection.'}
        </div>

        {mode === 'signup' && (
          <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username" style={inputStyle} />
        )}
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" type="email" style={inputStyle} />
        <input value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" type="password" style={inputStyle} />

        {notice && <div style={{ color: '#6ACBAB', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>{notice}</div>}
        {error && <div style={{ color: '#F08080', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>{error}</div>}

        <button onClick={handleSubmit} disabled={loading || !email || !password}
          style={{ width: '100%', padding: 15, background: loading ? 'rgba(200,123,10,0.5)' : '#C87B0A', color: '#fff', border: 'none', borderRadius: 13, fontSize: 15, fontWeight: 700, cursor: loading ? 'default' : 'pointer', letterSpacing: '-.2px', marginTop: 4, marginBottom: 14, boxShadow: '0 2px 12px rgba(200,123,10,0.35)' }}>
          {loading ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>

        <div style={{ textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.35)' }}>
          {mode === 'signup' ? 'Already have an account? ' : 'New here? '}
          <span onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); setNotice('') }} style={{ color: C.amber, cursor: 'pointer', fontWeight: 700 }}>
            {mode === 'signup' ? 'Sign in' : 'Create account'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── TAB BAR ─────────────────────────────────────────────
function TabBar({ active, onNav }) {
  const tabs = [
    { id: 'explore', icon: 'ti-map', l: 'Explore' },
    { id: 'rankings', icon: 'ti-trophy', l: 'Rankings' },
    { id: 'collection', icon: 'ti-stack-2', l: 'Collection' },
    { id: 'profile', icon: 'ti-user', l: 'Profile' },
  ]
  return (
    <div style={{ borderTop: `0.5px solid ${C.border}`, display: 'flex', padding: '9px 0 20px', flexShrink: 0, background: C.card }}>
      {tabs.map(t => (
        <div key={t.id} onClick={() => onNav(t.id)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
          <div style={{ width: 30, height: 28, borderRadius: 8, background: active === t.id ? C.amberBg : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background .15s' }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 20, color: active === t.id ? C.amber : C.muted, transition: 'color .15s' }} />
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
  const [venuesError, setVenuesError] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [fakeReports, setFakeReports] = useState([]) // pending fake_reports (admin only)
  const [showAdmin, setShowAdmin] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showFind, setShowFind] = useState(false)
  const [following, setFollowing] = useState([]) // [{ id, username, matchbooks }]
  const [sheetOpen, setSheetOpen] = useState(false) // a bottom sheet is open → hide TabBar

  // Auth state
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user)
      setAuthLoading(false)
      if (!user) setShowAuth(true)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setUser(session?.user || null)
      if (!session?.user) setShowAuth(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  // Capture an inbound invite link (?invite=<username>) once, stash it, and clean
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

  // Load this user's reports so flagged venues stay hidden across reloads
  useEffect(() => {
    if (!user) { setReported([]); return }
    supabase
      .from('reports')
      .select('venue_id')
      .eq('user_id', user.id)
      .then(({ data, error }) => {
        if (error) { console.error('Failed to load reports', error); return }
        setReported(data || [])
      })
  }, [user])

  // Am I an admin? (own profile is readable under the owner-only SELECT policy)
  useEffect(() => {
    if (!user) { setIsAdmin(false); return }
    supabase.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
      .then(({ data, error }) => { if (!error) setIsAdmin(!!data?.is_admin) })
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
    if (!user) return
    // Insert and read back the real row so local state carries the DB serial id
    // (otherwise a same-session Remove deletes by a Date.now() id and silently no-ops).
    const { data, error } = await supabase
      .from('collections')
      .insert({ user_id: user.id, venue_id: venue.id })
      .select()
      .single()
    if (!error && data) {
      setCollection(prev => [data, ...prev])
    }
  }

  const handleRemoveFromCollection = async (collectionId) => {
    await supabase.from('collections').delete().eq('id', collectionId)
    setCollection(prev => prev.filter(i => i.id !== collectionId))
  }

  const handleFlag = async (venueId) => {
    if (!user) return false
    // upsert + ignoreDuplicates so a re-flag after reload doesn't hit the unique constraint
    const { error } = await supabase
      .from('reports')
      .upsert({ user_id: user.id, venue_id: venueId }, { onConflict: 'user_id,venue_id', ignoreDuplicates: true })
    if (error) { console.error('Flag failed', error); return false }
    setReported(prev => (prev.some(r => r.venue_id === venueId) ? prev : [...prev, { venue_id: venueId }]))
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
    if (error) { console.error('Accept (delete venue) failed', error); return }
    setVenues(prev => prev.filter(v => v.id !== venueId))
    setCollection(prev => prev.filter(c => c.venue_id !== venueId))
    setReported(prev => prev.filter(r => r.venue_id !== venueId))
    setFakeReports(prev => prev.filter(r => r.venue_id !== venueId))
  }

  // Admin: Reject — keep the venue, mark the report resolved (spec §4).
  const handleRejectReport = async (reportId) => {
    const { error } = await supabase
      .from('fake_reports')
      .update({ status: 'rejected', resolved_by: user.id, resolved_at: new Date().toISOString() })
      .eq('id', reportId)
    if (error) { console.error('Reject report failed', error); return }
    setFakeReports(prev => prev.filter(r => r.id !== reportId))
  }

  const handleAdded = (newVenue, collectionRow) => {
    // newVenue may already exist locally (dedup link), so upsert rather than append
    setVenues(prev => (prev.some(v => v.id === newVenue.id) ? prev : [...prev, newVenue]))
    if (collectionRow) {
      // replace in place if it already exists (e.g. a re-collect that added a photo)
      setCollection(prev => (prev.some(c => c.id === collectionRow.id)
        ? prev.map(c => (c.id === collectionRow.id ? collectionRow : c))
        : [collectionRow, ...prev]))
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    setCollection([])
    setReported([])
    setIsAdmin(false)
    setFakeReports([])
    setFollowing([])
    setShowAdmin(false)
    setShowInvite(false)
    setShowFind(false)
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

  const phoneStyle = {
    maxWidth: 390,
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

  if (showAuth || !user) {
    return (
      <div style={phoneStyle}>
        <AuthScreen onDone={() => setShowAuth(false)} />
      </div>
    )
  }

  return (
    <div style={phoneStyle}>
      {showSubmit ? (
        <Submit
          onBack={() => setShowSubmit(false)}
          onAdded={handleAdded}
          user={user}
          rankedItems={rankedItems}
          onRankingDone={() => { refreshCollection(); setShowSubmit(false); setTab('rankings') }}
          onSheetOpenChange={setSheetOpen}
        />
      ) : showAdmin ? (
        <AdminQueue
          reports={fakeReports}
          venues={venues}
          onAccept={handleAcceptReport}
          onReject={handleRejectReport}
          onBack={() => setShowAdmin(false)}
        />
      ) : showInvite ? (
        <InviteScreen user={user} onBack={() => setShowInvite(false)} />
      ) : showFind ? (
        <FindCollectors onFollow={handleFollow} onUnfollow={handleUnfollow} onBack={() => setShowFind(false)} />
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
            />
          )}
          {tab === 'rankings' && (
            <Rankings collection={collection} venues={venues} onFlag={handleFlag} onFakeReport={handleFakeReport} onSheetOpenChange={setSheetOpen} />
          )}
          {tab === 'collection' && (
            <Collection
              items={enrichedCollection}
              venues={venues}
              onRemove={handleRemoveFromCollection}
            />
          )}
          {tab === 'profile' && (
            <ProfileScreen
              user={user}
              collection={enrichedCollection}
              nycTotal={venues.filter(v => v.city === 'NYC').length}
              onSignOut={handleSignOut}
              isAdmin={isAdmin}
              pendingReports={fakeReports.length}
              onOpenAdmin={() => setShowAdmin(true)}
              onOpenInvite={() => setShowInvite(true)}
              following={following}
              onUnfollow={handleUnfollow}
              onOpenFind={() => setShowFind(true)}
            />
          )}
        </>
      )}
      {!showAdmin && !showInvite && !showFind && !sheetOpen && <TabBar active={tab} onNav={setTab} />}
    </div>
  )
}
