-- Customer ↔ driver conversation on an order: read receipts, unread counts and a
-- notification to the other party for each new message (NWS messages reach both).

alter table public.order_messages add column read_at timestamptz;

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp) values
  ('new_message', 'New chat message', 'customer', 'Message about {order}', '{sender}: {text}', 'رسالة بخصوص {order}', '{sender_ar}: {text}', true, false, false)
on conflict (event) do nothing;

create function public.order_messages_notify()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare o public.orders; v jsonb;
begin
  select * into o from public.orders where id = new.order_id;
  v := jsonb_build_object('order', 'TO-' || o.order_no, 'text', left(new.body, 120),
                          'sender', case new.sender_role when 'driver' then coalesce(o.driver_name, 'Your driver') when 'customer' then 'Customer' else 'NWS' end,
                          'sender_ar', case new.sender_role when 'driver' then coalesce(o.driver_name, 'السائق') when 'customer' then 'العميل' else 'نماء' end);
  if new.sender_role <> 'customer' then perform public.notify(o.customer_id, 'new_message', o.id, v); end if;
  if new.sender_role <> 'driver' and o.driver_id is not null then perform public.notify(o.driver_id, 'new_message', o.id, v); end if;
  return new;
end $$;
create trigger order_messages_notify after insert on public.order_messages for each row execute function public.order_messages_notify();
revoke execute on function public.order_messages_notify() from public, anon, authenticated;

-- Mark the other side's messages on an order as read (customer, assigned driver, or staff).
create function public.mark_order_messages_read(p_order_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare o public.orders; who text; n integer;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'not_found'; end if;
  if o.customer_id = auth.uid() then who := 'customer';
  elsif o.driver_id = auth.uid() then who := 'driver';
  elsif public.is_staff() then who := 'staff';
  else raise exception 'not_found'; end if;
  update public.order_messages set read_at = now() where order_id = o.id and read_at is null and sender_role <> who;
  get diagnostics n = row_count;
  update public.notifications set read_at = now() where user_id = auth.uid() and order_id = o.id and event = 'new_message' and read_at is null;
  return n;
end $$;
revoke execute on function public.mark_order_messages_read(uuid) from public, anon;
grant execute on function public.mark_order_messages_read(uuid) to authenticated;
