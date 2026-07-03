'use client';
// Inline (non-modal) walking-directions map for STEP 1 of the boarding flow.
// Same MapLibre + Carto basemap as RouteMap, but small, embedded in the card,
// and only draws the user -> boarding-stop walking line (no route polyline).

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

interface WalkMapProps {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  toLabel: string;
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

function marker(cls: string, label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `tg-marker ${cls}`;
  el.setAttribute('aria-label', label);
  el.title = label;
  return el;
}

export function WalkMap({ from, to, toLabel }: WalkMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [from.lng, from.lat],
      zoom: 14,
      attributionControl: { compact: true },
      interactive: false,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('walk', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] } },
      });
      map.addLayer({
        id: 'walk-line',
        type: 'line',
        source: 'walk',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#0071e3', 'line-width': 3, 'line-dasharray': [1, 1.5] },
      });

      new maplibregl.Marker({ element: marker('tg-marker--you', 'You are here') })
        .setLngLat([from.lng, from.lat])
        .addTo(map);
      new maplibregl.Marker({ element: marker('tg-marker--board', toLabel) })
        .setLngLat([to.lng, to.lat])
        .addTo(map);

      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([from.lng, from.lat]);
      bounds.extend([to.lng, to.lat]);
      map.fitBounds(bounds, { padding: 40, maxZoom: 16, duration: 0 });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [from.lat, from.lng, to.lat, to.lng, toLabel]);

  return <div ref={containerRef} className="tg-walkmap" role="img" aria-label={`Walking route to ${toLabel}`} />;
}
