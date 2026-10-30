-- 0030 — customer and driver app features for the tender gaps (compliance.md E1, E15, D13, C1).
--   E1  identity documents: a photo of the ID / resident card (front, optional back) and an
--       optional selfie, kept in a private storage bucket only the owner (and NWS staff) can
--       read. The ID number itself still goes through verify_identity() (simulated check).
--   E15 water-quality certificates: water_tests gain the lab, a validity date and a sample-data
--       flag; order_water_certificate() returns the test in force for a delivery.
--   D13 driver training: lessons with server-graded quizzes, completion per driver, and an
--       optional rule (app_settings DRIVER_TRAINING_REQUIRED, off by default) that a driver
--       must finish it before going online.
--   C1  GPS fixes record their source ('phone' from the driver app, 'simulated' from the demo
--       trip); report_location() gains a 5-argument form that does exactly what the 4-argument
--       one does and then tags the stored fix.

-- ===========================================================================
-- E1 — identity documents
-- ===========================================================================
create table public.identity_documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  kind          text not null check (kind in ('id_front', 'id_back', 'selfie')),
  file_path     text not null,
  uploaded_at   timestamptz not null default now(),
  -- 'received': waiting for NWS; the national ID check itself is simulated (verify_identity).
  review_status text not null default 'received' check (review_status in ('received', 'accepted', 'rejected')),
  review_note   text,
  reviewed_by   uuid references public.profiles (id) on delete set null,
  reviewed_at   timestamptz,
  unique (user_id, kind)
);
alter table public.identity_documents enable row level security;
revoke all on public.identity_documents from anon, authenticated;
grant select on public.identity_documents to authenticated;
create policy identity_documents_own   on public.identity_documents for select to authenticated using (user_id = auth.uid());
create policy identity_documents_staff on public.identity_documents for select to authenticated using (public.is_staff());

-- The file is uploaded first (identity/<uid>/<uuid>.jpg); this records it. A new photo of the
-- same kind replaces the old record and goes back to 'received'.
create function public.add_identity_document(p_kind text, p_path text)
returns public.identity_documents
language plpgsql security definer set search_path = public
as $$
declare d public.identity_documents;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if public.my_role() not in ('customer', 'business', 'driver') then raise exception 'forbidden_for_role'; end if;
  if p_kind not in ('id_front', 'id_back', 'selfie') then raise exception 'invalid_kind'; end if;
  if p_path is null or p_path !~ ('^' || auth.uid()::text || '/[A-Za-z0-9._-]{1,120}$') then raise exception 'invalid_path'; end if;
  insert into public.identity_documents (user_id, kind, file_path)
  values (auth.uid(), p_kind, p_path)
  on conflict (user_id, kind) do update
     set file_path = excluded.file_path, uploaded_at = now(), review_status = 'received',
         review_note = null, reviewed_by = null, reviewed_at = null
  returning * into d;
  return d;
end $$;

-- Private bucket: each person reads and writes only their own folder; NWS staff can read all
-- (Supabase only — PGlite has no storage schema).
do $$
begin
  if to_regclass('storage.buckets') is not null and to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public) values ('identity', 'identity', false) on conflict (id) do nothing;
    execute 'drop policy if exists identity_insert on storage.objects';
    execute 'drop policy if exists identity_read on storage.objects';
    execute 'drop policy if exists identity_update on storage.objects';
    execute 'drop policy if exists identity_delete on storage.objects';
    execute $p$create policy identity_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'identity' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute $p$create policy identity_read on storage.objects for select to authenticated
      using (bucket_id = 'identity' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_staff()))$p$;
    execute $p$create policy identity_update on storage.objects for update to authenticated
      using (bucket_id = 'identity' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute $p$create policy identity_delete on storage.objects for delete to authenticated
      using (bucket_id = 'identity' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  end if;
end $$;

-- ===========================================================================
-- E15 — water-quality certificates
-- ===========================================================================
-- The LIMS interface is simulated, so every test so far is sample data.
alter table public.water_tests
  add column lab         text not null default 'NWS Central Laboratory',
  add column valid_until date,
  add column sample      boolean not null default true;
update public.water_tests set valid_until = tested_at + 90 where valid_until is null;

-- Sample tests for drinking-water and treated-effluent tankers that have none yet, so the
-- certificate screen has something to show in the demo (clearly marked as sample data).
insert into public.water_tests (tanker_id, cert_no, tested_at, chlorine, turbidity, tds, ph, ecoli, coliforms, passed, lab, valid_until, sample)
select t.id, 'WQ-S-' || upper(left(replace(t.id::text, '-', ''), 10)), current_date - 20, 0.45, 0.40, 310, 7.4,
       'Not detected', 'Not detected', true, 'NWS Central Laboratory', current_date + 70, true
  from public.tankers t
 where t.service_type in ('DW', 'TE')
   and not exists (select 1 from public.water_tests w where w.tanker_id = t.id)
on conflict (cert_no) do nothing;

-- The certificate for one delivery: the tanker's latest test on or before the delivery day
-- (or before today while the order is open), with whether it was still valid then.
create function public.order_water_certificate(p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare o public.orders; w public.water_tests; d date; until date; t public.tankers;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or not (public.can_see_order(p_order_id) or public.is_staff()) then raise exception 'not_found'; end if;
  if o.tanker_id is null or o.service_type = 'WW' then return null; end if;
  select * into t from public.tankers where id = o.tanker_id;
  d := coalesce(o.delivered_at, o.filled_at, now())::date;
  select * into w from public.water_tests x where x.tanker_id = o.tanker_id and x.tested_at <= d order by x.tested_at desc limit 1;
  if w.id is null then
    select * into w from public.water_tests x where x.tanker_id = o.tanker_id order by x.tested_at desc limit 1;
  end if;
  if w.id is null then return null; end if;
  until := coalesce(w.valid_until, w.tested_at + 90);
  return jsonb_build_object(
    'test_id', w.id, 'cert_no', w.cert_no, 'tested_at', w.tested_at, 'lab', w.lab, 'valid_until', until,
    'passed', w.passed, 'sample', w.sample, 'valid_on_delivery', w.tested_at <= d and until >= d,
    'chlorine', w.chlorine, 'turbidity', w.turbidity, 'tds', w.tds, 'ph', w.ph, 'ecoli', w.ecoli, 'coliforms', w.coliforms,
    'order_no', o.order_no, 'service_type', o.service_type, 'gallons', o.gallons, 'delivered_at', o.delivered_at,
    'plate', coalesce(o.tanker_plate, t.plate), 'company', (select name from public.companies where id = t.company_id));
end $$;

-- ===========================================================================
-- D13 — driver training
-- ===========================================================================
-- Lessons and their answer keys (one correct option index per question). The content itself
-- (EN/AR text, pictures, questions) lives in the driver app (components/driver/training.ts),
-- which must list the same lessons and answers; tests/unit/training.test.ts checks they match.
create table public.training_lessons (
  key        text primary key,
  sort       integer not null,
  answer_key integer[] not null,
  pass_min   integer not null,
  active     boolean not null default true,
  check (pass_min between 1 and coalesce(array_length(answer_key, 1), 0))
);
insert into public.training_lessons (key, sort, answer_key, pass_min) values
  ('safety',    1, array[1, 2, 0], 3),
  ('filling',   2, array[2, 0, 1], 3),
  ('discharge', 3, array[0, 2, 1], 3),
  ('pod',       4, array[1, 0, 2], 3),
  ('etiquette', 5, array[2, 1, 0], 3);
alter table public.training_lessons enable row level security;
revoke all on public.training_lessons from anon, authenticated;
-- Signed-in users see the lessons but not the answers.
grant select (key, sort, pass_min, active) on public.training_lessons to authenticated;
create policy training_lessons_read on public.training_lessons for select to authenticated using (true);

create table public.driver_training (
  driver_id  uuid not null references public.profiles (id) on delete cascade,
  lesson     text not null references public.training_lessons (key) on delete cascade,
  score      integer not null,
  total      integer not null,
  passed_at  timestamptz not null default now(),
  attempts   integer not null default 1,
  primary key (driver_id, lesson)
);
alter table public.driver_training enable row level security;
revoke all on public.driver_training from anon, authenticated;
grant select on public.driver_training to authenticated;
create policy driver_training_own     on public.driver_training for select to authenticated using (driver_id = auth.uid());
create policy driver_training_staff   on public.driver_training for select to authenticated using (public.is_staff());
create policy driver_training_company on public.driver_training for select to authenticated using (
  exists (select 1 from public.profiles p where p.id = driver_training.driver_id and p.company_id is not null and p.company_id = public.my_company_id()));

insert into public.app_settings (key, value, notes) values
  ('DRIVER_TRAINING_REQUIRED', 'false', 'true: a driver must pass every active training lesson in the driver app before going online. false (default): the app only reminds them.')
on conflict (key) do nothing;

-- Every active lesson passed by the driver.
create function public.training_complete(p_driver uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select not exists (
    select 1 from public.training_lessons l
     where l.active and not exists (select 1 from public.driver_training d where d.driver_id = p_driver and d.lesson = l.key))
$$;

-- Grades a quiz against the answer key. A pass is recorded (best score kept); a fail is not.
create function public.complete_training_lesson(p_lesson text, p_answers integer[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare l public.training_lessons; n integer; ok integer := 0; i integer;
begin
  if public.my_role() <> 'driver' then raise exception 'not_a_driver'; end if;
  select * into l from public.training_lessons where key = p_lesson and active;
  if not found then raise exception 'not_found'; end if;
  n := array_length(l.answer_key, 1);
  if p_answers is null or coalesce(array_length(p_answers, 1), 0) <> n then raise exception 'invalid_answers'; end if;
  for i in 1 .. n loop
    if p_answers[i] = l.answer_key[i] then ok := ok + 1; end if;
  end loop;
  if ok >= l.pass_min then
    insert into public.driver_training (driver_id, lesson, score, total)
    values (auth.uid(), l.key, ok, n)
    on conflict (driver_id, lesson) do update
       set score = greatest(driver_training.score, excluded.score), total = excluded.total,
           attempts = driver_training.attempts + 1, passed_at = case when excluded.score > driver_training.score then now() else driver_training.passed_at end;
  end if;
  return jsonb_build_object('passed', ok >= l.pass_min, 'correct', ok, 'total', n, 'complete', public.training_complete(auth.uid()));
end $$;

-- With DRIVER_TRAINING_REQUIRED on, the assigned driver can't switch their tanker online until
-- the training is complete. Staff and system changes are not affected.
create function public.tanker_training_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare drv uuid;
begin
  if new.is_online and (tg_op = 'INSERT' or not old.is_online)
     and coalesce((select value from public.app_settings where key = 'DRIVER_TRAINING_REQUIRED'), 'false') = 'true' then
    select driver_id into drv from public.tanker_assignments where tanker_id = new.id and unassigned_at is null;
    if drv is not null and drv = auth.uid() and not public.training_complete(drv) then
      raise exception 'training_required';
    end if;
  end if;
  return new;
end $$;
create trigger tankers_training_guard before insert or update of is_online on public.tankers
  for each row execute function public.tanker_training_guard();

-- ===========================================================================
-- C1 — where each GPS fix came from
-- ===========================================================================
alter table public.gps_fixes add column source text check (source is null or source in ('phone', 'simulated', 'ivms'));
-- The phone path (0028: report_location → record_fix(…, 'phone')) plus the fix's real source:
-- the stored fix and tankers.last_fix_source say 'phone' or 'simulated'. When the tanker is on a
-- live IVMS feed, 0028 keeps the IVMS position and nothing is stored or tagged here.
create function public.report_location(
  p_lat         double precision,
  p_lng         double precision,
  p_accuracy_m  double precision,
  p_recorded_at timestamptz,
  p_source      text
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_source is null or p_source not in ('phone', 'simulated') then raise exception 'invalid_source'; end if;
  perform public.report_location(p_lat, p_lng, p_accuracy_m, p_recorded_at);
  update public.gps_fixes set source = p_source
   where tanker_id = public.my_tanker_id() and recorded_at = p_recorded_at and (source is null or source = 'phone');
  update public.tankers set last_fix_source = p_source
   where id = public.my_tanker_id() and last_fix_at = p_recorded_at and last_fix_source = 'phone';
end $$;

-- ===========================================================================
-- Grants
-- ===========================================================================
revoke execute on function public.tanker_training_guard() from public, anon, authenticated;
revoke execute on function public.add_identity_document(text, text), public.order_water_certificate(uuid),
  public.training_complete(uuid), public.complete_training_lesson(text, integer[]),
  public.report_location(double precision, double precision, double precision, timestamptz, text)
from public, anon;
grant execute on function public.add_identity_document(text, text), public.order_water_certificate(uuid),
  public.training_complete(uuid), public.complete_training_lesson(text, integer[]),
  public.report_location(double precision, double precision, double precision, timestamptz, text)
to authenticated;
