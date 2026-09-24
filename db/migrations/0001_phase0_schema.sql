-- ============================================================================
-- Trotro Guide, Phase 0 schema
-- CORRECTIONS APPLIED:
--   * License firewall: osm_mirror (ODbL) vs core (proprietary) as SEPARATE schemas.
--   * Provenance table with per-field source + license tags.
--   * NO unaccent() inside GENERATED columns or expression indexes.
--     search_text is a PLAIN column maintained by a trigger; the GIN trigram
--     index is on that plain column, so an unaccent dictionary change or a
--     major-version restore can never silently corrupt query results.
-- ============================================================================

create extension if not exists postgis;
create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists pgcrypto;   -- gen_random_uuid()

create schema if not exists osm_mirror;
create schema if not exists core;

comment on schema osm_mirror is
  'ODbL data imported from OpenStreetMap. SCAFFOLD ONLY (road network for snapping, '
  'landmark candidates). NEVER copy geometry from here into core.* as substantive '
  'proprietary content. core references OSM via osm_ref text only. This separation is '
  'the license firewall that keeps the proprietary dataset legally non-derived.';

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type core.data_source        as enum ('osm','fieldwork','community','import');
create type core.data_license       as enum ('ODbL','proprietary','CC0');
create type core.entity_type        as enum ('stop','route','landmark','neighborhood','route_stop');
create type core.contribution_op    as enum ('create','update','delete');
create type core.contribution_status as enum
  ('submitted','auto_validated','in_review','approved','rejected','applied','reverted');

-- ---------------------------------------------------------------------------
-- OSM mirror (ODbL), scaffold only
-- ---------------------------------------------------------------------------
create table osm_mirror.osm_features (
  osm_ref      text primary key,                       -- 'node/123', 'way/456', 'relation/789'
  kind         text not null,                          -- highway / amenity / place / ...
  tags         jsonb not null default '{}'::jsonb,
  geom         geometry(Geometry,4326) not null,
  content_hash text not null,                          -- idempotent upsert short-circuit
  fetched_at   timestamptz not null default now()
);
create index osm_features_geom_gix on osm_mirror.osm_features using gist (geom);

-- ---------------------------------------------------------------------------
-- core live tables (proprietary truth, approved data only)
-- geography(Point) for stops/landmarks  -> true-metre ST_DWithin for the 400m walk
-- geometry(LineString/Polygon) for routes/boundaries -> cheaper line/polygon ops
-- ---------------------------------------------------------------------------
create table core.landmarks (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  local_name   text,
  type         text,
  geom         geography(Point,4326) not null,
  visibility_score int not null default 3 check (visibility_score between 1 and 5),
  osm_ref      text references osm_mirror.osm_features(osm_ref),  -- reference only, never a geom copy
  search_text  text not null default '',                          -- maintained by trigger (plain text)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table core.informal_stops (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  aliases      text[] not null default '{}',
  geom         geography(Point,4326) not null,
  nearby_landmark_id uuid references core.landmarks(id),
  confidence   numeric(3,2) not null default 0.50 check (confidence between 0 and 1),
  osm_ref      text references osm_mirror.osm_features(osm_ref),
  search_text  text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table core.trotro_routes (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  mate_shout   text not null,
  path         geometry(LineString,4326) not null,
  confidence   numeric(3,2) not null default 0.50 check (confidence between 0 and 1),
  osm_ref      text references osm_mirror.osm_features(osm_ref),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ordered stops along a route; carries the CACHED cumulative distance so on-board
-- guidance ("3 stops after Accra Mall") needs no live geometry on the hot path.
create table core.route_stops (
  route_id     uuid not null references core.trotro_routes(id) on delete cascade,
  stop_id      uuid not null references core.informal_stops(id) on delete restrict,
  seq          int  not null,
  dist_m       double precision not null default 0,  -- cumulative metres along path to this stop
  board_phrase text,                                 -- what to say to board
  alight_phrase text,                                -- what to say to alight
  primary key (route_id, seq),
  unique (route_id, stop_id)
);

create table core.neighborhoods (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  local_names  text[] not null default '{}',
  boundary     geometry(Polygon,4326),
  centroid     geography(Point,4326),
  parent_area  text,
  search_text  text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Provenance / license firewall ledger (per-entity, optionally per-field)
-- B2B export MUST exclude any field whose license = 'ODbL'.
-- ---------------------------------------------------------------------------
create table core.provenance (
  id           uuid primary key default gen_random_uuid(),
  entity_type  core.entity_type not null,
  entity_id    uuid not null,
  field        text,                                  -- null = whole entity
  source       core.data_source not null,
  license      core.data_license not null,
  osm_ref      text,                                  -- located against OSM, not copied from it
  contributor_id uuid,
  captured_at  timestamptz not null default now(),
  note         text
);
create index provenance_entity_idx on core.provenance (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Synonyms for colloquial tokens that trigram alone cannot match
-- (e.g. '37', 'circle', 'atomic', 'lapaz'). Tokens & canonicals are stored
-- already-normalized (lower, unaccented).
-- ---------------------------------------------------------------------------
create table core.name_synonyms (
  token     text primary key,    -- normalized input, e.g. '37'
  canonical text not null,       -- normalized target,  e.g. '37 military hospital'
  note      text
);

-- ---------------------------------------------------------------------------
-- Geofence: edits & stops must fall inside Greater Accra (anti-vandalism)
-- ---------------------------------------------------------------------------
create table core.geofence (
  name text primary key,
  area geography(Polygon,4326) not null
);
insert into core.geofence(name, area) values
  ('greater_accra',
   ST_GeogFromText('SRID=4326;POLYGON((-0.70 5.40, 0.30 5.40, 0.30 6.10, -0.70 6.10, -0.70 5.40))'))
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index landmarks_geom_gix       on core.landmarks       using gist (geom);
create index stops_geom_gix           on core.informal_stops  using gist (geom);
create index routes_path_gix          on core.trotro_routes   using gist (path);
create index neighborhoods_bnd_gix    on core.neighborhoods   using gist (boundary);
create index neighborhoods_ctr_gix    on core.neighborhoods   using gist (centroid);

-- trigram GIN on PLAIN columns (NOT expression indexes over unaccent)
create index stops_search_trgm        on core.informal_stops  using gin (search_text gin_trgm_ops);
create index landmarks_search_trgm    on core.landmarks       using gin (search_text gin_trgm_ops);
create index neighborhoods_search_trgm on core.neighborhoods  using gin (search_text gin_trgm_ops);
create index stops_aliases_gin        on core.informal_stops  using gin (aliases);

create index route_stops_route_seq    on core.route_stops (route_id, seq);
create index route_stops_stop         on core.route_stops (stop_id);

-- ---------------------------------------------------------------------------
-- search_text maintenance via TRIGGER (the unaccent-safe pattern)
-- normalize_text is STABLE (uses unaccent). It is ONLY ever called at write
-- time by a trigger, never embedded in a generated column or an index.
-- ---------------------------------------------------------------------------
create or replace function core.normalize_text(p text)
returns text language sql stable as $$
  select lower(unaccent(coalesce(p,'')));
$$;

create or replace function core.tg_stop_search_text()
returns trigger language plpgsql as $$
begin
  new.search_text := trim(core.normalize_text(new.name) || ' ' ||
                          core.normalize_text(array_to_string(new.aliases,' ')));
  new.updated_at := now();
  return new;
end $$;
create trigger stops_search_text before insert or update on core.informal_stops
  for each row execute function core.tg_stop_search_text();

create or replace function core.tg_landmark_search_text()
returns trigger language plpgsql as $$
begin
  new.search_text := trim(core.normalize_text(new.name) || ' ' || core.normalize_text(new.local_name));
  new.updated_at := now();
  return new;
end $$;
create trigger landmarks_search_text before insert or update on core.landmarks
  for each row execute function core.tg_landmark_search_text();

create or replace function core.tg_neighborhood_search_text()
returns trigger language plpgsql as $$
begin
  new.search_text := trim(core.normalize_text(new.name) || ' ' ||
                          core.normalize_text(array_to_string(new.local_names,' ')));
  new.updated_at := now();
  return new;
end $$;
create trigger neighborhoods_search_text before insert or update on core.neighborhoods
  for each row execute function core.tg_neighborhood_search_text();
