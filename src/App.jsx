import { useState, useEffect, useRef, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import { supabase } from './supabase.js'

// ─── CONFIG ─────────────────────────────────────────────
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const NYC = { lng: -74.006, lat: 40.7128 }

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

const pinColor = (v) => {
  if (v.friend) return C.purple
  if (v.sources?.length >= 2) return C.amber
  if (!v.is_open) return '#9C9990'
  return C.green
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
function AppMap({ venues, collectionIds, reportedIds, onSelectVenue, selectedVenue, filter }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const geolocateRef = useRef(null)

  // Init map
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return
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

    map.on('load', () => {
      geolocate.trigger()
    })

    mapRef.current = map
    geolocateRef.current = geolocate

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Update markers when data changes
  useEffect(() => {
    if (!mapRef.current) return

    // Clear old markers
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []

    const visible = venues.filter(v => {
      if (collectionIds.includes(v.id)) return false
      if (reportedIds.includes(v.id)) return false
      if (filter === 'open') return v.is_open
      if (filter === 'multi') return (v.sources || []).length >= 2
      return true
    })

    visible.forEach(v => {
      const isSelected = selectedVenue?.id === v.id
      const color = pinColor(v)

      const el = document.createElement('div')
      el.style.cssText = [
        `width:${isSelected ? 34 : 28}px`,
        `height:${isSelected ? 34 : 28}px`,
        'border-radius:50%',
        `background:${color}`,
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
      el.textContent = v.is_open ? '✦' : '·'
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        onSelectVenue(isSelected ? null : v)
      })

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([v.lng, v.lat])
        .addTo(mapRef.current)

      markersRef.current.push(marker)
    })
  }, [venues, collectionIds, reportedIds, selectedVenue, filter])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

// ─── EXPLORE SCREEN ──────────────────────────────────────
function Explore({ venues, collectionIds, reported, onCollect, onFlag, onSubmit }) {
  const [selected, setSelected] = useState(null)
  const [filter, setFilter] = useState('all')
  const reportedIds = reported.map(r => r.venue_id)

  const listed = venues
    .filter(v => {
      if (collectionIds.includes(v.id)) return false
      if (reportedIds.includes(v.id)) return false
      if (filter === 'open') return v.is_open
      if (filter === 'multi') return (v.sources || []).length >= 2
      return true
    })
    .slice(0, 8)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
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
        {/* Filter chips */}
        <div style={{ position: 'absolute', bottom: 10, left: 0, right: 0, display: 'flex', gap: 6, padding: '0 10px', overflowX: 'auto' }}>
          {[{ id: 'all', l: 'All' }, { id: 'open', l: 'Open now' }, { id: 'multi', l: '2+ sources' }].map(f => (
            <button key={f.id} onClick={() => { setFilter(f.id); setSelected(null) }}
              style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, padding: '5px 13px', borderRadius: 99, border: '1.5px solid', cursor: 'pointer', boxShadow: '0 1px 6px rgba(0,0,0,0.12)', transition: 'all .15s', background: filter === f.id ? C.dark : '#fff', color: filter === f.id ? '#fff' : C.sec, borderColor: filter === f.id ? C.dark : C.border }}>
              {f.l}
            </button>
          ))}
        </div>
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
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
              <Tag label={selected.is_open ? 'Open now' : 'Closed'} bg={selected.is_open ? C.greenBg : C.surface} color={selected.is_open ? C.green : C.muted} />
              <Tag label={selected.type} bg={C.surface} color={C.sec} />
              {(selected.sources || []).length >= 2 && <Tag label={`${selected.sources.length} sources`} bg={C.amberBg} color={C.amber} />}
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
              {(selected.sources || []).map(s => (
                <span key={s} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 99, background: C.surface, border: `0.5px solid ${C.border}`, color: C.sec }}>{s}</span>
              ))}
            </div>
            {selected.note && <div style={{ fontSize: 12, color: C.muted, fontStyle: 'italic', marginBottom: 14, lineHeight: 1.5 }}>{selected.note}</div>}
            {reportedIds.includes(selected.id) ? (
              <div style={{ padding: 12, background: C.redBg, borderRadius: 12, fontSize: 13, color: C.red, textAlign: 'center', fontWeight: 500 }}>Reported as unavailable</div>
            ) : (
              <>
                <PrimaryBtn onClick={() => { onCollect(selected); setSelected(null) }} style={{ marginBottom: 8 }}>Got it — add to collection</PrimaryBtn>
                <OutlineBtn onClick={() => { onFlag(selected.id); setSelected(null) }} color={C.red}>
                  <i className="ti ti-alert-triangle" style={{ fontSize: 12, marginRight: 5 }} />Not available here
                </OutlineBtn>
              </>
            )}
          </div>
        ) : (
          <div style={{ padding: '12px 16px 8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{listed.length} spots nearby</div>
              <div style={{ fontSize: 11, color: C.muted }}>collected spots hidden</div>
            </div>
            {listed.map(v => (
              <div key={v.id} onClick={() => setSelected(v)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: `0.5px solid ${C.border}`, cursor: 'pointer' }}>
                <div style={{ width: 38, height: 38, borderRadius: 11, background: v.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>{v.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{v.neighborhood}</div>
                </div>
                <Tag label={v.is_open ? 'Open' : 'Closed'} bg={v.is_open ? C.greenBg : C.surface} color={v.is_open ? C.green : C.muted} />
              </div>
            ))}
            {listed.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: C.muted, fontSize: 13 }}>
                No spots to find — you may have collected them all! 🔥
              </div>
            )}
          </div>
        )}
      </div>
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
  const hoods = [...new Set(collected.map(i => i.venue.neighborhood))]

  if (detail) {
    const v = detail.venue
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <SBar title="Collection" />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ padding: '10px 16px 0' }}>
            <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', fontSize: 13, color: C.amber, cursor: 'pointer', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0 12px' }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 13 }} /> Collection
            </button>
          </div>
          <div style={{ width: '100%', height: 210, background: v.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 72 }}>{v.emoji}</div>
          <div style={{ padding: '16px 16px 28px' }}>
            <div style={{ fontSize: 19, fontWeight: 700, color: C.text, letterSpacing: '-.3px', marginBottom: 4 }}>{v.name}</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>{v.address}</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
              <Tag label={`Collected ${new Date(detail.collected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`} bg={C.greenBg} color={C.green} />
              <Tag label={v.type} bg={C.surface} color={C.sec} />
            </div>
            <div style={{ background: C.surface, borderRadius: 12, padding: '10px 12px', fontSize: 12, color: C.sec, marginBottom: 14, lineHeight: 1.5 }}>
              <i className="ti ti-camera" style={{ fontSize: 12, marginRight: 6, color: C.muted }} />Your photo of the matchbook
            </div>
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
                <div style={{ fontSize: 12, color: C.muted }}>{nyc.length} of 20 found</div>
              </div>
              <div style={{ height: 5, background: C.surface, borderRadius: 3 }}>
                <div style={{ height: 5, background: C.green, borderRadius: 3, width: `${Math.max(3, Math.round(nyc.length / 20 * 100))}%`, transition: 'width .5s' }} />
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
              <div key={item.id} onClick={() => setDetail(item)} style={{ aspectRatio: '1', background: item.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, cursor: 'pointer', position: 'relative' }}>
                {item.venue.emoji}
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
                <div style={{ width: 52, height: 52, borderRadius: 10, background: item.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>{item.venue.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.venue.name}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{item.venue.neighborhood} · {item.venue.city}</div>
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
function Submit({ onBack, onAdded, user }) {
  const [step, setStep] = useState(1)
  const [photo, setPhoto] = useState(false)
  const [aiState, setAiState] = useState(null) // null | 'loading' | 'confirmed'
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(null)
  const [adding, setAdding] = useState(false)
  const searchTimer = useRef(null)

  const fakePhotoUpload = () => {
    setPhoto(true)
    setAiState('loading')
    setTimeout(() => setAiState('confirmed'), 1400)
  }

  const searchVenues = async (q) => {
    if (q.length < 2) { setResults([]); return }
    setSearching(true)
    try {
      // Use Mapbox Geocoding to search for venues
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?` +
        `types=poi&proximity=${NYC.lng},${NYC.lat}&limit=5&access_token=${MAPBOX_TOKEN}`
      )
      const data = await res.json()
      const places = (data.features || []).map(f => ({
        id: f.id,
        name: f.text,
        address: f.place_name,
        lat: f.center[1],
        lng: f.center[0],
        type: f.properties?.category || 'Restaurant',
      }))
      setResults(places)
    } catch (e) {
      setResults([])
    }
    setSearching(false)
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
    try {
      // Insert venue into Supabase
      const { data: venue, error: venueErr } = await supabase
        .from('venues')
        .insert({
          name: picked.name,
          address: picked.address.split(',').slice(0, 2).join(','),
          neighborhood: picked.address.split(',')[1]?.trim() || 'NYC',
          city: 'NYC',
          lat: picked.lat,
          lng: picked.lng,
          type: picked.type,
          emoji: '🔥',
          bg_color: '#281808',
          sources: ['Submitted by ' + (user.email?.split('@')[0] || 'user')],
          created_by: user.id,
          verified: false,
        })
        .select()
        .single()

      if (venueErr) throw venueErr

      // Add to collection — capture the real row (serial id) and surface errors
      const { data: collectionRow, error: collErr } = await supabase
        .from('collections')
        .insert({ user_id: user.id, venue_id: venue.id })
        .select()
        .single()
      if (collErr) throw collErr

      onAdded(venue, collectionRow)
      setStep(3)
    } catch (e) {
      console.error(e)
      alert('Something went wrong. Try again.')
    }
    setAdding(false)
  }

  const Steps = () => (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
      {[1, 2, 3].map(s => (
        <div key={s} style={{ height: 4, borderRadius: 2, width: s === step ? 28 : 12, background: s === step ? C.dark : s < step ? C.amber : C.border, transition: 'all .2s' }} />
      ))}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: C.bg }}>
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
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.5 }}>Take a photo to verify and add it to the map instantly.</div>

            {!photo ? (
              <div onClick={fakePhotoUpload} style={{ border: `2px dashed ${C.border}`, borderRadius: 18, height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, cursor: 'pointer', background: C.surface }}>
                <div style={{ width: 60, height: 60, background: C.dark, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <i className="ti ti-camera" style={{ fontSize: 26, color: '#fff' }} />
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Take a photo</div>
                <div style={{ fontSize: 12, color: C.muted }}>or upload from your library</div>
              </div>
            ) : (
              <div style={{ borderRadius: 18, height: 200, background: '#2A2824', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, position: 'relative', marginBottom: 16 }}>
                <div style={{ fontSize: 64 }}>🔥</div>
                {aiState === 'loading' && (
                  <div style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.75)', borderRadius: 99, padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.25)', borderTop: '2px solid #fff', animation: 'spin 1s linear infinite' }} />
                    <span style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>Analyzing photo…</span>
                  </div>
                )}
                {aiState === 'confirmed' && (
                  <div style={{ position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', background: 'rgba(26,148,112,0.92)', borderRadius: 99, padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <i className="ti ti-check" style={{ fontSize: 13, color: '#fff' }} />
                    <span style={{ fontSize: 12, color: '#fff', fontWeight: 700 }}>Matchbook detected</span>
                  </div>
                )}
                <button onClick={() => { setPhoto(false); setAiState(null) }} style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: 99, padding: '4px 12px', fontSize: 11, color: '#fff', cursor: 'pointer' }}>Retake</button>
              </div>
            )}
            <PrimaryBtn onClick={() => setStep(2)} disabled={aiState !== 'confirmed'} style={{ marginTop: 16 }}>
              {aiState === 'loading' ? 'Verifying…' : aiState === 'confirmed' ? 'Next — find the venue' : 'Take a photo first'}
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

            {results.length > 0 && (
              <Card style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
                {results.map((r, i) => (
                  <div key={r.id} onClick={() => { setPicked(r); setQuery(r.name) }}
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
            <PrimaryBtn onClick={onBack} style={{ marginBottom: 10 }}>Back to map</PrimaryBtn>
            <OutlineBtn onClick={() => { setStep(1); setPhoto(false); setAiState(null); setQuery(''); setResults([]); setPicked(null) }}>Submit another</OutlineBtn>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── PROFILE SCREEN ──────────────────────────────────────
function ProfileScreen({ user, collection, onSignOut }) {
  const nyc = collection.filter(i => i.venue?.city === 'NYC')
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
                <div style={{ fontSize: 12, color: C.muted }}>{nyc.length} of 20 found</div>
              </div>
              <div style={{ height: 5, background: C.surface, borderRadius: 3 }}>
                <div style={{ height: 5, background: C.green, borderRadius: 3, width: `${Math.max(3, Math.round(nyc.length / 20 * 100))}%` }} />
              </div>
            </Card>
          )}
        </div>

        {collection.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: C.muted, fontSize: 13 }}>Start collecting to build your profile</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, padding: 2 }}>
            {collection.map(item => item.venue && (
              <div key={item.id} style={{ aspectRatio: '1', background: item.venue.bg_color || '#1A1A1A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, position: 'relative' }}>
                {item.venue.emoji}
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

        {mode === 'signup' && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center', lineHeight: 1.5, marginBottom: 16 }}>
            Check your email to confirm your account after signing up
          </div>
        )}

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

  // Load venues
  useEffect(() => {
    supabase.from('venues').select('*').order('name').then(({ data }) => {
      if (data) setVenues(data)
    })
  }, [])

  // Load collection
  useEffect(() => {
    if (!user) return
    supabase
      .from('collections')
      .select('*')
      .eq('user_id', user.id)
      .order('collected_at', { ascending: false })
      .then(({ data }) => {
        if (data) setCollection(data)
      })
  }, [user])

  // Load this user's reports so flagged venues stay hidden across reloads
  useEffect(() => {
    if (!user) { setReported([]); return }
    supabase
      .from('reports')
      .select('venue_id')
      .eq('user_id', user.id)
      .then(({ data }) => {
        if (data) setReported(data)
      })
  }, [user])

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
    if (!user) return
    // upsert + ignoreDuplicates so a re-flag after reload doesn't hit the unique constraint
    const { error } = await supabase
      .from('reports')
      .upsert({ user_id: user.id, venue_id: venueId }, { onConflict: 'user_id,venue_id', ignoreDuplicates: true })
    if (!error) {
      setReported(prev => (prev.some(r => r.venue_id === venueId) ? prev : [...prev, { venue_id: venueId }]))
    }
  }

  const handleAdded = (newVenue, collectionRow) => {
    setVenues(prev => [...prev, newVenue])
    if (collectionRow) setCollection(prev => [collectionRow, ...prev])
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    setCollection([])
    setReported([])
    setShowAuth(true)
  }

  // Enrich collection with venue data
  const venueMap = Object.fromEntries(venues.map(v => [v.id, v]))
  const enrichedCollection = collection.map(item => ({ ...item, venue: venueMap[item.venue_id] }))
  const collectionIds = collection.map(i => i.venue_id)

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
        <Submit onBack={() => setShowSubmit(false)} onAdded={handleAdded} user={user} />
      ) : (
        <>
          {tab === 'explore' && (
            <Explore
              venues={venues}
              collectionIds={collectionIds}
              reported={reported}
              onCollect={handleCollect}
              onFlag={handleFlag}
              onSubmit={() => setShowSubmit(true)}
            />
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
              onSignOut={handleSignOut}
            />
          )}
        </>
      )}
      <TabBar active={tab} onNav={setTab} />
    </div>
  )
}
