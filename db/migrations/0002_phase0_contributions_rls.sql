
create table core.contributions (
  id            uuid primary key default gen_random_uuid(),
  entity_type   core.entity_type not null,
  entity_id     uuid,                                   
  op            core.contribution_op not null,
  proposed      jsonb not null,                         -- proposed fields; geometry as GeoJSON under 'geometry'
  author_id     uuid,                                   -- auth.users id (NULL only for server/import)
  device_hash   text,                                   -- HMAC of device id (anti-Sybil); never the raw id
  source        core.data_source not null default 'community',
  status        core.contribution_status not null default 'submitted',
  validation    jsonb not null default '{}'::jsonb,
  confidence    numeric(3,2),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    uuid,
  applied_version_id uuid,
  parent_contribution_id uuid references core.contributions(id)
);
create index contributions_status_idx on core.contributions(status);
create index contributions_author_idx on core.contributions(author_id);
create index contributions_entity_idx on core.contributions(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Append-only history + audit
-- ---------------------------------------------------------------------------
create table core.entity_versions (
  id             uuid primary key default gen_random_uuid(),
  entity_type    core.entity_type not null,
  entity_id      uuid not null,
  version_no     int not null,
  data           jsonb not null,            -- full snapshot AFTER this change; geometry as GeoJSON
  op             core.contribution_op not null,
  contribution_id uuid references core.contributions(id),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (entity_type, entity_id, version_no)
);
create index entity_versions_entity_idx on core.entity_versions(entity_type, entity_id, version_no desc);

create table core.audit_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  actor          uuid,
  action         text not null,
  entity_type    core.entity_type,
  entity_id      uuid,
  contribution_id uuid,
  detail         jsonb not null default '{}'::jsonb
);
create index audit_log_entity_idx on core.audit_log(entity_type, entity_id);

-- physically append-only
create or replace function core.tg_forbid_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'append-only table %.%: % is not permitted',
    tg_table_schema, tg_table_name, tg_op;
end $$;
create trigger entity_versions_append_only before update or delete on core.entity_versions
  for each row execute function core.tg_forbid_mutation();
create trigger audit_log_append_only before update or delete on core.audit_log
  for each row execute function core.tg_forbid_mutation();


create or replace function core.transition_contribution(
  p_id uuid, p_to core.contribution_status, p_actor uuid, p_reason text)
returns void language plpgsql security definer set search_path=core,public as $$
declare cur core.contribution_status; ok boolean; et core.entity_type; eid uuid;
begin
  select status, entity_type, entity_id into cur, et, eid
    from core.contributions where id=p_id for update;
  if not found then raise exception 'contribution % not found', p_id; end if;
  ok := case
    when cur='submitted'      and p_to in ('auto_validated','in_review','rejected') then true
    when cur='auto_validated' and p_to in ('approved','in_review','rejected')       then true
    when cur='in_review'      and p_to in ('approved','rejected')                   then true
    when cur='approved'       and p_to in ('applied','rejected')                    then true
    when cur='applied'        and p_to in ('reverted')                             then true
    else false end;
  if not ok then raise exception 'illegal contribution transition % -> %', cur, p_to; end if;

  update core.contributions
     set status = p_to,
         decided_at = case when p_to in ('approved','rejected','applied','reverted') then now() else decided_at end,
         decided_by = coalesce(p_actor, decided_by)
   where id = p_id;

  insert into core.audit_log(actor, action, entity_type, entity_id, contribution_id, detail)
  values (p_actor, p_to::text, et, eid, p_id, jsonb_build_object('from', cur, 'reason', p_reason));
end $$;

-- Auto-validation: geofence (Greater Accra), geometry validity, naive dedupe.
create or replace function core.validate_contribution(p_id uuid)
returns core.contribution_status
language plpgsql security definer set search_path=core,public as $$
declare c core.contributions; g geometry; in_fence boolean; dup int := 0;
        v jsonb := '{}'::jsonb; next_status core.contribution_status;
begin
  select * into c from core.contributions where id=p_id;
  if not found then raise exception 'contribution % not found', p_id; end if;
  if c.status <> 'submitted' then raise exception 'validate requires submitted (got %)', c.status; end if;

  if c.proposed ? 'geometry' then
    g := ST_SetSRID(ST_GeomFromGeoJSON(c.proposed->>'geometry'), 4326);
    select ST_Covers(area::geometry, g) into in_fence from core.geofence where name='greater_accra';
    v := v || jsonb_build_object('geofence', coalesce(in_fence,false),
                                 'geometry_valid', ST_IsValid(g));
    if c.entity_type='stop' and c.op='create' then
      select count(*) into dup from core.informal_stops s
       where ST_DWithin(s.geom, g::geography, 60)
         and similarity(s.search_text, core.normalize_text(c.proposed->>'name')) > 0.5;
      v := v || jsonb_build_object('possible_duplicates', dup);
    end if;
  else
    in_fence := true;
    v := v || jsonb_build_object('geofence', true, 'geometry_valid', true);
  end if;

  next_status := case
    when (c.proposed ? 'geometry') and coalesce(in_fence,false)=false then 'rejected'
    when dup > 0                                                       then 'in_review'
    
    when c.op in ('delete') or (c.entity_type in ('stop','route','neighborhood') and c.proposed ? 'geometry' and c.op='update')
                                                                      then 'in_review'
    else 'auto_validated'
  end;

  update core.contributions set validation=v where id=p_id;
  perform core.transition_contribution(p_id, next_status, null, 'auto-validation');
  return next_status;
end $$;


create or replace function core.apply_contribution(p_id uuid, p_actor uuid default null)
returns uuid language plpgsql security definer set search_path=core,public as $$
declare c core.contributions; eid uuid; g geometry; vno int; snap jsonb;
begin
  select * into c from core.contributions where id=p_id for update;
  if not found then raise exception 'contribution % not found', p_id; end if;
  if c.status <> 'approved' then raise exception 'apply requires approved (got %)', c.status; end if;
  if c.proposed ? 'geometry' then g := ST_SetSRID(ST_GeomFromGeoJSON(c.proposed->>'geometry'),4326); end if;

  if c.entity_type='stop' then
    if c.op='create' then
      insert into core.informal_stops(name, aliases, geom, confidence)
      values (c.proposed->>'name',
              coalesce((select array_agg(value) from jsonb_array_elements_text(c.proposed->'aliases')), '{}'),
              g::geography, coalesce((c.proposed->>'confidence')::numeric, 0.5))
      returning id into eid;
    elsif c.op='update' then
      eid := c.entity_id;
      update core.informal_stops set
        name    = coalesce(c.proposed->>'name', name),
        aliases = coalesce((select array_agg(value) from jsonb_array_elements_text(c.proposed->'aliases')), aliases),
        geom    = coalesce(g::geography, geom)
      where id = eid;
    else  -- delete
      eid := c.entity_id; delete from core.informal_stops where id=eid;
    end if;
  elsif c.entity_type='landmark' then
    if c.op='create' then
      insert into core.landmarks(name, local_name, type, geom, visibility_score)
      values (c.proposed->>'name', c.proposed->>'local_name', c.proposed->>'type',
              g::geography, coalesce((c.proposed->>'visibility_score')::int, 3))
      returning id into eid;
    elsif c.op='update' then
      eid := c.entity_id;
      update core.landmarks set
        name=coalesce(c.proposed->>'name',name),
        local_name=coalesce(c.proposed->>'local_name',local_name),
        type=coalesce(c.proposed->>'type',type),
        geom=coalesce(g::geography,geom)
      where id=eid;
    else
      eid := c.entity_id; delete from core.landmarks where id=eid;
    end if;
  else
    raise exception 'apply_contribution Phase-0 supports stop/landmark only (got %).', c.entity_type;
  end if;

  
  insert into core.provenance(entity_type, entity_id, source, license, contributor_id, note)
  values (c.entity_type, eid, c.source,
          case when c.source='osm' then 'ODbL' else 'proprietary' end::core.data_license,
          c.author_id, 'applied via contribution '||p_id);

 
  if c.op='delete' then
    snap := jsonb_build_object('deleted', true);
  elsif c.entity_type='stop' then
    select jsonb_build_object('name',s.name,'aliases',to_jsonb(s.aliases),
             'geometry', ST_AsGeoJSON(s.geom)::jsonb, 'confidence', s.confidence)
      into snap from core.informal_stops s where s.id=eid;
  else
    select jsonb_build_object('name',l.name,'local_name',l.local_name,'type',l.type,
             'geometry', ST_AsGeoJSON(l.geom)::jsonb)
      into snap from core.landmarks l where l.id=eid;
  end if;

  select coalesce(max(version_no),0)+1 into vno
    from core.entity_versions where entity_type=c.entity_type and entity_id=eid;
  insert into core.entity_versions(entity_type, entity_id, version_no, data, op, contribution_id, created_by)
  values (c.entity_type, eid, vno, snap, c.op, p_id, p_actor);

  update core.contributions
     set entity_id = eid,
         applied_version_id = (select id from core.entity_versions
                                where entity_type=c.entity_type and entity_id=eid and version_no=vno)
   where id=p_id;

  perform core.transition_contribution(p_id, 'applied', p_actor, 'applied to live table');
  return eid;
end $$;


create or replace function core.revert_entity(
  p_entity_type core.entity_type, p_entity_id uuid, p_to_version int, p_actor uuid default null)
returns int language plpgsql security definer set search_path=core,public as $$
declare d jsonb; g geometry; vno int;
begin
  select data into d from core.entity_versions
   where entity_type=p_entity_type and entity_id=p_entity_id and version_no=p_to_version;
  if not found then raise exception 'version % not found', p_to_version; end if;
  if d ? 'geometry' then g := ST_SetSRID(ST_GeomFromGeoJSON(d->>'geometry'),4326); end if;

  if p_entity_type='stop' then
    update core.informal_stops set
      name=d->>'name',
      aliases=coalesce((select array_agg(value) from jsonb_array_elements_text(d->'aliases')),'{}'),
      geom=coalesce(g::geography, geom)
    where id=p_entity_id;
  elsif p_entity_type='landmark' then
    update core.landmarks set name=d->>'name', local_name=d->>'local_name',
      type=d->>'type', geom=coalesce(g::geography, geom) where id=p_entity_id;
  else
    raise exception 'revert Phase-0 supports stop/landmark only';
  end if;

  select coalesce(max(version_no),0)+1 into vno
    from core.entity_versions where entity_type=p_entity_type and entity_id=p_entity_id;
  insert into core.entity_versions(entity_type, entity_id, version_no, data, op, created_by)
  values (p_entity_type, p_entity_id, vno, d || jsonb_build_object('reverted_from', p_to_version), 'update', p_actor);
  insert into core.audit_log(actor, action, entity_type, entity_id, detail)
  values (p_actor, 'revert', p_entity_type, p_entity_id, jsonb_build_object('to_version', p_to_version));
  return vno;
end $$;


create or replace function core.search_places(p_q text, p_limit int default 12)
returns table(id uuid, kind text, display text, local text,
              lat double precision, lng double precision, score real)
language sql stable
set search_path = core, public
set pg_trgm.similarity_threshold = '0.2'
as $$
  with nq as (select core.normalize_text(p_q) as t),
  terms as (
    select t from nq
    union
    select s.canonical from core.name_synonyms s, nq where s.token = nq.t
  )
  select id, kind, display, local, lat, lng, max(score)::real as score from (
    
    select s.id, 'stop' kind, s.name display, null::text local,
           ST_Y(s.geom::geometry) lat, ST_X(s.geom::geometry) lng, 1.0 score
    from core.informal_stops s, terms
    where s.search_text like terms.t || '%'
       or terms.t = any (select core.normalize_text(a) from unnest(s.aliases) a)
    union all
    select n.id,'neighborhood', n.name, array_to_string(n.local_names,', '),
           ST_Y(n.centroid::geometry), ST_X(n.centroid::geometry), 0.95
    from core.neighborhoods n, terms where n.search_text like terms.t || '%'
    union all
    select l.id,'landmark', l.name, l.local_name,
           ST_Y(l.geom::geometry), ST_X(l.geom::geometry), 0.92
    from core.landmarks l, terms where l.search_text like terms.t || '%'
    union all
    -- trigram fuzzy path (typos / longer queries)
    select s.id,'stop', s.name, null,
           ST_Y(s.geom::geometry), ST_X(s.geom::geometry), similarity(s.search_text, terms.t)
    from core.informal_stops s, terms where s.search_text % terms.t
    union all
    select n.id,'neighborhood', n.name, array_to_string(n.local_names,', '),
           ST_Y(n.centroid::geometry), ST_X(n.centroid::geometry), similarity(n.search_text, terms.t)
    from core.neighborhoods n, terms where n.search_text % terms.t
    union all
    select l.id,'landmark', l.name, l.local_name,
           ST_Y(l.geom::geometry), ST_X(l.geom::geometry), similarity(l.search_text, terms.t)
    from core.landmarks l, terms where l.search_text % terms.t
  ) r
  group by id, kind, display, local, lat, lng
  order by score desc
  limit p_limit;
$$;


create or replace function core.boarding_point(
  p_lat double precision, p_lng double precision,
  p_dest_id uuid, p_dest_type text,
  p_radius_m double precision default 600)
returns table(
  board_stop_id uuid, board_stop_name text, board_lat double precision, board_lng double precision,
  walk_m double precision, route_id uuid, route_name text, mate_shout text, board_phrase text,
  alight_stop_id uuid, alight_stop_name text, alight_phrase text, stops_between int)
language plpgsql stable set search_path=core,public as $$
declare user_pt geography := ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography;
        dest_pt geography;
begin
  if    p_dest_type='stop'         then select geom     into dest_pt from core.informal_stops where id=p_dest_id;
  elsif p_dest_type='neighborhood' then select centroid into dest_pt from core.neighborhoods   where id=p_dest_id;
  elsif p_dest_type='landmark'     then select geom     into dest_pt from core.landmarks       where id=p_dest_id;
  end if;
  if dest_pt is null then return; end if;

  return query
  with alight as (
    select rs.route_id, rs.stop_id, rs.seq, s.name, s.geom
    from core.route_stops rs join core.informal_stops s on s.id=rs.stop_id
    where ST_DWithin(s.geom, dest_pt, 500)
  ),
  board as (
    select rs.route_id, rs.stop_id, rs.seq, s.name, s.geom,
           ST_Distance(s.geom, user_pt) as d_user
    from core.route_stops rs join core.informal_stops s on s.id=rs.stop_id
    where ST_DWithin(s.geom, user_pt, p_radius_m)
  )
  select b.stop_id, b.name, ST_Y(b.geom::geometry), ST_X(b.geom::geometry),
         round(b.d_user)::double precision, r.id, r.name, r.mate_shout,
         coalesce(rsb.board_phrase, 'Wave down a trotro and the mate will be shouting: '||r.mate_shout),
         a.stop_id, a.name,
         coalesce(rsa.alight_phrase, 'When you near '||a.name||', tell the mate: "Bus stop!"'),
         (a.seq - b.seq)
  from board b
  join alight a on a.route_id=b.route_id and a.seq > b.seq           
  join core.trotro_routes r on r.id=b.route_id
  join core.route_stops rsb on rsb.route_id=b.route_id and rsb.seq=b.seq
  join core.route_stops rsa on rsa.route_id=a.route_id and rsa.seq=a.seq
  order by b.d_user asc, (a.seq - b.seq) asc
  limit 5;
end $$;


create or replace function core.export_core_pack()
returns jsonb language sql stable security definer set search_path=core,public as $$
  select jsonb_build_object(
    'bbox', jsonb_build_array(-0.70, 5.40, 0.30, 6.10),
    'stops', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'aliases', to_jsonb(s.aliases),
        'lat', ST_Y(s.geom::geometry), 'lng', ST_X(s.geom::geometry),
        'routeIds', coalesce((select jsonb_agg(distinct rs.route_id)
                              from core.route_stops rs where rs.stop_id=s.id),'[]'::jsonb),
        'landmark', (select l.name from core.landmarks l where l.id=s.nearby_landmark_id)
      )) from core.informal_stops s), '[]'::jsonb),
    'routes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'mateShout', r.mate_shout,
        'geometry', ST_AsGeoJSON(r.path)::jsonb,
        'stops', coalesce((select jsonb_agg(jsonb_build_object(
            'stopId', rs.stop_id, 'seq', rs.seq, 'distM', rs.dist_m,
            'board', rs.board_phrase, 'alight', rs.alight_phrase) order by rs.seq)
          from core.route_stops rs where rs.route_id=r.id), '[]'::jsonb)
      )) from core.trotro_routes r), '[]'::jsonb),
    'landmarks', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'local', l.local_name, 'type', l.type,
        'lat', ST_Y(l.geom::geometry), 'lng', ST_X(l.geom::geometry)
      )) from core.landmarks l), '[]'::jsonb),
    'neighborhoods', coalesce((select jsonb_agg(jsonb_build_object(
        'id', n.id, 'name', n.name, 'localNames', to_jsonb(n.local_names),
        'lat', ST_Y(n.centroid::geometry), 'lng', ST_X(n.centroid::geometry)
      )) from core.neighborhoods n where n.centroid is not null), '[]'::jsonb),
    'synonyms', coalesce((select jsonb_agg(jsonb_build_object('token', token, 'canonical', canonical))
                          from core.name_synonyms), '[]'::jsonb)
  );
$$;


alter table core.informal_stops enable row level security;
alter table core.trotro_routes  enable row level security;
alter table core.route_stops    enable row level security;
alter table core.landmarks      enable row level security;
alter table core.neighborhoods  enable row level security;
alter table core.contributions  enable row level security;
alter table core.entity_versions enable row level security;
alter table core.provenance     enable row level security;

create policy stops_read         on core.informal_stops for select using (true);
create policy routes_read        on core.trotro_routes  for select using (true);
create policy route_stops_read   on core.route_stops    for select using (true);
create policy landmarks_read     on core.landmarks      for select using (true);
create policy neighborhoods_read on core.neighborhoods  for select using (true);

create policy contrib_insert on core.contributions for insert to authenticated
  with check (author_id = auth.uid() and status = 'submitted' and source in ('community','fieldwork'));
create policy contrib_select on core.contributions for select to authenticated
  using (author_id = auth.uid() or status = 'applied');


grant usage on schema core to anon, authenticated;
grant select on core.informal_stops, core.trotro_routes, core.route_stops,
                core.landmarks, core.neighborhoods to anon, authenticated;
grant insert, select on core.contributions to authenticated;

grant execute on function core.search_places(text,int)                              to anon, authenticated;
grant execute on function core.boarding_point(double precision,double precision,uuid,text,double precision)
                                                                                    to anon, authenticated;


grant execute on function core.validate_contribution(uuid)                          to service_role;
grant execute on function core.transition_contribution(uuid,core.contribution_status,uuid,text) to service_role;
grant execute on function core.apply_contribution(uuid,uuid)                        to service_role;
grant execute on function core.revert_entity(core.entity_type,uuid,int,uuid)        to service_role;
grant execute on function core.export_core_pack()                                   to service_role;
