// TASK 2 — OSM "Treasure Map" viewer. Reads the RAW Overpass dumps (data/osm_raw/, from Task 1) and
// produces a FIELDWORK GUIDE — not a CorePack.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'osm_raw');
const OUT_HTML = join(ROOT, 'data', 'osm_treasure_map.html');
const OUT_JSON = join(ROOT, 'data', 'osm_treasure_map.json');

const ATTRIBUTION = '© OpenStreetMap contributors';
const LICENSE = 'ODbL-1.0';

// Freshness windows, measured from "now" at generation time. Red = nobody has touched this since
// (around) the original 2017 survey -> verify it FIRST.
const NOW = Date.now();
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const FRESH_MAX_YEARS = 2; // green
const AGING_MAX_YEARS = 5; // yellow; older -> red

function freshness(ts) {
  if (!ts) return 'unknown';
  const age = (NOW - Date.parse(ts)) / YEAR_MS;
  if (age <= FRESH_MAX_YEARS) return 'fresh';
  if (age <= AGING_MAX_YEARS) return 'aging';
  return 'stale';
}

// A route is a trotro if it's tagged trô trô, OR tagged informal (bus=unofficial), OR simply named
// "Trotro N" (mappers often omit the network tag).
function classify(tags) {
  const net = tags.network || '';
  const name = tags.name || '';
  if (net === 'trô trô' || net === 'wikidata:Q2454552') return 'trotro';
  if (tags.bus === 'unofficial') return 'trotro';
  if (/^tro\s*tro|^trotro/i.test(name)) return 'trotro';
  return 'other';
}

// Pull a line ref from the tag, else from the name ("Trotro 282 : ..."). Used for grouping
// directions of the same line and for numeric sorting.
function deriveRef(tags) {
  if (tags.ref) return String(tags.ref);
  const m = (tags.name || '').match(/trotro\s+([0-9a-z]+)/i);
  return m ? m[1] : '';
}

function contentHash(osmRef, tags, lat, lng) {
  const h = createHash('sha256');
  h.update(osmRef + '\n' + JSON.stringify(tags ?? {}) + '\n' + (lat ?? '') + ',' + (lng ?? ''));
  return h.digest('hex').slice(0, 16);
}

function readJson(name) {
  return JSON.parse(readFileSync(join(RAW, name), 'utf8'));
}

// Build the model
function build() {
  let manifest = {};
  try {
    manifest = readJson('_manifest.json');
  } catch {
    /* manifest optional */
  }
  const stopsRaw = readJson('stops.json');
  const routesRaw = readJson('routes.json');
  let mastersRaw = { elements: [] };
  try {
    mastersRaw = readJson('route_masters.json');
  } catch {
    /* optional */
  }

  const fetchedAt = manifest.generatedAt ?? null;
  const osmTimestampBase = routesRaw.osm3s?.timestamp_osm_base ?? manifest.files?.['routes.json']?.osmTimestampBase ?? null;

  // Lookups. Stop nodes (full tags + meta) come from stops.json; geometry-only node coords (incl.
  // stop members not in stops.json) come from routes.json.
  const stopById = new Map(stopsRaw.elements.map((s) => [s.id, s]));
  const coordById = new Map(routesRaw.elements.filter((e) => e.type === 'node').map((n) => [n.id, n]));
  const relations = routesRaw.elements.filter((e) => e.type === 'relation');

  // route_master metadata (fare/frequency) keyed by ref, folded into routes below.
  const masterByRef = new Map();
  for (const m of mastersRaw.elements) {
    const ref = deriveRef(m.tags || {});
    if (ref) masterByRef.set(ref, m.tags);
  }

  // featureMap: osm_ref -> osm_mirror.osm_features-shaped row (de-duplicated).
  const featureMap = new Map();
  function addStopFeature(node) {
    const ref = `node/${node.id}`;
    if (featureMap.has(ref)) return;
    featureMap.set(ref, {
      osm_ref: ref,
      kind: 'highway', // bus_stop platform; full detail in tags
      tags: node.tags ?? {},
      lat: node.lat,
      lng: node.lon,
      last_edited: node.timestamp ?? null,
      version: node.version ?? null,
      user: node.user ?? null,
      freshness: freshness(node.timestamp),
      content_hash: contentHash(ref, node.tags ?? {}, node.lat, node.lon),
      fetched_at: fetchedAt,
    });
  }

  // Resolve one stop member of a route into a render-ready stop record.
  function resolveStop(memberRef, seq, role) {
    const full = stopById.get(memberRef);
    const coord = coordById.get(memberRef);
    const lat = full?.lat ?? coord?.lat ?? null;
    const lng = full?.lon ?? coord?.lon ?? null;
    const tags = full?.tags ?? {};
    const osmRef = `node/${memberRef}`;
    if (full) addStopFeature(full);
    return {
      osm_ref: osmRef,
      osm_id: memberRef,
      seq,
      role,
      name: tags.name ?? null,
      lat,
      lng,
      last_edited: full?.timestamp ?? null,
      version: full?.version ?? null,
      user: full?.user ?? null,
      freshness: freshness(full?.timestamp),
      resolved: Boolean(full),
    };
  }

  const routes = [];
  for (const rel of relations) {
    const tags = rel.tags ?? {};
    const ref = deriveRef(tags);
    const master = masterByRef.get(ref);
    const osmRef = `relation/${rel.id}`;

    const stops = [];
    let seq = 0;
    for (const m of rel.members ?? []) {
      if (m.type !== 'node') continue; // ways are road geometry, not stops
      if (m.role && !['platform', 'stop', ''].includes(m.role)) continue;
      seq += 1;
      stops.push(resolveStop(m.ref, seq, m.role || 'platform'));
    }

    featureMap.set(osmRef, {
      osm_ref: osmRef,
      kind: 'route',
      tags,
      lat: null,
      lng: null,
      last_edited: rel.timestamp ?? null,
      version: rel.version ?? null,
      user: rel.user ?? null,
      freshness: freshness(rel.timestamp),
      content_hash: contentHash(osmRef, tags, null, null),
      fetched_at: fetchedAt,
    });

    routes.push({
      osm_ref: osmRef,
      osm_id: rel.id,
      ref,
      name: tags.name ?? '(unnamed route)',
      from: (tags.from ?? '').trim(),
      to: (tags.to ?? '').trim(),
      operator: tags.operator ?? null,
      network: tags.network ?? null,
      classification: classify(tags),
      // ODbL + 2017-stale hints — shown as "verify", never copied to core.
      charge_hint: master?.charge ?? tags.charge ?? null,
      frequency_hint: master?.frequency ?? tags.frequency ?? null,
      mate_shout_placeholder: '', // YOU fill this in the field
      last_edited: rel.timestamp ?? null,
      user: rel.user ?? null,
      freshness: freshness(rel.timestamp),
      stopCount: stops.length,
      stops,
    });
  }

  // Sort: trotro first, then numeric ref, then name.
  routes.sort((a, b) => {
    if (a.classification !== b.classification) return a.classification === 'trotro' ? -1 : 1;
    const na = parseInt(a.ref, 10);
    const nb = parseInt(b.ref, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Neighborhoods = route endpoints (the terminal/area names). Count distinct trotro routes
  // touching each -> "which areas have the most / least routes".
  const hoodMap = new Map();
  function touch(name, role, route) {
    const key = name.trim();
    if (!key) return;
    if (!hoodMap.has(key)) hoodMap.set(key, { name: key, asOrigin: 0, asDestination: 0, routes: new Set() });
    const h = hoodMap.get(key);
    if (role === 'origin') h.asOrigin += 1;
    else h.asDestination += 1;
    h.routes.add(route.osm_ref);
  }
  for (const r of routes) {
    if (r.classification !== 'trotro') continue;
    touch(r.from, 'origin', r);
    touch(r.to, 'destination', r);
  }
  const neighborhoods = [...hoodMap.values()]
    .map((h) => ({ name: h.name, routeCount: h.routes.size, asOrigin: h.asOrigin, asDestination: h.asDestination }))
    .sort((a, b) => b.routeCount - a.routeCount || a.name.localeCompare(b.name));

  // Summary / freshness breakdowns.
  const trotro = routes.filter((r) => r.classification === 'trotro');
  const stopFresh = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const f of featureMap.values()) if (f.kind === 'highway') stopFresh[f.freshness] += 1;
  const routeFresh = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const r of routes) routeFresh[r.freshness] += 1;

  const summary = {
    generatedAt: new Date().toISOString(),
    osmTimestampBase,
    fetchedAt,
    totals: {
      routes: routes.length,
      trotroRoutes: trotro.length,
      otherRoutes: routes.length - trotro.length,
      distinctStopsOnRoutes: [...featureMap.values()].filter((f) => f.kind === 'highway').length,
      stopsInExtract: stopsRaw.elements.length,
      neighborhoods: neighborhoods.length,
    },
    stopFreshness: stopFresh,
    routeFreshness: routeFresh,
    freshnessWindows: { freshMaxYears: FRESH_MAX_YEARS, agingMaxYears: AGING_MAX_YEARS, asOf: new Date(NOW).toISOString() },
  };

  return {
    summary,
    license: LICENSE,
    attribution: ATTRIBUTION,
    source: 'https://www.openstreetmap.org/copyright',
    note: 'ODbL scaffold (treasure map). Do NOT copy into core.* / CorePack. Field-verify, then create fresh core rows (Task 4).',
    routes,
    neighborhoods,
    features: [...featureMap.values()], // osm_mirror.osm_features-shaped rows
  };
}

// HTML rendering (self-contained: data + CSS + JS inlined, works fully offline)
function renderHtml(data) {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/'); // safe inside <script>
  const s = data.summary;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trotro Treasure Map — Accra fieldwork guide</title>
<style>
  :root { --green:#1a8a3a; --yellow:#b8860b; --red:#c0392b; --grey:#888; --line:#ddd; --bg:#fff; --fg:#111; --accent:#0b6; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  header { padding:14px 16px; border-bottom:2px solid var(--fg); }
  h1 { font-size:20px; margin:0 0 4px; }
  .muted { color:var(--grey); font-size:13px; }
  .legend span { display:inline-block; margin-right:12px; font-size:13px; white-space:nowrap; }
  .dot { display:inline-block; width:12px; height:12px; border-radius:50%; vertical-align:-1px; margin-right:4px; }
  .dot.fresh{background:var(--green)} .dot.aging{background:var(--yellow)} .dot.stale{background:var(--red)} .dot.unknown{background:var(--grey)}
  .stats { display:flex; flex-wrap:wrap; gap:8px 18px; margin-top:8px; font-size:14px; }
  .stats b { font-size:18px; }
  .controls { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line); padding:10px 16px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .controls input, .controls select { font-size:16px; padding:9px 10px; border:1px solid #bbb; border-radius:8px; min-height:42px; }
  .controls input[type=search]{ flex:1 1 200px; }
  .chip { border:1px solid #bbb; border-radius:20px; padding:8px 12px; min-height:42px; background:#f6f6f6; cursor:pointer; font-size:14px; }
  .chip.active { background:var(--fg); color:#fff; border-color:var(--fg); }
  button { font-size:15px; padding:10px 14px; min-height:44px; border:1px solid #bbb; border-radius:8px; background:#f6f6f6; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  main { padding:8px 12px 60px; }
  details.route { border:1px solid var(--line); border-radius:10px; margin:10px 0; overflow:hidden; }
  details.route > summary { list-style:none; cursor:pointer; padding:12px 14px; display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; }
  details.route > summary::-webkit-details-marker { display:none; }
  .ref { font-weight:700; background:var(--fg); color:#fff; border-radius:6px; padding:2px 8px; font-size:14px; }
  .ref.other { background:var(--grey); }
  .rname { font-weight:600; }
  .ends { color:#444; }
  .op { color:var(--grey); font-size:13px; flex-basis:100%; }
  .badge { font-size:12px; border:1px solid #ccc; border-radius:10px; padding:1px 7px; color:#444; }
  .rbody { padding:0 14px 14px; }
  .shout { margin:8px 0; padding:8px; background:#fffceb; border:1px dashed #d9c98a; border-radius:8px; }
  .shout label { font-weight:600; display:block; margin-bottom:4px; font-size:14px; }
  .shout input { width:100%; font-size:16px; padding:8px; border:1px solid #ccc; border-radius:6px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:6px 6px; border-bottom:1px solid #eee; vertical-align:top; }
  th { font-size:12px; color:var(--grey); text-transform:uppercase; letter-spacing:.03em; }
  .coords a { color:#06c; text-decoration:none; }
  .nid { color:var(--grey); font-size:12px; font-variant-numeric:tabular-nums; }
  .chk { display:flex; flex-wrap:wrap; gap:6px 10px; }
  .chk label { display:inline-flex; align-items:center; gap:4px; font-size:13px; white-space:nowrap; }
  .chk input { width:20px; height:20px; }
  .note input { width:100%; font-size:14px; padding:6px; border:1px solid #ddd; border-radius:6px; }
  .hoods { width:100%; border-collapse:collapse; font-size:14px; }
  .hoods td, .hoods th { padding:5px 8px; border-bottom:1px solid #eee; }
  .bar { display:inline-block; height:10px; background:var(--accent); border-radius:3px; vertical-align:middle; }
  footer { padding:16px; color:var(--grey); font-size:12px; border-top:1px solid var(--line); }
  .hidden { display:none !important; }
  @media (max-width:520px){ .hide-sm{ display:none; } th,td{ padding:5px 4px; } }
  @media print {
    .controls, .no-print, button { display:none !important; }
    details.route { break-inside:avoid; border-color:#999; }
    details.route[open] > summary { background:#eee; }
    .chk input { -webkit-appearance:none; appearance:none; width:13px; height:13px; border:1.5px solid #000; border-radius:2px; }
    a { color:#000; text-decoration:none; }
  }
</style>
</head>
<body>
<header>
  <h1>🚐 Trotro Treasure Map — Accra fieldwork guide</h1>
  <div class="muted">${ATTRIBUTION} · ${LICENSE} · OSM data ${esc(s.osmTimestampBase || '?')} · generated ${esc(s.generatedAt.slice(0, 16).replace('T', ' '))}</div>
  <div class="stats">
    <span><b>${s.totals.trotroRoutes}</b> trotro routes</span>
    <span><b>${s.totals.distinctStopsOnRoutes}</b> stops on routes</span>
    <span><b>${s.totals.neighborhoods}</b> areas</span>
    <span class="hide-sm"><b>${s.totals.stopsInExtract}</b> stops in extract</span>
    <span class="hide-sm"><b>${s.totals.otherRoutes}</b> non-trotro</span>
  </div>
  <div class="legend" style="margin-top:8px">
    <span><span class="dot fresh"></span>fresh (≤${s.freshnessWindows.freshMaxYears}y)</span>
    <span><span class="dot aging"></span>aging (≤${s.freshnessWindows.agingMaxYears}y)</span>
    <span><span class="dot stale"></span>stale — verify first</span>
    <span><span class="dot unknown"></span>unknown</span>
  </div>
</header>

<div class="controls no-print">
  <input id="q" type="search" placeholder="Search route, terminal, operator, stop…">
  <select id="hood"><option value="">All areas</option></select>
  <select id="sort">
    <option value="ref">Sort: route ref</option>
    <option value="fresh">Sort: stalest first</option>
    <option value="stops">Sort: most stops</option>
    <option value="name">Sort: name A–Z</option>
    <option value="from">Sort: origin A–Z</option>
  </select>
  <span class="chip active" data-fresh="all">All</span>
  <span class="chip" data-fresh="fresh"><span class="dot fresh"></span>fresh</span>
  <span class="chip" data-fresh="aging"><span class="dot aging"></span>aging</span>
  <span class="chip" data-fresh="stale"><span class="dot stale"></span>stale</span>
  <label class="chip"><input type="checkbox" id="trotroOnly" checked style="vertical-align:-2px"> trotro only</label>
  <button class="primary" id="export">⬇ Export my fieldwork</button>
  <button id="expand">Expand all</button>
  <button id="print" onclick="window.print()">🖨 Print</button>
</div>

<main>
  <details class="no-print" id="hoodsBox">
    <summary style="cursor:pointer;font-weight:600;padding:8px 4px">📍 Neighborhood summary — routes per area (tap to open)</summary>
    <table class="hoods" id="hoodsTable"></table>
  </details>
  <div id="count" class="muted" style="margin:8px 4px"></div>
  <div id="routes"></div>
</main>

<footer>
  ODbL scaffold — fieldwork guide only. Nothing here is copied into the proprietary core dataset; verify in the field,
  then create fresh core records (Task 4). Your checkboxes &amp; notes are saved on THIS device (localStorage) and never uploaded.
</footer>

<script id="data" type="application/json">${json}</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
const ROUTES = DATA.routes, HOODS = DATA.neighborhoods;
const KEY = 'tg-fw:'; // localStorage namespace for fieldwork capture
const $ = (id) => document.getElementById(id);
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function lsGet(k){ try { return JSON.parse(localStorage.getItem(KEY+k)); } catch { return null; } }
function lsSet(k,v){ try { localStorage.setItem(KEY+k, JSON.stringify(v)); } catch {} }

const state = { q:'', hood:'', sort:'ref', fresh:'all', trotroOnly:true };

// --- neighborhood table ---
(function hoods(){
  const max = HOODS.length ? HOODS[0].routeCount : 1;
  const sel = $('hood');
  let html = '<tr><th>Area (terminal)</th><th>Routes</th><th class="hide-sm">as origin / dest</th></tr>';
  for (const h of HOODS){
    const w = Math.max(4, Math.round(120 * h.routeCount / max));
    html += '<tr><td>'+esc(h.name)+'</td><td><span class="bar" style="width:'+w+'px"></span> '+h.routeCount+'</td><td class="hide-sm">'+h.asOrigin+' / '+h.asDestination+'</td></tr>';
    sel.insertAdjacentHTML('beforeend', '<option value="'+esc(h.name)+'">'+esc(h.name)+' ('+h.routeCount+')</option>');
  }
  $('hoodsTable').innerHTML = html;
})();

function routeMatches(r){
  if (state.trotroOnly && r.classification !== 'trotro') return false;
  if (state.hood && r.from !== state.hood && r.to !== state.hood) return false;
  if (state.fresh !== 'all' && r.freshness !== state.fresh){
    // a route also "matches" a freshness filter if any of its stops match
    if (!r.stops.some(st => st.freshness === state.fresh)) return false;
  }
  if (state.q){
    const q = state.q.toLowerCase();
    const hay = [r.ref, r.name, r.from, r.to, r.operator].join(' ').toLowerCase();
    if (!hay.includes(q) && !r.stops.some(st => (st.name||'').toLowerCase().includes(q))) return false;
  }
  return true;
}

function sortRoutes(list){
  const by = state.sort;
  const rank = {fresh:0, aging:1, stale:2, unknown:3};
  return list.sort((a,b)=>{
    if (by==='ref'){ const na=parseInt(a.ref,10), nb=parseInt(b.ref,10);
      if(!isNaN(na)&&!isNaN(nb)&&na!==nb) return na-nb; return (a.name||'').localeCompare(b.name||''); }
    if (by==='fresh') return (rank[b.freshness]-rank[a.freshness]) || (a.name||'').localeCompare(b.name||'');
    if (by==='stops') return b.stopCount-a.stopCount;
    if (by==='name') return (a.name||'').localeCompare(b.name||'');
    if (by==='from') return (a.from||'').localeCompare(b.from||'');
    return 0;
  });
}

function stopRow(r, st){
  const id = st.osm_ref;
  const saved = lsGet(r.osm_ref+'|'+id) || {};
  const maps = st.lat!=null ? '<a href="https://www.google.com/maps?q='+st.lat+','+st.lng+'" target="_blank" rel="noopener">'+st.lat.toFixed(5)+', '+st.lng.toFixed(5)+'</a>' : '—';
  const ck = (k,label)=> '<label><input type="checkbox" data-k="'+esc(r.osm_ref+'|'+id)+'" data-f="'+k+'"'+(saved[k]?' checked':'')+'> '+label+'</label>';
  return '<tr>'
    + '<td>'+st.seq+'</td>'
    + '<td>'+esc(st.name || '(unnamed stop)')+'</td>'
    + '<td class="coords hide-sm">'+maps+'</td>'
    + '<td class="nid hide-sm">'+esc(id)+'</td>'
    + '<td class="hide-sm">'+(st.last_edited? esc(st.last_edited.slice(0,10)) : '—')+'</td>'
    + '<td><span class="dot '+st.freshness+'" title="'+st.freshness+'"></span></td>'
    + '<td><div class="chk">'+ck('visited','Visited')+ck('exists','Exists')+ck('shout','Shout')+ck('localname','Local name')+'</div>'
       + '<div class="note"><input type="text" placeholder="note / heard shout / local name…" data-note="'+esc(r.osm_ref+'|'+id)+'" value="'+esc(saved.note||'')+'"></div></td>'
    + '</tr>';
}

function buildRouteBody(r){
  const shoutSaved = lsGet('shout|'+r.osm_ref) || '';
  let hints = [];
  if (r.charge_hint) hints.push('fare hint (2017, verify): '+esc(r.charge_hint));
  if (r.frequency_hint) hints.push('every ~'+esc(r.frequency_hint)+' min (verify)');
  let html = '<div class="rbody">';
  html += '<div class="shout"><label>🗣 Mate shout for this route (fill in the field):</label>'
        + '<input type="text" data-shout="'+esc(r.osm_ref)+'" value="'+esc(shoutSaved)+'" placeholder="e.g. \\'Lapaz Lapaz! 37!\\'"></div>';
  if (hints.length) html += '<div class="muted" style="margin:4px 0">'+hints.join(' · ')+'</div>';
  html += '<table><thead><tr><th>#</th><th>Stop</th><th class="hide-sm">Coords</th><th class="hide-sm">OSM id</th><th class="hide-sm">Edited</th><th>Fresh</th><th>Verify</th></tr></thead><tbody>';
  for (const st of r.stops) html += stopRow(r, st);
  html += '</tbody></table></div>';
  return html;
}

function routeCard(r){
  const cls = r.classification === 'trotro' ? '' : ' other';
  const ends = (r.from||'?') + ' → ' + (r.to||'?');
  const d = document.createElement('details');
  d.className = 'route';
  d.dataset.ref = r.osm_ref;
  d.innerHTML = '<summary>'
    + '<span class="ref'+cls+'">'+esc(r.ref || '–')+'</span>'
    + '<span class="rname">'+esc(stripPrefix(r.name))+'</span>'
    + '<span class="dot '+r.freshness+'" title="route edited '+(r.last_edited?esc(r.last_edited.slice(0,10)):'?')+'"></span>'
    + '<span class="badge">'+r.stopCount+' stops</span>'
    + (r.classification!=='trotro'?'<span class="badge">'+esc(r.network||'other')+'</span>':'')
    + '<span class="ends" style="flex-basis:100%">'+esc(ends)+'</span>'
    + (r.operator?'<span class="op">'+esc(r.operator)+'</span>':'')
    + '</summary>';
  // Lazy: build the (heavy) stop table only on first open — keeps 567 cards snappy on low-end phones.
  d.addEventListener('toggle', () => {
    if (d.open && !d.dataset.built){ d.insertAdjacentHTML('beforeend', buildRouteBody(r)); d.dataset.built='1'; }
  }, { once:false });
  return d;
}
function stripPrefix(n){ return String(n||'').replace(/^tro?\s*tro\s*\d*\s*:?\s*/i,'').replace(/^trotro\s*\d*\s*:?\s*/i,'') || n; }

function render(){
  const list = sortRoutes(ROUTES.filter(routeMatches));
  const host = $('routes');
  host.textContent = '';
  const frag = document.createDocumentFragment();
  for (const r of list) frag.appendChild(routeCard(r));
  host.appendChild(frag);
  $('count').textContent = list.length + ' route(s) shown' + (state.q||state.hood||state.fresh!=='all'?' (filtered)':'');
}

// --- persistence (event delegation; survives reload during fieldwork) ---
document.addEventListener('change', (e)=>{
  const t = e.target;
  if (t.dataset.k){ const k=t.dataset.k, cur=lsGet(k)||{}; cur[t.dataset.f]=t.checked; lsSet(k,cur); }
  else if (t.dataset.note){ const k=t.dataset.note, cur=lsGet(k)||{}; cur.note=t.value; lsSet(k,cur); }
  else if (t.dataset.shout){ lsSet('shout|'+t.dataset.shout, t.value); }
});
document.addEventListener('input', (e)=>{ // text fields fire input as you type
  const t=e.target;
  if (t.dataset.note){ const k=t.dataset.note, cur=lsGet(k)||{}; cur.note=t.value; lsSet(k,cur); }
  else if (t.dataset.shout){ lsSet('shout|'+t.dataset.shout, t.value); }
});

// --- controls ---
$('q').addEventListener('input', e=>{ state.q=e.target.value.trim(); render(); });
$('hood').addEventListener('change', e=>{ state.hood=e.target.value; render(); });
$('sort').addEventListener('change', e=>{ state.sort=e.target.value; render(); });
$('trotroOnly').addEventListener('change', e=>{ state.trotroOnly=e.target.checked; render(); });
document.querySelectorAll('.chip[data-fresh]').forEach(c=> c.addEventListener('click', ()=>{
  document.querySelectorAll('.chip[data-fresh]').forEach(x=>x.classList.remove('active'));
  c.classList.add('active'); state.fresh=c.dataset.fresh; render();
}));
$('expand').addEventListener('click', ()=>{
  const open = $('expand').dataset.open!=='1';
  document.querySelectorAll('details.route').forEach(d=> d.open=open);
  $('expand').dataset.open=open?'1':'0'; $('expand').textContent= open?'Collapse all':'Expand all';
});
window.addEventListener('beforeprint', ()=> document.querySelectorAll('details.route').forEach(d=> d.open=true));

// --- export fieldwork (everything under the tg-fw: namespace) ---
$('export').addEventListener('click', ()=>{
  const out={ exportedAt:new Date().toISOString(), captures:{} };
  for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i);
    if (k.startsWith(KEY)){ try{ out.captures[k.slice(KEY.length)]=JSON.parse(localStorage.getItem(k)); }catch{ out.captures[k.slice(KEY.length)]=localStorage.getItem(k); } } }
  out.count=Object.keys(out.captures).length;
  const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='trotro-fieldwork-'+new Date().toISOString().slice(0,10)+'.json'; a.click();
});

render();
</script>
</body>
</html>`;
}

function esc(x) {
  return String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function main() {
  const data = build();
  writeFileSync(OUT_JSON, JSON.stringify(data, null, 2));
  writeFileSync(OUT_HTML, renderHtml(data));

  const t = data.summary.totals;
  console.log('Trotro Treasure Map built:');
  console.log(`  routes: ${t.routes} (trotro ${t.trotroRoutes}, other ${t.otherRoutes})`);
  console.log(`  stops on routes: ${t.distinctStopsOnRoutes}  (extract had ${t.stopsInExtract})`);
  console.log(`  areas (terminals): ${t.neighborhoods}`);
  console.log(`  stop freshness:  fresh ${data.summary.stopFreshness.fresh}, aging ${data.summary.stopFreshness.aging}, stale ${data.summary.stopFreshness.stale}, unknown ${data.summary.stopFreshness.unknown}`);
  console.log(`  top areas: ${data.neighborhoods.slice(0, 6).map((h) => `${h.name} (${h.routeCount})`).join(', ')}`);
  console.log(`\n  HTML: ${OUT_HTML}`);
  console.log(`  JSON: ${OUT_JSON}`);
  console.log('  Open the HTML on your phone for fieldwork (checklists persist locally; "Export my fieldwork" downloads them).');
}

main();
