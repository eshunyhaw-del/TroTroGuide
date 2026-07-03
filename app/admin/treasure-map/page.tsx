'use client';
// ============================================================================
// PHASE 2 — Internal admin "Treasure Map" dashboard.
// ============================================================================
// Browse the ODbL OSM scaffold (stops + routes + freshness) and record YOUR
// field verifications (exists? mate shout, local name, YOUR GPS). Saved to
// IndexedDB on THIS device only — never synced. Export feeds the Phase 4
// promote-to-core pipeline. The public app never sees any of this.
//
// Offline-first: data is a static JSON (public/admin/osm-data.json), no backend.
// Auth is obscurity only (a token that ships in the client bundle) — enough to
// keep the page off random users, NOT real security. Don't put secrets here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildExport,
  CHANGE_TYPES,
  listNewStops,
  listRouteChanges,
  loadVerificationMap,
  saveNewStop,
  saveRouteChange,
  saveVerification,
  type BoardAlight,
  type NewStop,
  type RouteChange,
  type Verification,
} from '@/lib/admin/verification-store';

// Obscurity, NOT security — this string ships in the client bundle and the data
// it gates (/admin/osm-data.json) is public ODbL scaffold anyway. Rotated off the
// old published default; put nothing sensitive behind this. Real access control
// would require a server-side auth check, which this static page has by design not.
const ADMIN_KEY = 'tg-fieldwork-x7q29m';
const DATA_URL = '/admin/osm-data.json';
const MAX_RENDER = 400; // cap visible cards so low-end phones stay snappy

type Bucket = 'fresh' | 'stale' | 'verystale' | 'ghost';

interface Stop {
  ref: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  edited: string | null;
  bucket: Bucket;
  routes: string[];
  hood: string | null;
}
interface Route {
  ref: string;
  relRef: string;
  name: string;
  from: string;
  to: string;
  operator: string | null;
  trotro: boolean;
  bucket: Bucket;
  stops: string[];
}
interface StopIndexRec { name: string | null; lat: number | null; lng: number | null; bucket: Bucket }
interface AdminData {
  generatedAt: string;
  attribution: string;
  summary: { stops: number; named: number; routes: number; trotroRoutes: number; neighborhoods: number; fresh: number; stale: number; verystale: number; ghost: number };
  neighborhoods: { name: string; routeCount: number }[];
  stops: Stop[];
  routes: Route[];
  stopIndex: Record<string, StopIndexRec>;
}

const BUCKET_LABEL: Record<Bucket, string> = { fresh: 'Fresh', stale: 'Stale', verystale: 'Very stale', ghost: 'Ghost' };

function download(name: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
export default function AdminTreasureMap() {
  const [authed, setAuthed] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [data, setData] = useState<AdminData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [verif, setVerif] = useState<Map<string, Verification>>(new Map());

  const [newStops, setNewStops] = useState<NewStop[]>([]);
  const [routeChanges, setRouteChanges] = useState<RouteChange[]>([]);

  const [view, setView] = useState<'stops' | 'routes'>('stops');
  const [q, setQ] = useState('');
  const [hood, setHood] = useState('');
  const [bucket, setBucket] = useState<Bucket | 'all'>('all');
  const [unverifiedOnly, setUnverifiedOnly] = useState(false);

  // --- auth gate ---
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('key');
    const stored = localStorage.getItem('tg-admin-key');
    if (fromUrl === ADMIN_KEY) {
      localStorage.setItem('tg-admin-key', ADMIN_KEY);
      setAuthed(true);
    } else if (stored === ADMIN_KEY) {
      setAuthed(true);
    }
  }, []);

  // --- load data + verifications once authed ---
  useEffect(() => {
    if (!authed) return;
    fetch(DATA_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} loading ${DATA_URL}`); return r.json(); })
      .then((d: AdminData) => setData(d))
      .catch((e) => setErr(String(e.message ?? e)));
    loadVerificationMap().then(setVerif).catch(() => setErr('Could not open local verification store'));
    listNewStops().then(setNewStops).catch(() => {});
    listRouteChanges().then(setRouteChanges).catch(() => {});
  }, [authed]);

  const onSaved = useCallback((v: Verification) => {
    setVerif((prev) => new Map(prev).set(v.osmRef, v));
  }, []);
  const onNewStop = useCallback((s: NewStop) => {
    setNewStops((prev) => [...prev.filter((x) => x.stopId !== s.stopId), s]);
  }, []);
  const onRouteChange = useCallback((c: RouteChange) => {
    setRouteChanges((prev) => [...prev.filter((x) => x.id !== c.id), c]);
  }, []);

  const newStopsByRoute = useMemo(() => {
    const m = new Map<string, NewStop[]>();
    for (const s of newStops) m.set(s.routeRef, [...(m.get(s.routeRef) ?? []), s]);
    return m;
  }, [newStops]);

  const stopByRef = useMemo(() => {
    const m = new Map<string, Stop>();
    if (data) for (const s of data.stops) m.set(s.ref, s);
    return m;
  }, [data]);

  const stopsFiltered = useMemo(() => {
    if (!data) return [];
    const t = q.trim().toLowerCase();
    return data.stops.filter((s) => {
      if (hood && s.hood !== hood) return false;
      if (bucket !== 'all' && s.bucket !== bucket) return false;
      if (unverifiedOnly && verif.has(s.ref)) return false;
      if (t && !(s.name || '').toLowerCase().includes(t) && !s.ref.includes(t) && !s.routes.some((r) => r.toLowerCase().includes(t)))
        return false;
      return true;
    });
  }, [data, q, hood, bucket, unverifiedOnly, verif]);

  const routesFiltered = useMemo(() => {
    if (!data) return [];
    const t = q.trim().toLowerCase();
    return data.routes.filter((r) => {
      if (!r.trotro) return false;
      if (hood && r.from !== hood && r.to !== hood) return false;
      if (bucket !== 'all' && r.bucket !== bucket) return false;
      if (t && ![r.ref, r.name, r.from, r.to, r.operator || ''].join(' ').toLowerCase().includes(t)) return false;
      return true;
    });
  }, [data, q, hood, bucket]);

  const progress = useMemo(() => {
    if (!data) return null;
    const total = data.stops.length;
    const byBucket: Record<string, number> = {};
    const byHood: Record<string, number> = {};
    let counted = 0;
    for (const v of verif.values()) {
      const s = stopByRef.get(v.osmRef);
      if (!s) continue; // verification on a route-only node not in primary list
      counted += 1;
      byBucket[s.bucket] = (byBucket[s.bucket] ?? 0) + 1;
      if (s.hood) byHood[s.hood] = (byHood[s.hood] ?? 0) + 1;
    }
    const topHoods = Object.entries(byHood).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { total, counted, pct: total ? Math.round((counted / total) * 100) : 0, byBucket, topHoods };
  }, [data, verif, stopByRef]);

  // --- auth gate UI ---
  if (!authed) {
    return (
      <main className="adm">
        <h1>🔒 Treasure Map — admin</h1>
        <p className="adm-muted">Internal fieldwork tool. Enter the access key.</p>
        <input
          className="tk-input"
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="access key"
        />
        <button
          className="tk-btn"
          onClick={() => {
            if (keyInput === ADMIN_KEY) { localStorage.setItem('tg-admin-key', ADMIN_KEY); setAuthed(true); }
            else setErr('Wrong key');
          }}
        >
          Unlock
        </button>
        {err && <p style={{ color: '#b00' }}>{err}</p>}
      </main>
    );
  }

  if (err && !data) return <main className="adm"><p style={{ color: '#b00' }}>Error: {err}</p></main>;
  if (!data) return <main className="adm"><p>Loading OSM scaffold…</p></main>;

  return (
    <main className="adm">
      <div className="adm-banner">⚠ Internal ODbL scaffold for fieldwork planning, never shown in the public app, never sold.</div>
      <h1 style={{ margin: '8px 0' }}>🗺 Treasure Map — admin</h1>

      <div className="adm-stats">
        <span><b>{data.summary.stops}</b> OSM stops</span>
        <span><b>{data.summary.trotroRoutes}</b> routes</span>
        <span><span className="adm-dot adm-verystale" /><b>{data.summary.verystale}</b> very stale</span>
        <span><b>{verif.size}</b> verified</span>
        <span><b>{newStops.length}</b> new stops</span>
        <span><b>{routeChanges.length}</b> route changes</span>
      </div>

      {progress && (
        <details style={{ margin: '8px 0' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            📈 Your progress: {progress.counted} / {progress.total} stops ({progress.pct}%)
          </summary>
          <p className="adm-muted" style={{ margin: '6px 0' }}>
            By freshness — {(['fresh', 'stale', 'verystale', 'ghost'] as Bucket[]).map((b) => `${BUCKET_LABEL[b]}: ${progress.byBucket[b] ?? 0}`).join(' · ')}
          </p>
          {progress.topHoods.length > 0 && (
            <table style={{ fontSize: 13, borderCollapse: 'collapse' }}>
              <tbody>
                {progress.topHoods.map(([name, n]) => (
                  <tr key={name}><td style={{ padding: '2px 8px' }}>{name}</td><td style={{ padding: '2px 8px' }}>{n} verified</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </details>
      )}

      <div className="adm-controls">
        <input type="search" placeholder="Search name / route ref / OSM id…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={hood} onChange={(e) => setHood(e.target.value)}>
          <option value="">All areas</option>
          {data.neighborhoods.map((h) => <option key={h.name} value={h.name}>{h.name} ({h.routeCount})</option>)}
        </select>
        <button className={`adm-chip ${view === 'stops' ? 'on' : ''}`} onClick={() => setView('stops')}>Stops</button>
        <button className={`adm-chip ${view === 'routes' ? 'on' : ''}`} onClick={() => setView('routes')}>Routes</button>
        <ExportButton />
      </div>

      <div className="adm-controls" style={{ position: 'static', borderBottom: 'none' }}>
        {(['all', 'fresh', 'stale', 'verystale', 'ghost'] as const).map((b) => (
          <button key={b} className={`adm-chip ${bucket === b ? 'on' : ''}`} onClick={() => setBucket(b)}>
            {b === 'all' ? 'All' : BUCKET_LABEL[b as Bucket]}
            {b !== 'all' && <span className={`adm-dot adm-${b}`} />}
          </button>
        ))}
        {view === 'stops' && (
          <label className="adm-chip"><input type="checkbox" checked={unverifiedOnly} onChange={(e) => setUnverifiedOnly(e.target.checked)} /> unverified only</label>
        )}
      </div>

      {view === 'stops' ? (
        <StopList stops={stopsFiltered} verif={verif} onSaved={onSaved} />
      ) : (
        <div>
          <p className="adm-muted">{routesFiltered.length} route(s) — tap a route to verify stops, add new stops, or flag a change</p>
          {routesFiltered.slice(0, MAX_RENDER).map((r) => (
            <RouteCard
              key={r.relRef}
              route={r}
              index={data.stopIndex}
              verif={verif}
              onSaved={onSaved}
              newStops={newStopsByRoute.get(r.ref) ?? []}
              onNewStop={onNewStop}
              routeChange={routeChanges.find((c) => c.routeRef === r.ref)}
              onRouteChange={onRouteChange}
            />
          ))}
        </div>
      )}

      <p className="adm-muted" style={{ marginTop: 16 }}>{data.attribution} · OSM scaffold generated {data.generatedAt.slice(0, 10)}</p>
    </main>
  );
}

// ---------------------------------------------------------------------------
function ExportButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="adm-chip"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const payload = await buildExport();
          download(`trotro-verifications-${new Date().toISOString().slice(0, 10)}.json`, payload);
        } finally {
          setBusy(false);
        }
      }}
    >
      ⬇ Export my verifications
    </button>
  );
}

function StopList({ stops, verif, onSaved }: { stops: Stop[]; verif: Map<string, Verification>; onSaved: (v: Verification) => void }) {
  return (
    <div>
      <p className="adm-muted">
        {stops.length} stop(s){stops.length > MAX_RENDER ? ` — showing first ${MAX_RENDER}; refine area/freshness/search` : ''}
      </p>
      {stops.slice(0, MAX_RENDER).map((s) => (
        <StopCard key={s.ref} stop={s} verification={verif.get(s.ref)} onSaved={onSaved} />
      ))}
    </div>
  );
}

function RouteCard({ route, index, verif, onSaved, newStops, onNewStop, routeChange, onRouteChange }: {
  route: Route; index: Record<string, StopIndexRec>; verif: Map<string, Verification>; onSaved: (v: Verification) => void;
  newStops: NewStop[]; onNewStop: (s: NewStop) => void; routeChange?: RouteChange; onRouteChange: (c: RouteChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showChange, setShowChange] = useState(false);
  const staleN = route.stops.filter((r) => index[r]?.bucket === 'verystale').length;
  const verifiedN = route.stops.filter((r) => verif.has(r)).length;
  return (
    <div className="adm-card">
      <div className="adm-cardhead">
        <span className="adm-refbadge">{route.ref || '–'}</span>
        <span className="adm-name">{route.from} → {route.to}</span>
        <span className="adm-muted">{route.stops.length} stops · {staleN} very stale · {verifiedN} ✓{newStops.length ? ` · +${newStops.length} new` : ''}</span>
        {routeChange && <span className="adm-saved">⚑ changed</span>}
        <button className="adm-chip" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Walk this route'}</button>
      </div>
      {route.operator && <div className="adm-muted">{route.operator}</div>}

      <div className="adm-row" style={{ marginTop: 6 }}>
        <button className="adm-chip" onClick={() => setShowAdd((s) => !s)}>➕ Add new stop</button>
        <button className="adm-chip" onClick={() => setShowChange((s) => !s)}>⚑ This route changed</button>
      </div>
      {showAdd && (
        <NewStopForm route={route} defaultSeq={route.stops.length + newStops.length + 1} onDone={(s) => { onNewStop(s); setShowAdd(false); }} />
      )}
      {showChange && (
        <RouteChangeForm route={route} existing={routeChange} onDone={(c) => { onRouteChange(c); setShowChange(false); }} />
      )}

      {newStops.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="adm-muted">Your new stops on this route:</div>
          {[...newStops].sort((a, b) => a.sequence - b.sequence).map((s) => (
            <div key={s.stopId} className="adm-card verified" style={{ margin: '4px 0' }}>
              <div className="adm-cardhead">
                <span className="adm-muted">seq {s.sequence}</span>
                <span className="adm-name">➕ {s.name}{s.localName ? ` (${s.localName})` : ''}</span>
                <span className="adm-refbadge">{s.boardAlight}</span>
                <span className="adm-muted">{s.myLat != null ? `${s.myLat}, ${s.myLng}` : 'no GPS'}</span>
              </div>
              {s.mateShout && <div className="adm-muted">🗣 {s.mateShout}</div>}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 8 }}>
          {route.stops.map((sref, i) => {
            const rec = index[sref];
            const stop: Stop = { ref: sref, name: rec?.name ?? null, lat: rec?.lat ?? null, lng: rec?.lng ?? null, edited: null, bucket: rec?.bucket ?? 'ghost', routes: [route.ref], hood: null };
            return <StopCard key={sref} stop={stop} seq={i + 1} verification={verif.get(sref)} onSaved={onSaved} />;
          })}
        </div>
      )}
    </div>
  );
}

function NewStopForm({ route, defaultSeq, onDone }: { route: Route; defaultSeq: number; onDone: (s: NewStop) => void }) {
  const [name, setName] = useState('');
  const [localName, setLocalName] = useState('');
  const [mateShout, setMateShout] = useState('');
  const [boardAlight, setBoardAlight] = useState<BoardAlight>('both');
  const [myLat, setMyLat] = useState<number | null>(null);
  const [myLng, setMyLng] = useState<number | null>(null);
  const [seq, setSeq] = useState<number>(defaultSeq);
  const [notes, setNotes] = useState('');
  const [gps, setGps] = useState<'idle' | 'getting' | 'error'>('idle');
  const [err, setErr] = useState('');

  const captureGps = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setGps('error'); return; }
    setGps('getting');
    navigator.geolocation.getCurrentPosition(
      (p) => { setMyLat(+p.coords.latitude.toFixed(6)); setMyLng(+p.coords.longitude.toFixed(6)); setGps('idle'); },
      () => setGps('error'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const save = async () => {
    if (!name.trim()) { setErr('Stop name is required'); return; }
    if (myLat == null || myLng == null) { setErr('GPS is required — tap "Use my GPS" or type lat/lng'); return; }
    const s: NewStop = {
      stopId: crypto.randomUUID(), name: name.trim(), localName: localName.trim(), mateShout: mateShout.trim(),
      boardAlight, myLat, myLng, routeRef: route.ref, sequence: Number(seq) || defaultSeq, notes: notes.trim(), verifiedAt: Date.now(),
    };
    await saveNewStop(s);
    onDone(s);
  };

  return (
    <div className="adm-form" style={{ borderTop: '1px dashed #999', marginTop: 6 }}>
      <div className="adm-muted">➕ New stop on route {route.ref} — purely your data (no OSM link)</div>
      <label>Stop name *</label>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="what you see on the ground" />
      <label>Local name</label>
      <input type="text" value={localName} onChange={(e) => setLocalName(e.target.value)} placeholder="what locals call it" />
      <label>🗣 Mate shout</label>
      <input type="text" value={mateShout} onChange={(e) => setMateShout(e.target.value)} />
      <label>Board / Alight / Both *</label>
      <div className="adm-row">
        {(['board', 'alight', 'both'] as BoardAlight[]).map((b) => (
          <label key={b} className="adm-chip"><input type="radio" name={`ba-${route.relRef}`} checked={boardAlight === b} onChange={() => setBoardAlight(b)} /> {b}</label>
        ))}
      </div>
      <label>Sequence in route *</label>
      <input type="number" value={seq} onChange={(e) => setSeq(Number(e.target.value))} />
      <label>📍 GPS * {myLat != null ? `→ ${myLat}, ${myLng}` : ''}</label>
      <div className="adm-row">
        <button className="adm-chip adm-gps" onClick={captureGps}>{gps === 'getting' ? 'getting…' : gps === 'error' ? 'GPS failed — type below' : 'Use my GPS'}</button>
        <input type="number" step="0.000001" placeholder="lat" value={myLat ?? ''} onChange={(e) => setMyLat(e.target.value === '' ? null : Number(e.target.value))} style={{ width: 110 }} />
        <input type="number" step="0.000001" placeholder="lng" value={myLng ?? ''} onChange={(e) => setMyLng(e.target.value === '' ? null : Number(e.target.value))} style={{ width: 110 }} />
      </div>
      <label>Notes</label>
      <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <p style={{ color: '#b00' }}>{err}</p>}
      <div className="adm-row" style={{ marginTop: 8 }}>
        <button className="adm-chip adm-save" onClick={save}>💾 Save new stop</button>
      </div>
    </div>
  );
}

function RouteChangeForm({ route, existing, onDone }: { route: Route; existing?: RouteChange; onDone: (c: RouteChange) => void }) {
  const [types, setTypes] = useState<string[]>(existing?.changeTypes ?? []);
  const [description, setDescription] = useState(existing?.description ?? '');
  const [newTerminal, setNewTerminal] = useState(existing?.newTerminal ?? '');
  const [oldTerminal, setOldTerminal] = useState(existing?.oldTerminal ?? '');
  const [stopsAdded, setStopsAdded] = useState<number | null>(existing?.stopsAdded ?? null);
  const [stopsRemoved, setStopsRemoved] = useState<number | null>(existing?.stopsRemoved ?? null);
  const [err, setErr] = useState('');

  const toggle = (k: string) => setTypes((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]));

  const save = async () => {
    if (types.length === 0 && !description.trim()) { setErr('Pick a change type or describe the change'); return; }
    const c: RouteChange = {
      id: existing?.id ?? crypto.randomUUID(), routeRef: route.ref, changeTypes: types, description: description.trim(),
      newTerminal: newTerminal.trim(), oldTerminal: oldTerminal.trim(), stopsAdded, stopsRemoved, verifiedAt: Date.now(),
    };
    await saveRouteChange(c);
    onDone(c);
  };

  return (
    <div className="adm-form" style={{ borderTop: '1px dashed #999', marginTop: 6 }}>
      <div className="adm-muted">⚑ Flag a change on route {route.ref} (queued for your review before it goes live)</div>
      {CHANGE_TYPES.map((ct) => (
        <label key={ct.k} style={{ display: 'block' }}><input type="checkbox" checked={types.includes(ct.k)} onChange={() => toggle(ct.k)} /> {ct.label}</label>
      ))}
      <label>Describe the change</label>
      <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. now goes to New Achimota, 3 new stops after Abofu" />
      <div className="adm-row">
        <span style={{ flex: 1 }}><label>New terminal</label><input type="text" value={newTerminal} onChange={(e) => setNewTerminal(e.target.value)} /></span>
        <span style={{ flex: 1 }}><label>Old terminal</label><input type="text" value={oldTerminal} onChange={(e) => setOldTerminal(e.target.value)} /></span>
      </div>
      <div className="adm-row">
        <span><label>Stops added</label><input type="number" value={stopsAdded ?? ''} onChange={(e) => setStopsAdded(e.target.value === '' ? null : Number(e.target.value))} style={{ width: 90 }} /></span>
        <span><label>Stops removed</label><input type="number" value={stopsRemoved ?? ''} onChange={(e) => setStopsRemoved(e.target.value === '' ? null : Number(e.target.value))} style={{ width: 90 }} /></span>
      </div>
      {err && <p style={{ color: '#b00' }}>{err}</p>}
      <div className="adm-row" style={{ marginTop: 8 }}>
        <button className="adm-chip adm-save" onClick={save}>💾 Save route change</button>
      </div>
    </div>
  );
}

function StopCard({ stop, seq, verification, onSaved }: { stop: Stop; seq?: number; verification?: Verification; onSaved: (v: Verification) => void }) {
  const [open, setOpen] = useState(false);
  const [exists, setExists] = useState(verification?.exists ?? true);
  const [mateShout, setMateShout] = useState(verification?.mateShout ?? '');
  const [localName, setLocalName] = useState(verification?.localName ?? '');
  const [notes, setNotes] = useState(verification?.notes ?? '');
  const [myLat, setMyLat] = useState<number | null>(verification?.myLat ?? null);
  const [myLng, setMyLng] = useState<number | null>(verification?.myLng ?? null);
  const [gps, setGps] = useState<'idle' | 'getting' | 'error'>('idle');
  const [saved, setSaved] = useState(false);
  const isVerified = saved || !!verification;

  const captureGps = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setGps('error'); return; }
    setGps('getting');
    navigator.geolocation.getCurrentPosition(
      (p) => { setMyLat(+p.coords.latitude.toFixed(6)); setMyLng(+p.coords.longitude.toFixed(6)); setGps('idle'); },
      () => setGps('error'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const save = async () => {
    const v: Verification = { osmRef: stop.ref, osmName: stop.name, exists, mateShout: mateShout.trim(), localName: localName.trim(), myLat, myLng, notes: notes.trim(), verifiedAt: Date.now() };
    await saveVerification(v);
    onSaved(v);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className={`adm-card ${isVerified ? 'verified' : ''}`}>
      <div className="adm-cardhead">
        {seq != null && <span className="adm-muted">{seq}.</span>}
        <span className={`adm-dot adm-${stop.bucket}`} title={stop.bucket} />
        <span className="adm-name">{stop.name || '(unnamed OSM stop)'}</span>
        {stop.routes.length > 0 && <span className="adm-refbadge">routes {stop.routes.join(', ')}</span>}
        {isVerified && <span className="adm-saved">✓ verified</span>}
        <button className="adm-chip" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Verify'}</button>
      </div>

      {open && (
        <div className="adm-form">
          {stop.lat != null && <div className="adm-muted">OSM coords: {stop.lat.toFixed(5)}, {stop.lng!.toFixed(5)}</div>}
          {stop.edited && <div className="adm-muted">last OSM edit: {stop.edited.slice(0, 10)}</div>}
          <div className="adm-muted">
            <a href={`https://www.openstreetmap.org/${stop.ref}`} target="_blank" rel="noopener noreferrer">{stop.ref} ↗</a>
          </div>

          <label><input type="checkbox" checked={exists} onChange={(e) => setExists(e.target.checked)} /> Stop still exists</label>
          <label>🗣 Mate shout here</label>
          <input type="text" value={mateShout} onChange={(e) => setMateShout(e.target.value)} placeholder="e.g. Lapaz Lapaz!" />
          <label>📝 Local name</label>
          <input type="text" value={localName} onChange={(e) => setLocalName(e.target.value)} placeholder="what locals call it" />
          <label>📝 Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />

          <label>📍 My GPS {myLat != null ? `→ ${myLat}, ${myLng}` : ''}</label>
          <div className="adm-row">
            <button className="adm-chip adm-gps" onClick={captureGps}>
              {gps === 'getting' ? 'getting…' : gps === 'error' ? 'GPS failed — retry' : 'Use my current GPS'}
            </button>
            {myLat != null && <button className="adm-chip" onClick={() => { setMyLat(null); setMyLng(null); }}>clear</button>}
          </div>

          <div className="adm-row" style={{ marginTop: 8 }}>
            <button className="adm-chip adm-save" onClick={save}>💾 Save verification</button>
            {saved && <span className="adm-saved">saved ✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}
