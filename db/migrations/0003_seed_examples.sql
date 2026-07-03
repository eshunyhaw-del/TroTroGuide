-- ============================================================================
-- Phase 0 seed: colloquial synonyms + one worked single-leg route so /search
-- and /boarding-point return real answers on a fresh DB. Replace with founder
-- fieldwork. Tokens/canonicals are stored already-normalized (lower, no accents).
-- ============================================================================

insert into core.name_synonyms(token, canonical, note) values
  ('37',       '37 military hospital', 'bus terminal at 37 Military Hospital'),
  ('circle',   'kwame nkrumah circle', 'major interchange'),
  ('atomic',   'atomic junction',      'Haatso/Atomic'),
  ('lapaz',    'la paz',               'common spelling variant'),
  ('lapazz',   'la paz',               'misspelling'),
  ('accra mall','accra mall',          'landmark'),
  ('terminal', 'terminal',             'generic')
on conflict (token) do nothing;


do $$
declare s_circle uuid; s_mall uuid; r uuid; l_mall uuid;
begin
  insert into core.landmarks(name, local_name, type, geom, visibility_score)
  values ('Accra Mall','Accra Mall','mall', ST_GeogFromText('SRID=4326;POINT(-0.1717 5.6212)'), 5)
  returning id into l_mall;

  insert into core.informal_stops(name, aliases, geom, confidence)
  values ('Kwame Nkrumah Circle','{Circle,"Nkrumah Circle"}',
          ST_GeogFromText('SRID=4326;POINT(-0.2074 5.5703)'), 0.9)
  returning id into s_circle;

  insert into core.informal_stops(name, aliases, geom, nearby_landmark_id, confidence)
  values ('Accra Mall Stop','{"Accra Mall","Mall"}',
          ST_GeogFromText('SRID=4326;POINT(-0.1719 5.6209)'), l_mall, 0.9)
  returning id into s_mall;

  insert into core.trotro_routes(name, mate_shout, path, confidence)
  values ('Circle - Accra Mall', 'Mall! Mall! Accra Mall!',
          ST_GeogFromText('SRID=4326;LINESTRING(-0.2074 5.5703, -0.1900 5.5950, -0.1719 5.6209)')::geometry,
          0.85)
  returning id into r;

  insert into core.route_stops(route_id, stop_id, seq, dist_m, board_phrase, alight_phrase) values
    (r, s_circle, 1, 0,    'Board at Circle; the mate shouts "Mall! Mall!"', null),
    (r, s_mall,   2, 7300, null, 'Tell the mate: "Accra Mall, bus stop!"');
end $$;
