-- ============================================================================
-- 0005 — core.route_changes: operator-reported "this route changed" reports.
-- ============================================================================
-- A curation queue. Promote inserts rows here from fieldwork; you review and set
-- verified=true before they influence the shipped pack. This is metadata about
-- YOUR network knowledge — proprietary, no OSM linkage.

create table if not exists core.route_changes (
  id            uuid primary key default gen_random_uuid(),
  route_ref     text not null,
  change_type   text not null,   
  description   text,
  new_terminal  text,
  old_terminal  text,
  stops_added   integer,
  stops_removed integer,
  reported_by   text,
  reported_at   timestamptz not null default now(),
  verified      boolean not null default false,
  verified_at   timestamptz
);

create index if not exists route_changes_ref_idx on core.route_changes (route_ref);
create index if not exists route_changes_unreviewed_idx on core.route_changes (verified) where verified = false;
