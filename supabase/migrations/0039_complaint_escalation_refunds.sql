-- Sign-in, messaging and support (part 3 of 3):
--   #33  Complaint status and SLA for customers and businesses: the apps show received → in
--        review → resolved, the promised answer time (complaints.sla_hours / due_at, from
--        complaint_sla) and the reply thread. Business admins now also see the (non-internal)
--        thread of complaints on their organisation's orders, as they already see the cases.
--   #34  Escalation to Nama 1442: the customer (or the business member who filed it, or a
--        business admin) escalates a complaint once. escalate_complaint() records it in
--        complaint_escalations, moves the case to 'escalated' with high priority (a resolved
--        case is reopened), adds the customer's words to the thread and notifies the NWS
--        complaints agents (admins when there are none). NWS lists those cases first.
--   #35  One refund policy: refunds go to the Nama wallet (instant) unless the customer asks for
--        the original card. The refund message now says where the money went. The policy text
--        itself lives in lib/refundPolicy.ts (EN/AR) for every screen.

-- ===========================================================================
-- #34 — escalation
-- ===========================================================================
alter table public.complaints
  add column if not exists priority text not null default 'normal' check (priority in ('high', 'normal')),  -- also added by 0035
  add column escalated_at timestamptz,
  add column escalated_by text check (escalated_by in ('customer', 'staff'));
create index complaints_escalated_idx on public.complaints (escalated_at desc) where state = 'escalated';

create table public.complaint_escalations (
  id           bigint generated always as identity primary key,
  complaint_id uuid not null references public.complaints (id) on delete cascade,
  by_user      uuid references public.profiles (id) on delete set null,
  by_role      text not null,
  from_state   text not null,
  reason       text check (char_length(reason) <= 500),
  created_at   timestamptz not null default now()
);
create index complaint_escalations_case_idx on public.complaint_escalations (complaint_id, created_at);
alter table public.complaint_escalations enable row level security;
revoke all on public.complaint_escalations from public, anon, authenticated;
grant select on public.complaint_escalations to authenticated;
create policy complaint_escalations_read on public.complaint_escalations for select to authenticated using (
  public.is_staff() or exists (select 1 from public.complaints c where c.id = complaint_escalations.complaint_id));
-- (The subquery on complaints runs under the caller's RLS: their own cases, or their organisation's for admins.)

-- Business admins read the customer-facing thread of their organisation's complaints.
create policy complaint_notes_org on public.complaint_notes for select to authenticated using (
  not internal and public.my_org_role() = 'admin' and exists (
    select 1 from public.complaints c join public.orders o on o.id = c.order_id
     where c.id = complaint_notes.complaint_id and public.org_order_visible(o.org_id, o.property_id)));

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp, email, category, critical) values
  ('complaint_escalated', 'Complaint escalated by the customer', 'staff', '{case} escalated to 1442',
   '{category} complaint escalated by the customer: {reason}. Answer due {due}.',
   'تصعيد الشكوى {case} إلى 1442',
   'صعّد العميل شكوى {category}: {reason}. موعد الرد {due}.',
   true, false, false, true, 'service', false)
on conflict (event) do nothing;

create function public.escalate_complaint(p_complaint_id uuid, p_reason text default null)
returns public.complaints
language plpgsql security definer set search_path = public
as $$
declare
  c public.complaints; a public.complaints; r public.user_role := public.my_role(); u record; k integer := 0;
  why text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  v jsonb;
begin
  if r is null or r not in ('customer', 'business') then raise exception 'forbidden_for_role'; end if;
  select * into c from public.complaints where id = p_complaint_id for update;
  if not found or not (c.customer_id = auth.uid()
                       or (public.my_org_role() = 'admin' and exists (select 1 from public.orders o where o.id = c.order_id and o.org_id = public.my_org_id()))) then
    raise exception 'not_found';
  end if;
  if c.escalated_by = 'customer' and c.state = 'escalated' then raise exception 'already_escalated'; end if;
  update public.complaints
     set state = 'escalated', priority = 'high',
         escalated_at = now(), escalated_by = 'customer', resolved_at = null
   where id = c.id
  returning * into a;
  insert into public.complaint_escalations (complaint_id, by_user, by_role, from_state, reason) values (c.id, auth.uid(), r::text, c.state, why);
  insert into public.complaint_notes (complaint_id, author_id, author_role, body)
  values (c.id, auth.uid(), r::text, 'Escalated to Nama 1442' || coalesce(': ' || why, '.'));
  v := jsonb_build_object('case', 'C-' || c.case_no, 'category', coalesce((select label from public.complaint_sla where category = c.category), c.category),
                          'reason', coalesce(why, 'no reason given'), 'reason_ar', coalesce(why, 'لم يُذكر سبب'),
                          'due', to_char(c.due_at at time zone 'Asia/Muscat', 'DD/MM HH24:MI'));
  for u in select id from public.profiles where role = 'nws_staff' and staff_role = 'complaints_agent' order by id limit 50 loop
    perform public.notify(u.id, 'complaint_escalated', c.order_id, v);
    k := k + 1;
  end loop;
  if k = 0 then
    for u in select id from public.profiles where role = 'nws_staff' and staff_role = 'admin' order by id limit 20 loop
      perform public.notify(u.id, 'complaint_escalated', c.order_id, v);
    end loop;
  end if;
  return a;
end $$;

-- ===========================================================================
-- #35 — the refund message says where the money went (only if NWS hasn't reworded it)
-- ===========================================================================
update public.notification_templates
   set title_en = 'Refund in your Nama wallet',
       body_en  = '{amount} OMR for {order} is back in your Nama wallet, ready to use now. Prefer your card? Ask NWS within 30 days (1442 or a complaint in the app).',
       title_ar = 'تم الاسترداد إلى محفظتك في نماء',
       body_ar  = 'أُعيد مبلغ {amount} ر.ع. للطلب {order} إلى محفظتك في نماء، وهو متاح للاستخدام الآن. تفضّل البطاقة؟ اطلب ذلك من نماء خلال ٣٠ يوماً (1442 أو شكوى في التطبيق).'
 where event = 'refund_issued' and body_en = '{amount} OMR refunded for {order}.';

-- ===========================================================================
-- Execute rights
-- ===========================================================================
revoke execute on function public.escalate_complaint(uuid, text) from public, anon, authenticated;
grant execute on function public.escalate_complaint(uuid, text) to authenticated;
