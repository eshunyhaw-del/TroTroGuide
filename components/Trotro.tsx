'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { PhotoStrip } from './PhotoStrip';
import {
  Search,
  MapPin,
  Navigation,
  ChevronRight,
  ChevronLeft,
  X,
  Bus,
  Megaphone,
  Construction,
  Map as MapIcon,
  Signal,
  Flag,
  BookMarked,
  Sparkles,
} from 'lucide-react';
import {
  search,
  boardingPointOffline,
  boardingFromTerminalOffline,
  planTripOffline,
  getRoute,
  getStop,
  getStopName,
  getLandmarksNearRoute,
  isDemoPack,
  getAttribution,
  getPackStats,
  nearestStopOffline,
  nearestNeighborhoodOffline,
  MAX_WALK_MIN,
  MAX_WALK_M,
  type SearchHit,
  type BoardingOption,
} from '@/lib/corepack/client';
import { haversineM } from '@/lib/geo/haversine';
import { walkingMinutes } from '@/lib/geo/nearest-stop';
import { useRideProgress, type LiveRide } from '@/lib/onboard/useRideProgress';
import { useLookout } from '@/lib/streetview/useLookout';
import { openWalkingDirections } from '@/lib/maps/open-external';
import { SupportCard, SupportLink } from '@/components/Support';
import { DonatePopup } from '@/components/DonatePopup';
import { LookOutFor } from '@/components/LookOutFor';


const RouteMap = dynamic(() => import('./RouteMap').then((m) => m.RouteMap), {
  ssr: false,
  loading: () => <div className="tg-loading">Loading map…</div>,
});
const WalkMap = dynamic(() => import('./WalkMap').then((m) => m.WalkMap), {
  ssr: false,
  loading: () => <div className="tg-walkmap tg-walkmap--loading">Loading map…</div>,
});

type Stage = 'search' | 'result';


const DEFAULT_POS = { lat: 5.5703, lng: -0.2074 };


const POPULAR_HUBS = [
  'Circle',
  'Lapaz',
  '37 Station',
  'Kaneshie',
  'Achimota',
  'Madina',
  'Accra Central',
  'Tema Station',
  'Adenta',
  'Dansoman',
  'Osu',
  'Legon',
  'Spintex',
  'Nungua',
];


const POPULAR_COUNT = 6;


const MAX_LANDMARKS_PER_STOP = 3;

const formatDist = (m: number): string =>
  m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;

/** One line of plain English for the live-tracking banner above the ride list. */
function liveStatusText(live: LiveRide): string {
  const { phase, stopId, metresToNext, stopsRemaining } = live.progress;
  const here = getStopName(stopId) || 'your stop';

  if (live.stale) return `Live tracking paused — last seen at ${here}.`;
  if (phase === 'approaching') {
    return `Not on board yet — ${formatDist(metresToNext ?? 0)} to ${here}.`;
  }
  if (phase === 'arrived') return `You've reached ${here} — get down here.`;
  return `At ${here} · ${stopsRemaining} stop${stopsRemaining === 1 ? '' : 's'} to go`;
}


interface HeroSlide {
  img: string;
  alt: string;
  kicker?: string;
  title: string;
  sub?: string;
}
const HERO_SLIDES: HeroSlide[] = [
  {
    img: '/img/trotro-one.jpg',
    alt: 'A trotro pulling up at the roadside on an Accra street',
    kicker: 'How TroTro works · Step 1',
    title: 'Walk to the nearest main roadside — just stand visibly at the edge of any main road.',
  },
  {
    img: '/img/trotro-mate-in-trotro.jpg',
    alt: 'A trotro mate leaning out and shouting the destination',
    kicker: 'How TroTro works · Step 2',
    title: 'Listen for the mate’s shout — it tells you the trotro’s destination.',
  },
  {
    img: '/img/mate-in-yellow-trotro.jpg',
    alt: 'A trotro mate collecting fares inside a yellow trotro',
    kicker: 'How TroTro works · Step 3',
    title: 'Tell the mate where you’re getting down, and pay when you board or alight.',
  },
];


interface Trip {
  legs: BoardingOption[];
  transfers: number;
}

function computeTrips(
  dest: SearchHit,
  pos: { lat: number; lng: number },
  hasRealFix: boolean,
): { trips: Trip[]; fromPreview: boolean } {
  let direct = boardingPointOffline(pos.lat, pos.lng, dest.id, dest.type);


  if (hasRealFix) {
    if (direct.options.length > 0) {
      return { trips: direct.options.map((o) => ({ legs: [o], transfers: 0 })), fromPreview: false };
    }
    const multi = planTripOffline(pos.lat, pos.lng, dest.id, dest.type, { maxLegs: 2 });
    if (multi.options.length > 0) {
      return { trips: multi.options.map((t) => ({ legs: t.legs, transfers: t.transfers })), fromPreview: false };
    }
    direct = boardingPointOffline(pos.lat, pos.lng, dest.id, dest.type, Number.POSITIVE_INFINITY);
    return { trips: direct.options.map((o) => ({ legs: [o], transfers: 0 })), fromPreview: false };
  }

  
  const atDefault = pos.lat === DEFAULT_POS.lat && pos.lng === DEFAULT_POS.lng;
  if (direct.options.length === 0 && !atDefault) {
    const fallback = boardingPointOffline(DEFAULT_POS.lat, DEFAULT_POS.lng, dest.id, dest.type);
    if (fallback.options.length > 0) {
      direct = {
        ...fallback,
        options: fallback.options.map((o) => {
          const b = getStop(o.board_stop_id);
          return b ? { ...o, walk_m: Math.round(haversineM(pos.lat, pos.lng, b.lat, b.lng)) } : o;
        }),
      };
    }
  }
  if (direct.options.length === 0) {
    const term = boardingFromTerminalOffline(pos.lat, pos.lng, dest.id, dest.type);
    if (term.options.length > 0) direct = term;
  }

  const trips: Trip[] = direct.options.map((o) => ({ legs: [o], transfers: 0 }));
  return { trips, fromPreview: trips.length > 0 };
}


const RIDE_KEY = 'trotro:activeRide';

const RIDE_TTL_MS = 12 * 60 * 60 * 1000;

interface SavedRide {
  dest: SearchHit;
  origin: { lat: number; lng: number };
  activeIndex: number;
  ts: number;
}

function loadSavedRide(): SavedRide | null {
  try {
    const raw = localStorage.getItem(RIDE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as SavedRide;
    if (!r?.dest?.id || !r?.origin || typeof r.ts !== 'number') return null;
    if (Date.now() - r.ts > RIDE_TTL_MS) {
      localStorage.removeItem(RIDE_KEY);
      return null;
    }
    return r;
  } catch {
    return null;
  }
}
function saveRide(r: SavedRide): void {
  try {
    localStorage.setItem(RIDE_KEY, JSON.stringify(r));
  } catch {
    
  }
}
function clearSavedRide(): void {
  try {
    localStorage.removeItem(RIDE_KEY);
  } catch {
    
  }
}


function Typewriter({ text, speed = 60 }: { text: string; speed?: number }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setCount(text.length);
      return;
    }
    setCount(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return (
    <span aria-hidden="true">
      {text.slice(0, count)}
      <span className="tg-caret" />
    </span>
  );
}

export function Trotro() {
  const [stage, setStage] = useState<Stage>('search');
  
  const [navDir, setNavDir] = useState<'fwd' | 'back'>('fwd');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pos, setPos] = useState(DEFAULT_POS);
  const [geoAccuracy, setGeoAccuracy] = useState<number | null>(null);
  
  const [geoStatus, setGeoStatus] = useState<'locating' | 'ok' | 'denied' | 'unavailable'>('locating');
  
  const [heroIndex, setHeroIndex] = useState(0);
  const heroTouch = useRef<{ x: number; y: number } | null>(null);

  
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoStatus('unavailable');
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
        setGeoAccuracy(p.coords.accuracy);
        setGeoStatus('ok');
      },
      (err) => {
        setGeoStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  
  useEffect(() => {
    if (stage !== 'search') return;
    const id = setInterval(() => {
      setHeroIndex((i) => (i + 1) % HERO_SLIDES.length);
    }, 4500);
    return () => clearInterval(id);
  }, [stage, heroIndex]);

  
  const nearestStopRaw = geoStatus === 'ok' ? nearestStopOffline(pos.lat, pos.lng) : null;
  const nearestStop =
    nearestStopRaw && walkingMinutes(nearestStopRaw.distanceM) <= MAX_WALK_MIN ? nearestStopRaw : null;
  const [dest, setDest] = useState<SearchHit | null>(null);
 
  const [tripOrigin, setTripOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
 
  const [mapOpen, setMapOpen] = useState<{ leg: BoardingOption; withUser: boolean } | null>(null);
  
  const [popularHubs, setPopularHubs] = useState<SearchHit[]>([]);

  
  const hasRealFix = geoStatus === 'ok';

  
  const originPos = tripOrigin ?? pos;
  const originHasRealFix = tripOrigin ? true : hasRealFix;
  
  const originKeyLat = tripOrigin ? tripOrigin.lat : Math.round(pos.lat / 0.0005) * 0.0005;
  const originKeyLng = tripOrigin ? tripOrigin.lng : Math.round(pos.lng / 0.0005) * 0.0005;
  const { trips, fromPreview } = useMemo(
    () => (dest ? computeTrips(dest, originPos, originHasRealFix) : { trips: [] as Trip[], fromPreview: false }),
   
    [dest, originKeyLat, originKeyLng, originHasRealFix],
  );

  
  useEffect(() => {
    setActiveIndex(0);
  }, [dest]);

  
  useEffect(() => {
    if (stage === 'result' && dest && hasRealFix && !tripOrigin) {
      setTripOrigin({ lat: pos.lat, lng: pos.lng });
    }
  }, [stage, dest, hasRealFix, tripOrigin, pos.lat, pos.lng]);

  
  useEffect(() => {
    const saved = loadSavedRide();
    if (!saved) return;
    setDest(saved.dest);
    setTripOrigin(saved.origin);
    setActiveIndex(saved.activeIndex ?? 0);
    setNavDir('fwd');
    setStage('result');
 
    if ((window.history.state as { __tg?: string } | null)?.__tg !== 'result') {
      window.history.pushState({ ...window.history.state, __tg: 'result' }, '');
    }
   
  }, []);

  
  useEffect(() => {
    if (stage === 'result' && dest && tripOrigin && trips.length > 0) {
      saveRide({ dest, origin: tripOrigin, activeIndex, ts: Date.now() });
    }
  }, [stage, dest, tripOrigin, activeIndex, trips.length]);

  useEffect(() => {
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const name of POPULAR_HUBS) {
      const hit = search(name, 1)[0];
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        hits.push(hit);
      }
    }
    setPopularHubs(hits);
  }, []);

  
  const popLatKey = Math.round(pos.lat / 0.005) * 0.005;
  const popLngKey = Math.round(pos.lng / 0.005) * 0.005;
  const popular = useMemo(() => {
    if (popularHubs.length === 0) return [];
    if (!hasRealFix) {
      return popularHubs.slice(0, POPULAR_COUNT).map((hit) => ({ hit, distM: null as number | null }));
    }
    return popularHubs
      .map((hit) => ({ hit, distM: Math.round(haversineM(pos.lat, pos.lng, hit.lat, hit.lng)) }))
      .sort((a, b) => a.distM! - b.distM!)
      .slice(0, POPULAR_COUNT);
    
  }, [popularHubs, hasRealFix, popLatKey, popLngKey]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const onSearch = (v: string) => {
    setQ(v);
    setHits(v.trim() ? search(v) : []);
  };

  const pickDestination = (h: SearchHit) => {
    
    setDest(h);
    
    setTripOrigin(hasRealFix ? { lat: pos.lat, lng: pos.lng } : null);
    setActiveIndex(0);
    setNavDir('fwd');
    setStage('result');
    
    window.history.pushState({ ...window.history.state, __tg: 'result' }, '');
  };

  const findMyTrotro = () => {
    if (hits.length > 0) pickDestination(hits[0]);
    else searchInputRef.current?.focus();
  };

  
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const mapOpenRef = useRef(mapOpen);
  mapOpenRef.current = mapOpen;
  const destRef = useRef(dest);
  destRef.current = dest;

  
  const resetToSearch = () => {
    setNavDir('back');
    setStage('search');
    setDest(null);
    setTripOrigin(null);
    setActiveIndex(0);
    setQ('');
    setHits([]);
    setMapOpen(null);
    clearSavedRide(); 
  };

  
  const goBack = () => window.history.back();
  const openMap = (payload: { leg: BoardingOption; withUser: boolean }) => {
    setMapOpen(payload);
    window.history.pushState({ ...window.history.state, __tg: 'map' }, '');
  };
  const closeMap = () => window.history.back();

  
  const goHomeViaHistory = () => {
    const levels = (mapOpenRef.current ? 1 : 0) + (stageRef.current === 'result' ? 1 : 0);
    if (levels > 0) window.history.go(-levels);
    else resetToSearch();
  };

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const tg = (e.state as { __tg?: string } | null)?.__tg;
      if ((tg === 'result' || tg === 'map') && destRef.current) {
        
        setMapOpen(null);
        setStage('result');
      } else {
        
        resetToSearch();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  
  useEffect(() => {
    const handler = () => goHomeViaHistory();
    window.addEventListener('trotro:gohome', handler);
    return () => window.removeEventListener('trotro:gohome', handler);
    
  }, []);

  const renderHit = (h: SearchHit) => (
    <button key={h.id} className="tg-acrow" onClick={() => pickDestination(h)}>
      <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{h.display}</span>
    </button>
  );

  const stats = getPackStats();
  
  const active: Trip | undefined = trips[Math.min(activeIndex, Math.max(0, trips.length - 1))];

  // Live "you are here" position along the planned trip. Same on-device GPS
  // watch that already feeds the map, projected onto the cached route geometry
  // — this is what moves the dot down the Step 3 list as the car moves.
  const liveRide = useRideProgress(active?.legs ?? null, pos, {
    enabled: hasRealFix,
    accuracyM: geoAccuracy,
  });

  // "Look out for": the upcoming on-route landmark + its street-level image.
  // Reuses the same live position; picks the next landmark ahead and fetches
  // imagery through /api/streetview. Gracefully absent when there's no landmark
  // ahead or no GPS fix yet.
  const lookout = useLookout(active?.legs ?? null, liveRide, hasRealFix);

 
  const labelOrigin = tripOrigin ?? (hasRealFix ? pos : null);
  const originName = labelOrigin ? nearestNeighborhoodOffline(labelOrigin.lat, labelOrigin.lng) : null;
  const originLabel = originName ? `Near ${originName}` : labelOrigin ? 'Your location' : 'Circle';

  return (
    <div>
      {stage === 'search' && (
        <section className={`tg-home ${navDir === 'back' ? 'tg-slide-back' : 'tg-rise'}`}>
          {isDemoPack() && (
            <p className="tg-demobanner" role="note">
              <Construction size={15} strokeWidth={2} aria-hidden="true" />
              Demo data, routes &amp; stops are placeholders, not yet field-verified.
            </p>
          )}
          {geoStatus === 'locating' && (
            <p className="tg-geobanner" role="note">
              <Signal size={15} strokeWidth={2} aria-hidden="true" />
              Getting your location, until it lands, results are shown from Circle.
            </p>
          )}
          {(geoStatus === 'denied' || geoStatus === 'unavailable') && (
            <p className="tg-geobanner" role="note">
              <Signal size={15} strokeWidth={2} aria-hidden="true" />
              {geoStatus === 'denied'
                ? 'Location is off — showing routes from Circle. Turn on location for stops near you.'
                : "Couldn't get your location — showing routes from Circle."}
            </p>
          )}
          {geoStatus === 'ok' && geoAccuracy != null && geoAccuracy > 100 && (
            <p className="tg-geobanner" role="note">
              <Signal size={15} strokeWidth={2} aria-hidden="true" />
              {`Approximate location (±${Math.round(geoAccuracy)} m) — getting a more precise fix…`}
            </p>
          )}
          {/* PRIMARY — search first. A rider at a roadside reaches the
              destination field immediately, above any editorial content. */}
          <div className="tg-homehero">
            <h1 className="tg-where-title" aria-label="Where are you going?">
              <Typewriter text="Where are you going?" />
            </h1>
            <p className="tg-homesub">Type a destination for step-by-step trotro directions.</p>
          </div>

          <div className="tg-homecard">
            <div className="tg-search-premium">
              <Search size={20} strokeWidth={1.75} aria-hidden="true" />
              <input
                ref={searchInputRef}
                value={q}
                onChange={(e) => onSearch(e.currentTarget.value)}
                placeholder="Where to?"
                aria-label="Destination"
              />
              {q.trim() && (
                <button className="tg-home-clear" onClick={() => onSearch('')} aria-label="Clear search">
                  <X size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </div>

            {q.trim() && hits.length > 0 && (
              <div className="tg-acdropdown">{hits.map(renderHit)}</div>
            )}

            {q.trim() && hits.length === 0 && (
              <div className="tg-empty">
                <Construction size={36} strokeWidth={1} className="ico" aria-hidden="true" />
                <p className="tg-body">{"This area isn't mapped yet 🚧"}</p>
                <Link className="tg-btn tg-btn--secondary tg-btn--sm" href={`/contribute?q=${encodeURIComponent(q.trim())}`}>
                  <Flag size={18} strokeWidth={2} aria-hidden="true" />
                  Help us map it
                </Link>
              </div>
            )}

            {!q.trim() && popular.length > 0 && (
              <>
                <p className="tg-pilllabel">{hasRealFix ? 'Popular near you' : 'Popular destinations'}</p>
                <div className="tg-destlist tg-stagger">
                  {popular.map(({ hit: h, distM }) => (
                    <button key={h.id} className="tg-destrow" onClick={() => pickDestination(h)}>
                      <span className="tg-destrow-icon">
                        <MapPin size={16} strokeWidth={1.75} aria-hidden="true" />
                      </span>
                      <span className="tg-destrow-main">
                        <span className="tg-destrow-title">{h.display}</span>
                        <span className="tg-destrow-sub">
                          {h.type === 'stop' ? 'Trotro stop' : 'Route'}
                          {distM != null && ` · ${formatDist(distM)} away`}
                        </span>
                      </span>
                      <ChevronRight size={16} strokeWidth={2} className="tg-chev" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </>
            )}

            <button className="tg-btn tg-btn--primary" onClick={findMyTrotro}>
              Find my TroTro
              <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          {nearestStop && (
            <button
              className="tg-nearestcard"
              onClick={() => openWalkingDirections(nearestStop.stop.lat, nearestStop.stop.lng, nearestStop.stop.name)}
            >
              <span className="tg-nearestcard-icon">
                <MapPin size={18} strokeWidth={2} aria-hidden="true" />
              </span>
              <span className="tg-nearestcard-main">
                <span className="tg-nearestcard-title">Nearest stop: {nearestStop.stop.name}</span>
                <span className="tg-nearestcard-sub">
                  {formatDist(nearestStop.distanceM)} away · ~{walkingMinutes(nearestStop.distanceM)} min walk
                </span>
              </span>
              <Navigation size={16} strokeWidth={2} className="tg-chev" aria-hidden="true" />
            </button>
          )}

          {/* SECONDARY — editorial / onboarding, demoted below the search so it
              never competes with the primary task. The old top hero slides live
              here now as a "how trotros work" gallery, no longer mixed with the
              search prompt. */}
          <p className="tg-pilllabel">New to trotros? How it works</p>
          <div
            className="tg-herobanner tg-heroslides"
            aria-roledescription="carousel"
            aria-label="How TroTro works"
            onPointerDown={(e) => {
              heroTouch.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerUp={(e) => {
              const start = heroTouch.current;
              heroTouch.current = null;
              if (!start) return;
              const dx = e.clientX - start.x;
              const dy = e.clientY - start.y;
              
              if (Math.abs(dx) < 35 || Math.abs(dx) <= Math.abs(dy)) return;
              
              setHeroIndex((i) => (i + (dx < 0 ? 1 : -1) + HERO_SLIDES.length) % HERO_SLIDES.length);
            }}
            onPointerCancel={() => {
              heroTouch.current = null;
            }}
          >
            {HERO_SLIDES.map((slide, i) => (
              <div
                key={i}
                className={`tg-heroslide${i === heroIndex ? ' is-active' : ''}`}
                aria-hidden={i !== heroIndex}
              >
                <Image
                  src={slide.img}
                  alt={slide.alt}
                  fill
                  sizes="(max-width: 480px) 100vw, 480px"
                  className="tg-herobanner-img"
                />
                <div className="tg-herobanner-content">
                  {slide.kicker && <p className="tg-hero-kicker">{slide.kicker}</p>}
                  <h2 className="tg-where-title">{slide.title}</h2>
                  {slide.sub && <p className="tg-homesub">{slide.sub}</p>}
                </div>
              </div>
            ))}
            <div className="tg-herodots" role="tablist" aria-label="Slides">
              {HERO_SLIDES.map((_, i) => (
                <button
                  key={i}
                  className={`tg-herodot${i === heroIndex ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={i === heroIndex}
                  aria-label={`Go to slide ${i + 1}`}
                  onClick={() => setHeroIndex(i)}
                />
              ))}
            </div>
          </div>

          {/* Promo banner*/}
          <div className="tg-promo">
            <Image
              src="/img/trotro-mate-in-trotro-two.jpg"
              alt="A trotro mate signaling for passengers at sunset"
              fill
              sizes="(max-width: 480px) 100vw, 480px"
              className="tg-promo-img"
            />
            <p className="tg-promo-kicker">Community-mapped</p>
            <h3 className="tg-promo-title">Help build the map</h3>
            <p className="tg-promo-body">Every report makes TroTro Guide better for the next rider.</p>
            <Link className="tg-btn tg-btn--primary" href="/contribute">
              <Flag size={16} strokeWidth={2} aria-hidden="true" />
              Report a missing route
            </Link>
          </div>

          <div className="tg-promogrid tg-stagger">
            <div className="tg-promocard">
              <Bus size={20} strokeWidth={1.75} className="tg-promocard-icon" aria-hidden="true" />
              <div>
                <p className="tg-promocard-title">{stats.routes}+ routes</p>
                <p className="tg-promocard-sub">Mapped across Accra</p>
              </div>
            </div>
            <div className="tg-promocard tg-promocard--light">
              <BookMarked size={20} strokeWidth={1.75} className="tg-promocard-icon" aria-hidden="true" />
              <div>
                <p className="tg-promocard-title">{stats.stops}+ bus stops</p>
                <p className="tg-promocard-sub">Verified across Accra</p>
              </div>
            </div>
            <div className="tg-promocard tg-promocard--light">
              <Sparkles size={20} strokeWidth={1.75} className="tg-promocard-icon" aria-hidden="true" />
              <div>
                <p className="tg-promocard-title">Always free</p>
                <p className="tg-promocard-sub">No ads, no login</p>
              </div>
            </div>
            <div className="tg-promocard">
              <Signal size={20} strokeWidth={1.75} className="tg-promocard-icon" aria-hidden="true" />
              <div>
                <p className="tg-promocard-title">Works offline</p>
                <p className="tg-promocard-sub">Directions need no signal</p>
              </div>
            </div>
          </div>

          <PhotoStrip />

          <SupportCard />
        </section>
      )}

      {stage === 'result' && dest && (
        <section className="tg-slide-fwd">
          <div className="tg-resultsheader tg-resultsheader--hero">
            <button className="tg-back tg-back--onhero" onClick={goBack}>
              <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
              Back
            </button>
            <p className="tg-resultsroute">
              {}
              {originLabel}{' '}
              <ChevronRight size={16} strokeWidth={2} aria-hidden="true" /> {dest.display}
            </p>
            <p className="tg-resultscount">
              {trips.length} option{trips.length === 1 ? '' : 's'} found
            </p>
          </div>

          {fromPreview && (
            <p className="tg-meta">
              {geoStatus === 'locating'
                ? "Showing routes from Circle while we get your location — they'll update to stops near you once it lands."
                : "We don't have your location — showing routes from Circle. Turn on location for stops near you."}
            </p>
          )}
          {hasRealFix && geoAccuracy != null && geoAccuracy > 150 && (
            <p className="tg-meta">
              {`Approximate location (±${Math.round(geoAccuracy)} m) — the boarding stop will refine as your GPS sharpens.`}
            </p>
          )}
          {hasRealFix && active && active.transfers === 0 && active.legs[0].walk_m > MAX_WALK_M && (
            <p className="tg-meta tg-meta--warn">
              {`Heads up: the nearest direct trotro to ${dest.display} is a long walk (~${walkingMinutes(active.legs[0].walk_m)} min, ${formatDist(active.legs[0].walk_m)}). No closer trotro is mapped yet.`}
            </p>
          )}
          {active && active.transfers > 0 && (
            <p className="tg-meta tg-meta--info">
              {`No single trotro goes all the way — this trip changes cars ${active.transfers === 1 ? 'once' : `${active.transfers} times`}, transferring at ${active.legs[0].alight_stop_name?.trim() || 'the interchange'}.`}
            </p>
          )}

          {trips.length === 0 && (
            <div className="tg-card glass">
              <div className="tg-empty">
                <Construction size={40} strokeWidth={1} className="ico" aria-hidden="true" />
                <h3 className="tg-h3">Not mapped yet</h3>
                <p className="tg-body">No verified trotro to {dest.display} from here yet.</p>
                <Link
                  className="tg-btn tg-btn--primary"
                  href={`/contribute?q=${encodeURIComponent(dest.display)}`}
                >
                  <MapIcon size={20} strokeWidth={2} aria-hidden="true" />
                  Help us map it
                </Link>
              </div>
            </div>
          )}

          {active && (
            <>
              {}
              <div className="tg-card tg-card--hero">
                <p className="tg-steplabel tg-steplabel--hero">
                  {active.legs[0].board_stop_name?.trim()
                    ? `Step 1 · Walk to this ${active.legs[0].board_stop_name}`
                    : 'Step 1 · Walk to the nearest roadside stop'}
                </p>
                <WalkMap from={tripOrigin ?? pos} to={getStop(active.legs[0].board_stop_id) ?? pos} toLabel={active.legs[0].board_stop_name?.trim() || 'Nearest stop'} />
                <button
                  className="tg-btn tg-btn--onhero"
                  onClick={() => {
                    const b = getStop(active.legs[0].board_stop_id);
                    if (b) openWalkingDirections(b.lat, b.lng, active.legs[0].board_stop_name?.trim() || 'Nearest trotro stop');
                  }}
                >
                  <Navigation size={18} strokeWidth={2} aria-hidden="true" />
                  Open in Google Maps
                </button>
              </div>

              {/* STEP 2 — board: mate shout(s). One pill for a direct trip; an
                  ordered "1st car / 2nd car" list for a transfer trip so the
                  rider knows which shout to listen for, and where to change. */}
              <div className="tg-card glass">
                <p className="tg-steplabel">Step 2 · Board your trotro</p>
                <p className="tg-listenfor">
                  <Megaphone size={16} strokeWidth={2} aria-hidden="true" />
                  Listen for the mate shouting
                </p>
                {active.legs.length === 1 ? (
                  <div className="tg-shoutpills">
                    <span className="tg-shoutpill">&ldquo;{active.legs[0].mate_shout}&rdquo;</span>
                  </div>
                ) : (
                  <ol className="tg-legshouts">
                    {active.legs.map((leg, i) => (
                      <li key={leg.route_id + i} className="tg-legshout">
                        <span className="tg-legshout-label">{i === 0 ? '1st car' : i === 1 ? '2nd car' : `Car ${i + 1}`}</span>
                        <span className="tg-shoutpill">&ldquo;{leg.mate_shout}&rdquo;</span>
                        {i < active.legs.length - 1 && (
                          <span className="tg-legshout-to">then get down at {leg.alight_stop_name?.trim() || 'the transfer'}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              {/* STEP 3 — ride & alight: full stop list across all legs */}
              <div className="tg-card glass">
                <p className="tg-steplabel">Step 3 · Ride &amp; alight</p>
                {liveRide && (
                  <p
                    className={`tg-livestatus${liveRide.stale ? ' tg-livestatus--stale' : ''}`}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="tg-livestatus-dot" aria-hidden="true" />
                    {liveStatusText(liveRide)}
                    {liveRide.confidence === 'low' && !liveRide.stale && ' · approximate'}
                  </p>
                )}
                {lookout && <LookOutFor lookout={lookout} />}
                <ol className="tg-ridelist">
                  {(() => {
                    
                    type StopLandmark = ReturnType<typeof getLandmarksNearRoute>[number];
                    const seenLm = new Set<string>();
                    return active.legs.map((leg, li) => {
                      const route = getRoute(leg.route_id);
                      if (!route) return null;
                      
                      const ordered = [...route.stops].sort((a, b) => a.seq - b.seq);
                      let within = ordered.filter((rs) => rs.seq >= leg.board_seq && rs.seq <= leg.alight_seq);
                      
                      if (li > 0) within = within.filter((rs) => rs.seq !== leg.board_seq);
                     
                      within = within.filter(
                        (rs, i) =>
                          i === 0 ||
                          rs.seq === leg.board_seq ||
                          rs.seq === leg.alight_seq ||
                          rs.stopId !== within[i - 1].stopId,
                      );
                     
                      const lmBySeq = new Map<number, StopLandmark[]>();
                      for (const rl of getLandmarksNearRoute(leg.route_id, { boardStopId: leg.board_stop_id, alightStopId: leg.alight_stop_id })) {
                        if (seenLm.has(rl.landmark.id)) continue;
                        let bestSeq: number | null = null;
                        let bestD = Infinity;
                        for (const rs of within) {
                          const s = getStop(rs.stopId);
                          if (!s) continue;
                          const d = haversineM(rl.landmark.lat, rl.landmark.lng, s.lat, s.lng);
                          if (d < bestD) { bestD = d; bestSeq = rs.seq; }
                        }
                        if (bestSeq == null) continue;
                        seenLm.add(rl.landmark.id);
                        const arr = lmBySeq.get(bestSeq) ?? [];
                        arr.push(rl);
                        lmBySeq.set(bestSeq, arr);
                      }
                      const isTransferAlight = li < active.legs.length - 1; 
                      const nextShout = isTransferAlight ? active.legs[li + 1].mate_shout : null;
                      return within.map((rs) => {
                        const isBoard = rs.seq === leg.board_seq;
                        const isAlight = rs.seq === leg.alight_seq;
                        const stopLm = lmBySeq.get(rs.seq);
                        // Live position: exactly one row across the whole trip
                        // carries `here`; everything before it is `passed`.
                        const lp = liveRide?.progress;
                        const isHere = lp != null && lp.legIndex === li && lp.seq === rs.seq;
                        const isPassed =
                          lp != null &&
                          (li < lp.legIndex || (li === lp.legIndex && rs.seq < lp.seq));
                        const role = isBoard
                          ? 'board'
                          : isAlight
                            ? isTransferAlight
                              ? 'transfer'
                              : 'alight'
                            : '';
                        return (
                          <li
                            key={leg.route_id + rs.stopId + rs.seq}
                            className={[role, isPassed ? 'passed' : '', isHere ? 'here' : '']
                              .filter(Boolean)
                              .join(' ')}
                            aria-current={isHere ? 'step' : undefined}
                          >
                            {getStopName(rs.stopId) || 'Trotro stop'}
                            {isHere && <span className="tg-stoptag tg-stoptag--here">You are here</span>}
                            {isBoard && li === 0 && <span className="tg-stoptag">Board here</span>}
                            {isAlight && isTransferAlight && (
                              <span className="tg-stoptag tg-stoptag--transfer">Transfer, board &ldquo;{nextShout}&rdquo;</span>
                            )}
                            {isAlight && !isTransferAlight && <span className="tg-stoptag tg-stoptag--alight">Alight here</span>}
                            {stopLm && stopLm.length > 0 && (
                              <ul className="tg-stoplandmarks">
                                {stopLm
                                  .slice()
                                  .sort((a, b) => a.offsetM - b.offsetM)
                                  .slice(0, MAX_LANDMARKS_PER_STOP)
                                  .map(({ landmark: lm }) => (
                                    <li key={lm.id}>
                                      <MapPin size={12} strokeWidth={2} aria-hidden="true" />
                                      <span className="tg-stoplandmark-name">
                                        {lm.name}
                                        {lm.local ? ` (${lm.local})` : ''}
                                      </span>
                                      {lm.type && <span className="tg-stoplandmark-type">{lm.type}</span>}
                                    </li>
                                  ))}
                              </ul>
                            )}
                          </li>
                        );
                      });
                    });
                  })()}
                </ol>
                <div className="tg-tellmate">{active.legs[active.legs.length - 1].alight_phrase}</div>
                <div className="tg-controls">
                  {active.legs.map((leg, i) => (
                    <button
                      key={leg.route_id + i}
                      className="tg-btn tg-btn--secondary tg-btn--sm"
                      onClick={() => openMap({ leg, withUser: i === 0 })}
                    >
                      <MapIcon size={18} strokeWidth={2} aria-hidden="true" />
                      {active.legs.length === 1 ? 'Show on map' : i === 0 ? 'Map 1st car' : i === 1 ? 'Map 2nd car' : `Map car ${i + 1}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Other ways there */}
              {trips.length > 1 && (
                <>
                  <p className="tg-pilllabel">Other ways to get there</p>
                  <div className="tg-otherways tg-stagger">
                    {trips.map((t, i) =>
                      i === activeIndex ? null : (
                        <button
                          key={t.legs.map((l) => l.route_id + l.board_stop_id).join('>')}
                          className="tg-othercard"
                          onClick={() => setActiveIndex(i)}
                        >
                          <div className="tg-othercard-row">
                            <span>{t.legs[0].board_stop_name?.trim() || 'Roadside stop'}</span>
                            <span className="meta">{t.legs.reduce((s, l) => s + l.stops_between, 0)} stops</span>
                            <span className="dest">{t.legs[t.legs.length - 1].alight_stop_name?.trim() || 'your stop'}</span>
                          </div>
                          <span className="tg-badge">{t.transfers === 0 ? 'Direct' : `${t.transfers} transfer${t.transfers > 1 ? 's' : ''}`}</span>
                        </button>
                      ),
                    )}
                  </div>
                </>
              )}

              <SupportLink />
            </>
          )}
        </section>
      )}

      {getAttribution() && (
        <p className="tg-attribution">
          Beta map data {getAttribution()!.attribution} · {getAttribution()!.license}
        </p>
      )}

      {mapOpen && (
        <RouteMap
          routeId={mapOpen.leg.route_id}
          boardStopId={mapOpen.leg.board_stop_id}
          alightStopId={mapOpen.leg.alight_stop_id}
          user={mapOpen.withUser ? pos : null}
          onClose={closeMap}
        />
      )}

      {/* Donate prompt. Armed only once real directions are on screen, and it
          waits (see lib/donate-prompt.ts) so it never lands on top of someone
          still reading them. Suppressed while the full-screen map is open. */}
      <DonatePopup armed={stage === 'result' && trips.length > 0 && !mapOpen} />
    </div>
  );
}
