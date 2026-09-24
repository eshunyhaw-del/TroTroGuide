'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ChevronLeft, WifiOff } from 'lucide-react';
import { getRoute, getStop, getLandmarksNearRoute } from '@/lib/corepack/client';
import { decode } from '@/lib/geo/polyline';

interface RouteMapProps {
  routeId: string;
  boardStopId: string;
  alightStopId: string;
  user: { lat: number; lng: number } | null;
  onClose: () => void;
}

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },

  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#e8eaed' } },
    { id: 'carto', type: 'raster', source: 'carto' },
  ],
};

function marker(cls: string, label: string, glyph?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `tg-marker ${cls}`;
  el.setAttribute('aria-label', label);
  el.title = label;
  if (glyph) el.textContent = glyph;
  return el;
}

function popupHTML(name: string, opts: { sub?: string | null; label?: string } = {}): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  return (
    `<strong>${esc(name)}</strong>` +
    (opts.sub ? `<br/><span class="tg-pop-sub">${esc(opts.sub)}</span>` : '') +
    (opts.label ? `<br/><span class="tg-pop-label">${esc(opts.label)}</span>` : '')
  );
}

export function RouteMap({ routeId, boardStopId, alightStopId, user, onClose }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  
  const route = getRoute(routeId);

  
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    root?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const f = root.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      prev?.focus?.();
    };
  }, []);

  useEffect(() => {
    const route = getRoute(routeId);
    if (!containerRef.current || !route) return;

    
    const seq = [...route.stops]
      .sort((a, b) => a.seq - b.seq)
      .map((rs) => {
        const s = getStop(rs.stopId);
        return s ? { id: s.id, name: s.name, lat: s.lat, lng: s.lng, landmark: s.landmark } : null;
      })
      .filter((s): s is NonNullable<typeof s> => s != null);

    if (seq.length === 0) return;

    const board = seq.find((s) => s.id === boardStopId) ?? seq[0];
    const line = decode(route.polyline, 6); // [lat,lng][]

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [board.lng, board.lat],
      zoom: 13,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    
    const bounds = new maplibregl.LngLatBounds();
    line.forEach(([lat, lng]) => bounds.extend([lng, lat]));
    seq.forEach((s) => bounds.extend([s.lng, s.lat]));
    if (user) bounds.extend([user.lng, user.lat]);

    map.on('load', () => {
      
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line.map(([lat, lng]) => [lng, lat]) } },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#00d166', 'line-width': 4, 'line-dasharray': [2, 1] },
      });

      
      if (user) {
        map.addSource('walk', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[user.lng, user.lat], [board.lng, board.lat]] } },
        });
        map.addLayer({
          id: 'walk-line',
          type: 'line',
          source: 'walk',
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': '#8e8e93', 'line-width': 2, 'line-dasharray': [1, 1.5] },
        });
      }

      map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 0 });
    });

    
    for (const { landmark: l } of getLandmarksNearRoute(routeId, { maxOffsetM: 150 })) {
      new maplibregl.Marker({ element: marker('tg-marker--landmark', `Landmark: ${l.name}`) })
        .setLngLat([l.lng, l.lat])
        .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(popupHTML(l.name, { sub: l.local, label: 'Landmark' })))
        .addTo(map);
    }

  
    for (const s of seq) {
      const isBoard = s.id === boardStopId;
      const isAlight = s.id === alightStopId;
      const role = isBoard ? 'tg-marker--board' : isAlight ? 'tg-marker--alight' : 'tg-marker--stop';
      const label = isBoard ? 'Board here' : isAlight ? 'Get down here' : undefined;
      const glyph = isBoard ? '↑' : isAlight ? '↓' : undefined;
      new maplibregl.Marker({ element: marker(role, label ? `${s.name}: ${label}` : `Stop: ${s.name}`, glyph) })
        .setLngLat([s.lng, s.lat])
        .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(popupHTML(s.name, { sub: s.landmark, label })))
        .addTo(map);
    }

    
    if (user) {
      new maplibregl.Marker({ element: marker('tg-marker--you', 'You are here') })
        .setLngLat([user.lng, user.lat])
        .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(popupHTML('You are here')))
        .addTo(map);
    }

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [routeId, boardStopId, alightStopId, user]);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="tg-mapmodal"
      role="dialog"
      aria-modal="true"
      aria-label={`Map of ${route?.name ?? 'route'}`}
    >
      <div ref={containerRef} className="tg-mapmodal-canvas" />
      <div className="tg-mapmodal-bar glass glass--blur">
        <button className="tg-back" onClick={onClose}>
          <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
          back
        </button>
        <span className="tg-mapmodal-title">{route?.name ?? 'Route'}</span>
      </div>
      {!route && (
        <div className="tg-mapmodal-note glass">
          <WifiOff size={18} strokeWidth={1.75} aria-hidden="true" />
          Route data unavailable.
        </div>
      )}
      <div className="tg-mapmodal-hint glass">Tap a stop for details</div>
    </div>
  );
}
