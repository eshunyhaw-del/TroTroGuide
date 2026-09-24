// Build a small DEMO Accra Core Pack WITHOUT the database, so the app works locally before Supabase
// is wired.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// polyline6 encode (same algorithm as lib/geo/polyline.ts)
function encodeSigned(num) {
  let sgn = num < 0 ? ~(num << 1) : num << 1;
  let out = '';
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}
function encode(coords, precision = 6) {
  const factor = 10 ** precision;
  const r = (v) => Math.round(v * factor);
  let prevLat = 0, prevLng = 0, out = '';
  for (const [lat, lng] of coords) {
    const a = r(lat), b = r(lng);
    out += encodeSigned(a - prevLat) + encodeSigned(b - prevLng);
    prevLat = a; prevLng = b;
  }
  return out;
}

const routeCoords = [
  [5.5703, -0.2074],
  [5.595, -0.19],
  [5.6209, -0.1719],
];

// Stop distances MUST match the polyline geometry, or on-board "arrived" detection never fires.
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const t = (d) => (d * Math.PI) / 180;
  const dLat = t(bLat - aLat);
  const dLng = t(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(t(aLat)) * Math.cos(t(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
let routeLen = 0;
for (let i = 1; i < routeCoords.length; i++) {
  routeLen += haversineM(routeCoords[i - 1][0], routeCoords[i - 1][1], routeCoords[i][0], routeCoords[i][1]);
}
const routeLenR = Math.round(routeLen);

// PLACEHOLDER ROUTE, Abeka Lapaz → Dome Kwabenya (NOT from OSM, NOT verified) Hand-authored,
// APPROXIMATE coordinates for exercising the map view only.
const DOME = [
  { id: 's-lapaz',       name: 'Lapaz',         aliases: ['La Paz', 'Lapaz', 'Abeka Lapaz'], lat: 5.6053, lng: -0.2540, landmark: 'Abeka Lapaz Terminal' },
  { id: 's-achimota',    name: 'Achimota Station', aliases: ['Achimota'],                    lat: 5.6190, lng: -0.2270, landmark: 'Achimota Retail Centre' },
  { id: 's-haatso',      name: 'Haatso',        aliases: ['Haatso Junction'],                lat: 5.6520, lng: -0.2080, landmark: null },
  { id: 's-atomic',      name: 'Atomic Junction', aliases: ['Atomic', 'Atomic Junction'],    lat: 5.6640, lng: -0.1980, landmark: 'Shell Atomic' },
  { id: 's-dome-market', name: 'Dome Market',   aliases: ['Dome'],                           lat: 5.6850, lng: -0.2110, landmark: 'Dome Market' },
  { id: 's-kwabenya',    name: 'Dome Kwabenya', aliases: ['Kwabenya', 'Dome Kwabenya'],      lat: 5.7060, lng: -0.2050, landmark: null },
];
const domeCoords = DOME.map((s) => [s.lat, s.lng]);
let domeCum = 0;
const domeRouteStops = DOME.map((s, i) => {
  if (i > 0) domeCum += haversineM(domeCoords[i - 1][0], domeCoords[i - 1][1], domeCoords[i][0], domeCoords[i][1]);
  return {
    stopId: s.id,
    seq: i + 1,
    distM: Math.round(domeCum),
    board: i === 0 ? 'Board at Abeka Lapaz terminal; the mate shouts "Dome! Dome!"' : null,
    alight: i === DOME.length - 1 ? 'Tell the mate: "Kwabenya, last stop!"' : null,
  };
});
const domePackStops = DOME.map((s) => ({
  id: s.id, name: s.name, aliases: s.aliases, lat: s.lat, lng: s.lng,
  routeIds: ['r-lapaz-dome'], landmark: s.landmark,
}));

const pack = {
  version: Date.now(),
  demo: true, // PLACEHOLDER pack, survives serialization so the UI can flag it.
  bbox: [-0.7, 5.4, 0.3, 6.1],
  stops: [
    { id: 's-circle', name: 'Kwame Nkrumah Circle', aliases: ['Circle', 'Nkrumah Circle'], lat: 5.5703, lng: -0.2074, routeIds: ['r-circle-mall'], landmark: null },
    { id: 's-mall', name: 'Accra Mall Stop', aliases: ['Accra Mall', 'Mall'], lat: 5.6209, lng: -0.1719, routeIds: ['r-circle-mall'], landmark: 'Accra Mall' },
    { id: 's-37', name: '37 Station', aliases: ['37', '37 Military Hospital'], lat: 5.5826, lng: -0.1816, routeIds: [], landmark: null },
    ...domePackStops, // includes s-lapaz (now the Abeka Lapaz → Dome terminal)
  ],
  routes: [
    {
      id: 'r-circle-mall',
      name: 'Circle - Accra Mall',
      mateShout: 'Mall! Mall! Accra Mall!',
      polyline: encode(routeCoords, 6),
      stops: [
        { stopId: 's-circle', seq: 1, distM: 0, board: 'Board at Circle; the mate shouts "Mall! Mall!"', alight: null },
        { stopId: 's-mall', seq: 2, distM: routeLenR, board: null, alight: 'Tell the mate: "Accra Mall, bus stop!"' },
      ],
    },
    {
      // PLACEHOLDER route (see DOME block above), approximate, not OSM, not verified.
      id: 'r-lapaz-dome',
      name: 'Abeka Lapaz → Dome Kwabenya',
      mateShout: 'Dome! Dome! Kwabenya!',
      polyline: encode(domeCoords, 6),
      stops: domeRouteStops,
    },
  ],
  landmarks: [
    { id: 'l-mall', name: 'Accra Mall', local: 'Accra Mall', type: 'mall', lat: 5.6212, lng: -0.1717 },
    // Placeholder landmarks along the Dome corridor (approximate, not OSM).
    { id: 'l-achimota-mall', name: 'Achimota Retail Centre', local: 'Achimota Mall', type: 'mall', lat: 5.6175, lng: -0.2255 },
    { id: 'l-atomic-shell', name: 'Shell Atomic', local: 'Atomic Shell', type: 'fuel', lat: 5.6648, lng: -0.1975 },
  ],
  neighborhoods: [
    { id: 'n-osu', name: 'Osu', localNames: ['Oxford Street'], lat: 5.556, lng: -0.182 },
    { id: 'n-dansoman', name: 'Dansoman', localNames: [], lat: 5.54, lng: -0.26 },
  ],
  synonyms: [
    { token: '37', canonical: '37 military hospital' },
    { token: 'circle', canonical: 'kwame nkrumah circle' },
    { token: 'atomic', canonical: 'atomic junction' },
    { token: 'lapaz', canonical: 'la paz' },
    { token: 'dome', canonical: 'dome kwabenya' },
    { token: 'kwabenya', canonical: 'dome kwabenya' },
    { token: 'achimota', canonical: 'achimota station' },
  ],
};

const body = JSON.stringify(pack);
const sha256 = createHash('sha256').update(body).digest('hex');
const dir = join(root, 'public', 'core-pack', `v${pack.version}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'accra-core.json'), body);
writeFileSync(
  join(root, 'public', 'core-pack', 'manifest.json'),
  JSON.stringify({ version: pack.version, url: `/core-pack/v${pack.version}/accra-core.json`, bytes: Buffer.byteLength(body), sha256 }),
);

console.log(`Fixture pack v${pack.version}: ${pack.stops.length} stops, ${pack.routes.length} route(s), ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB`);
