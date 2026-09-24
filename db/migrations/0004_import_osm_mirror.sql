-- ============================================================================
-- 0004, Phase 1: prepare osm_mirror for the AccraMobile3 / GUMAP import.
-- ============================================================================
-- Extends the osm_mirror.osm_features table (canonical definition in 0001) with
-- import helpers (freshness_score, route_refs, last_edit) and per-row ODbL
-- attribution, plus the indexes the admin dashboard + fieldwork planning need.
--
-- osm_mirror is the ODbL "parking lot": SCAFFOLD ONLY. Nothing here is ever
-- copied into core.* as substantive content, core references OSM via osm_ref
-- text and only after independent field verification. This separation is the
-- license firewall that keeps the proprietary dataset legally non-derived.
-- ----------------------------------------------------------------------------

create schema if not exists osm_mirror;


create table if not exists osm_mirror.osm_features (
  osm_ref      text primary key,                    
  kind         text not null,                       
  tags         jsonb not null default '{}'::jsonb,  
  geom         geometry(Geometry,4326),             
  content_hash text not null,                        
  fetched_at   timestamptz not null default now()
);


alter table osm_mirror.osm_features alter column geom drop not null;


alter table osm_mirror.osm_features add column if not exists last_edit       timestamptz;
alter table osm_mirror.osm_features add column if not exists freshness_score int;      
alter table osm_mirror.osm_features add column if not exists route_refs      text[] not null default '{}';
alter table osm_mirror.osm_features add column if not exists license         text not null default 'ODbL';
alter table osm_mirror.osm_features add column if not exists attribution     text not null default '© OpenStreetMap contributors';
alter table osm_mirror.osm_features add column if not exists source_url      text;


create index if not exists osm_features_geom_gix       on osm_mirror.osm_features using gist (geom);
create index if not exists osm_features_kind_idx       on osm_mirror.osm_features (kind);
create index if not exists osm_features_fresh_idx      on osm_mirror.osm_features (freshness_score);
create index if not exists osm_features_routerefs_gin  on osm_mirror.osm_features using gin (route_refs);

comment on column osm_mirror.osm_features.freshness_score is
  '0..100, higher = more recently edited in OSM (linear over a 9-year window from import time). Scaffold metric only.';
comment on column osm_mirror.osm_features.route_refs is
  'AccraMobile route refs whose relation includes this stop, e.g. {11,216}. Fieldwork-planning convenience.';
comment on column osm_mirror.osm_features.license is
  'Always ODbL here. osm_mirror data is never sold; only field-verified core.* data is.';
