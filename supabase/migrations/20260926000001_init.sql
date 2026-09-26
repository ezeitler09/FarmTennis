-- Farm Tennis singles ladder: schema, security rules, score reporting, standings.
-- Everyone can read the ladder. Emails are visible only to signed-in players.
-- Scores change only through report_result / clear_result, which allow the two
-- players in a match (or a league admin) and log every change.

-- ---------- tables ----------
create table public.season (
  id int primary key default 1 check (id = 1),
  name text not null,
  rules text[] not null default '{}',
  playoffs text not null default 'TBD'
);

create table public.weeks (
  n int primary key,
  starts_on date not null,
  ends_on date not null,
  check (ends_on >= starts_on)
);

create table public.players (
  id text primary key,
  name text not null
);

create table public.player_emails (
  player_id text primary key references public.players(id) on delete cascade,
  email text not null unique check (email = lower(email))
);

create table public.admins (
  email text primary key check (email = lower(email))
);

create table public.matches (
  id text primary key,
  week int not null references public.weeks(n),
  ord int not null,
  home text not null references public.players(id),
  away text references public.players(id),
  outcome text check (outcome in ('completed', 'retired', 'default')),
  winner text check (winner in ('home', 'away')),
  sets jsonb not null default '[]'::jsonb check (jsonb_typeof(sets) = 'array'),
  reported_by text,
  reported_at timestamptz,
  source text not null default 'app',
  check ((outcome is null) = (winner is null)),
  check (away is not null or outcome is null),
  check (away is null or away <> home)
);
create index matches_week_idx on public.matches (week, ord);
create index matches_home_idx on public.matches (home);
create index matches_away_idx on public.matches (away);

create table public.match_history (
  id bigint generated always as identity primary key,
  match_id text not null references public.matches(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by text not null,
  summary text not null
);
create index match_history_match_idx on public.match_history (match_id, changed_at desc);

-- ---------- identity helpers ----------
create or replace function public.my_player_id()
returns text
language sql stable security definer set search_path = ''
as $$
  select pe.player_id from public.player_emails pe
  where pe.email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- Lets the sign-in form tell someone their email isn't on the roster
-- before it tries to send a link.
create or replace function public.roster_email_ok(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.player_emails where email = lower(trim(p_email)))
      or exists (select 1 from public.admins where email = lower(trim(p_email)));
$$;

-- ---------- score text ----------
create or replace function public.score_text(p_sets jsonb, p_winner text, p_outcome text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_outcome = 'default' then 'by default'
    else trim(
      coalesce(string_agg(
        case when p_winner = 'home'
             then (e ->> 'h') || '-' || (e ->> 'a')
             else (e ->> 'a') || '-' || (e ->> 'h') end
        || case when e ? 'tb'
                 and not coalesce((e ->> 'mtb')::boolean, false)
                 and least((e ->> 'h')::int, (e ->> 'a')::int) = 6
                 and greatest((e ->> 'h')::int, (e ->> 'a')::int) = 7
               then '(' || (e ->> 'tb') || ')' else '' end,
        ', ' order by ord), '')
      || case when p_outcome = 'retired' then ' ret.' else '' end)
  end
  from jsonb_array_elements(coalesce(p_sets, '[]'::jsonb)) with ordinality as t(e, ord);
$$;

-- ---------- writes ----------
create or replace function public.report_result(
  p_match_id text, p_outcome text, p_winner text, p_sets jsonb
)
returns public.matches
language plpgsql security definer set search_path = ''
as $$
declare
  m public.matches;
  me text := public.my_player_id();
  adm boolean := public.is_admin();
  who text;
  s jsonb;
  h int; a int;
  hw int := 0; aw int := 0;
  n int;
  clean jsonb;
  wname text; lname text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to report a score.' using errcode = '28000';
  end if;

  select * into m from public.matches where id = p_match_id for update;
  if not found then raise exception 'That match does not exist.'; end if;
  if m.away is null then raise exception 'That is a bye, so there is no score to report.'; end if;
  if not adm and (me is null or me not in (m.home, m.away)) then
    raise exception 'Only the two players in this match can report its score.' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('completed', 'retired', 'default') then
    raise exception 'Unknown result type.';
  end if;

  if p_sets is null or jsonb_typeof(p_sets) <> 'array' or p_outcome = 'default' then
    p_sets := '[]'::jsonb;
  end if;
  n := jsonb_array_length(p_sets);
  if n > 3 then raise exception 'A match has at most three sets.'; end if;

  for s in select value from jsonb_array_elements(p_sets) loop
    if jsonb_typeof(s -> 'h') <> 'number' or jsonb_typeof(s -> 'a') <> 'number' then
      raise exception 'Enter both players'' games for every set.';
    end if;
    h := (s ->> 'h')::numeric::int; a := (s ->> 'a')::numeric::int;
    if h < 0 or a < 0 or h > 40 or a > 40 then
      raise exception 'Set scores must be between 0 and 40.';
    end if;
    if h = a and p_outcome = 'completed' then
      raise exception 'A set can''t finish level. Check the scores.';
    end if;
    if h > a then hw := hw + 1; elsif a > h then aw := aw + 1; end if;
  end loop;

  if p_outcome = 'completed' then
    if n = 0 then raise exception 'Enter at least one set.'; end if;
    if hw = aw then raise exception 'The sets are split. Add the deciding set or tiebreak.'; end if;
    p_winner := case when hw > aw then 'home' else 'away' end;
  elsif p_winner is null or p_winner not in ('home', 'away') then
    raise exception 'Choose who won.';
  end if;

  -- keep only the fields the app understands
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'h', (e ->> 'h')::numeric::int,
           'a', (e ->> 'a')::numeric::int,
           'tb', case when jsonb_typeof(e -> 'tb') = 'number'
                      then greatest(0, least(40, (e ->> 'tb')::numeric::int)) end,
           'mtb', case when (e ->> 'mtb') = 'true' then true end
         )) order by ord), '[]'::jsonb)
    into clean
    from jsonb_array_elements(p_sets) with ordinality as t(e, ord);

  who := coalesce((select name from public.players where id = me), 'League admin');

  update public.matches
     set outcome = p_outcome, winner = p_winner, sets = clean,
         reported_by = who, reported_at = now(), source = 'app'
   where id = p_match_id
  returning * into m;

  select name into wname from public.players where id = case when m.winner = 'home' then m.home else m.away end;
  select name into lname from public.players where id = case when m.winner = 'home' then m.away else m.home end;
  insert into public.match_history (match_id, changed_by, summary)
  values (m.id, who, wname || ' def. ' || lname || ' ' || public.score_text(m.sets, m.winner, m.outcome));

  return m;
end;
$$;

create or replace function public.clear_result(p_match_id text)
returns public.matches
language plpgsql security definer set search_path = ''
as $$
declare
  m public.matches;
  me text := public.my_player_id();
  adm boolean := public.is_admin();
  who text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to change a score.' using errcode = '28000';
  end if;
  select * into m from public.matches where id = p_match_id for update;
  if not found then raise exception 'That match does not exist.'; end if;
  if not adm and (me is null or me not in (m.home, m.away)) then
    raise exception 'Only the two players in this match can change its score.' using errcode = '42501';
  end if;
  who := coalesce((select name from public.players where id = me), 'League admin');
  update public.matches
     set outcome = null, winner = null, sets = '[]'::jsonb,
         reported_by = who, reported_at = null, source = 'app'
   where id = p_match_id
  returning * into m;
  insert into public.match_history (match_id, changed_by, summary) values (m.id, who, 'Result cleared');
  return m;
end;
$$;

-- ---------- standings ----------
create or replace view public.standings
with (security_invoker = on) as
with sides as (
  select m.id, m.home as pid, 'home'::text as side, m.winner, m.outcome, m.sets
    from public.matches m where m.away is not null
  union all
  select m.id, m.away, 'away', m.winner, m.outcome, m.sets
    from public.matches m where m.away is not null
),
per as (
  select pid,
         count(*) filter (where outcome is not null and winner = side) as w,
         count(*) filter (where outcome is not null and winner <> side) as l,
         count(*) filter (where outcome is null) as to_play
    from sides group by pid
),
setrows as (
  select s.pid,
         (case when s.side = 'home' then e ->> 'h' else e ->> 'a' end)::int as mine,
         (case when s.side = 'home' then e ->> 'a' else e ->> 'h' end)::int as theirs,
         coalesce((e ->> 'mtb')::boolean, false) as mtb
    from sides s
    cross join lateral jsonb_array_elements(
      case when s.outcome in ('completed', 'retired') then s.sets else '[]'::jsonb end) as e
),
graded as (
  select pid, mine, theirs, mtb,
         case when mtb
              then (greatest(mine, theirs) >= 10 and abs(mine - theirs) >= 2)
                   or (greatest(mine, theirs) = 1 and least(mine, theirs) = 0)
              else (greatest(mine, theirs) >= 6 and abs(mine - theirs) >= 2)
                   or (greatest(mine, theirs) = 7 and least(mine, theirs) = 6)
         end as complete
    from setrows
),
sg as (
  select pid,
         count(*) filter (where complete and mine > theirs) as sets_won,
         count(*) filter (where complete and theirs > mine) as sets_lost,
         sum(case when mtb then (mine > theirs)::int else mine end) as games_won,
         sum(case when mtb then (theirs > mine)::int else theirs end) as games_lost
    from graded group by pid
)
select p.id as player_id, p.name,
       coalesce(per.w, 0)::int as w,
       coalesce(per.l, 0)::int as l,
       coalesce(sg.sets_won, 0)::int as sets_won,
       coalesce(sg.sets_lost, 0)::int as sets_lost,
       coalesce(sg.games_won, 0)::int as games_won,
       coalesce(sg.games_lost, 0)::int as games_lost,
       coalesce(per.to_play, 0)::int as to_play
  from public.players p
  left join per on per.pid = p.id
  left join sg on sg.pid = p.id;

-- ---------- row level security ----------
alter table public.season enable row level security;
alter table public.weeks enable row level security;
alter table public.players enable row level security;
alter table public.player_emails enable row level security;
alter table public.admins enable row level security;
alter table public.matches enable row level security;
alter table public.match_history enable row level security;

create policy "Anyone can read the season" on public.season for select to anon, authenticated using (true);
create policy "Anyone can read the weeks" on public.weeks for select to anon, authenticated using (true);
create policy "Anyone can read players" on public.players for select to anon, authenticated using (true);
create policy "Anyone can read matches" on public.matches for select to anon, authenticated using (true);
create policy "Anyone can read match history" on public.match_history for select to anon, authenticated using (true);
create policy "Signed-in league members can read emails" on public.player_emails
  for select to authenticated
  using ((select public.my_player_id()) is not null or (select public.is_admin()));
-- admins: no policies, so no direct access from the website.
-- No insert/update/delete policies anywhere: all writes go through the functions above.

-- ---------- function permissions ----------
revoke execute on function public.report_result(text, text, text, jsonb) from public, anon;
revoke execute on function public.clear_result(text) from public, anon;
grant execute on function public.report_result(text, text, text, jsonb) to authenticated;
grant execute on function public.clear_result(text) to authenticated;
revoke execute on function public.roster_email_ok(text) from public;
grant execute on function public.roster_email_ok(text) to anon, authenticated;

-- ---------- live updates ----------
alter publication supabase_realtime add table public.matches;
