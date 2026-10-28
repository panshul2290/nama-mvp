-- Reference data for the platform. Values marked "Assumption" in the UI are
-- placeholders pending NWS confirmation; staff can change them from Settings.

insert into public.zones (name, governorate, center_lat, center_lng, radius_km, active) values
  ('Muscat & Muttrah', 'Muscat',         23.6150, 58.5650,  9, true),
  ('Bawshar',          'Muscat',         23.5800, 58.3950,  9, true),
  ('Seeb',             'Muscat',         23.6700, 58.1600, 16, true),
  ('Al Amerat',        'Muscat',         23.5200, 58.5000, 11, true),
  ('Quriyat',          'Muscat',         23.2600, 58.9200, 12, false),
  ('Sohar',            'North Al Batinah', 24.3500, 56.7300, 16, true),
  ('Nizwa',            'Ad Dakhiliyah',  22.9300, 57.5300, 13, true),
  ('Salalah',          'Dhofar',         17.0200, 54.0900, 20, true)
on conflict (name) do nothing;

insert into public.sites (code, kind, name, service_types, lat, lng, radius_m, operator) values
  ('FS-GHB', 'fill',      'Al Ghubrah filling station', '{DW}',    23.6030, 58.3870, 350, 'NWS'),
  ('FS-MSF', 'fill',      'Misfah filling station',     '{DW}',    23.5310, 58.3010, 300, 'NWS'),
  ('FS-SEB', 'fill',      'Seeb filling station',       '{DW}',    23.6620, 58.1730, 300, 'NWS'),
  ('FS-AMR', 'fill',      'Al Amerat filling station',  '{DW}',    23.5150, 58.4880, 300, 'NWS'),
  ('TE-ANS', 'fill',      'Al Ansab STP — TE outlet',   '{TE}',    23.5640, 58.3330, 300, 'NWS'),
  ('ST-ANS', 'discharge', 'Al Ansab STP',               '{WW}',    23.5655, 58.3360, 300, 'NWS'),
  ('ST-SEB', 'discharge', 'Seeb STP',                   '{WW}',    23.6820, 58.1900, 300, 'NWS'),
  ('ST-DRS', 'discharge', 'Darsait STP',                '{WW}',    23.6120, 58.5520, 250, 'NWS')
on conflict (code) do nothing;

insert into public.complaint_sla (category, label, hours, team) values
  ('late_delivery',     'Late delivery',     24, 'Tanker operations'),
  ('incomplete_volume', 'Incomplete volume', 48, 'Tanker operations'),
  ('water_quality',     'Water quality',     12, 'Water quality lab'),
  ('driver_conduct',    'Driver conduct',    72, 'Fleet compliance'),
  ('overcharging',      'Overcharging',      48, 'Billing'),
  ('spillage',          'Spillage',          24, 'Environment and safety')
on conflict (category) do nothing;

insert into public.penalty_rules (code, label, party, amount, amount_kind, compensation) values
  ('late_delivery',        'Late delivery (> 30 min past slot)',         'driver',   5,   'omr', 'Customer''s delivery fee refunded'),
  ('driver_cancel',        'Driver cancels after accepting',             'driver',   3,   'omr', 'Order re-dispatched with priority'),
  ('short_volume',         'Short volume (> 5% under ordered)',          'driver',   10,  'omr', 'Short volume refunded to the customer'),
  ('discharge_outside',    'Discharge outside approved geofence',        'driver',   500, 'omr', 'Referred to Environment Authority'),
  ('expired_permit_trip',  'Trip with an expired permit',                'driver',   250, 'omr', 'Tanker suspended until renewal'),
  ('customer_late_cancel', 'Customer cancels after tanker assigned',     'customer', 1,   'omr', 'Paid to the tanker company'),
  ('b2b_overdue',          'Business invoice overdue',                   'business', 2,   'pct', 'Per month on the overdue amount')
on conflict (code) do nothing;

insert into public.notification_templates (event, label, audience, title_en, body_en, title_ar, body_ar, push, sms, whatsapp) values
  ('order_confirmed',    'Order confirmed',             'customer', 'Order {order} confirmed', 'We''re finding a permitted tanker for you. Total {total} OMR.', 'تم تأكيد الطلب {order}', 'نبحث لك عن صهريج مرخّص. المجموع {total} ر.ع.', true, true, false),
  ('order_scheduled',    'Order scheduled',             'customer', 'Order {order} scheduled', 'Your delivery is booked for {slot}.', 'تمت جدولة الطلب {order}', 'تم حجز التوصيل في {slot}.', true, false, false),
  ('tanker_assigned',    'Tanker assigned',             'customer', 'Tanker assigned', '{driver} is on the way in {plate} for {order}.', 'تم تعيين صهريج', '{driver} في الطريق بالصهريج {plate} للطلب {order}.', true, true, true),
  ('driver_delayed',     'Driver delayed',              'customer', 'Your tanker is delayed', '{order} is running late. We''ll keep you posted.', 'تأخر الصهريج', 'الطلب {order} متأخر. سنبقيك على اطلاع.', true, true, false),
  ('arrived',            'Tanker arrived',              'customer', 'Tanker at your gate', '{plate} has arrived for {order}.', 'وصل الصهريج', 'وصل الصهريج {plate} للطلب {order}.', true, false, false),
  ('delivered',          'Delivered with proof',        'customer', 'Delivered', '{order} delivered. Proof of delivery is in the app. Rate your driver.', 'تم التوصيل', 'تم توصيل {order}. إثبات التسليم في التطبيق. قيّم السائق.', true, true, true),
  ('collected',          'Wastewater collected',        'customer', 'Collected', '{order} collected. The tanker is heading to the treatment plant.', 'تم الجمع', 'تم جمع {order}. الصهريج متجه إلى محطة المعالجة.', true, false, false),
  ('discharged',         'Discharged at plant',         'customer', 'Job complete', '{order} was discharged at an approved plant.', 'اكتملت المهمة', 'تم تفريغ {order} في محطة معتمدة.', true, false, false),
  ('order_cancelled',    'Order cancelled',             'customer', 'Order {order} cancelled', 'Your order was cancelled. {reason}', 'تم إلغاء الطلب {order}', 'تم إلغاء طلبك. {reason}', true, true, false),
  ('driver_reassigning', 'Finding another tanker',      'customer', 'Finding another tanker', 'Your tanker had a problem. We''re assigning a new one for {order}.', 'نبحث عن صهريج آخر', 'واجه الصهريج مشكلة. نعيّن صهريجاً جديداً للطلب {order}.', true, true, false),
  ('payment_failed',     'Payment failed',              'customer', 'Payment failed', 'We couldn''t take payment for {order}. Try another card or your wallet.', 'فشل الدفع', 'تعذّر الدفع للطلب {order}. جرّب بطاقة أخرى أو المحفظة.', true, true, false),
  ('refund_issued',      'Refund issued',               'customer', 'Refund sent to your wallet', '{amount} OMR refunded for {order}.', 'تم استرداد المبلغ', 'تم إرجاع {amount} ر.ع. إلى محفظتك للطلب {order}.', true, false, false),
  ('refill_reminder',    'Refill reminder',             'customer', 'Time to refill?', 'Based on your usage, your tank may be running low.', 'حان وقت التعبئة؟', 'بناءً على استهلاكك، قد يكون خزانك منخفضاً.', true, false, true),
  ('complaint_update',   'Complaint update',            'customer', 'Complaint {case}', 'Your complaint {case} is {status}.', 'الشكوى {case}', 'حالة شكواك {case}: {status}.', true, true, false),
  ('contract_update',    'Contract update',             'customer', 'Contract {contract}', 'Your contract {contract} was {status}.', 'العقد {contract}', 'تم {status} عقدك {contract}.', true, false, false),
  ('job_assigned',       'Job assigned by control room','driver',   'New job assigned', 'NWS control assigned you {order} in {area}.', 'مهمة جديدة', 'عيّنت غرفة التحكم لك الطلب {order} في {area}.', true, true, false),
  ('penalty_issued',     'Penalty issued',              'driver',   'Penalty issued', '{reason}: {amount} OMR. You can dispute it in the app.', 'مخالفة', '{reason}: {amount} ر.ع. يمكنك الاعتراض في التطبيق.', true, true, false),
  ('payout_sent',        'Payout sent',                 'owner',    'Payout sent', '{amount} OMR paid to your bank ({batch}).', 'تم التحويل', 'تم تحويل {amount} ر.ع. إلى حسابك ({batch}).', true, true, false),
  ('permit_expiring',    'Permit expiring',             'owner',    'Permit expiring', 'Permit for {plate} expires on {date}. Apply for renewal.', 'ترخيص قارب على الانتهاء', 'ينتهي ترخيص {plate} في {date}. قدّم طلب التجديد.', true, true, false),
  ('contract_offer',     'Contract offer',              'owner',    'New contract offer', 'Contract {contract} in {area} is waiting for your decision.', 'عرض عقد جديد', 'العقد {contract} في {area} بانتظار قرارك.', true, false, false),
  ('approval_needed',    'Order needs approval',        'business', 'Approval needed', '{order} ({total} OMR) is above your approval limit.', 'مطلوب موافقة', 'الطلب {order} ({total} ر.ع.) يتجاوز حد الموافقة.', true, false, false),
  ('invoice_issued',     'Invoice issued',              'business', 'Invoice {invoice}', 'Invoice {invoice} for {amount} OMR is ready.', 'فاتورة {invoice}', 'الفاتورة {invoice} بقيمة {amount} ر.ع. جاهزة.', true, false, false)
on conflict (event) do nothing;

insert into public.incident_targets (priority, label, response_min, resolve_min) values
  ('P1', 'Critical — service down',    15,  240),
  ('P2', 'High — major degradation',   30,  480),
  ('P3', 'Medium — partial impact',   120, 1440),
  ('P4', 'Low — minor / cosmetic',    480, 4320)
on conflict (priority) do nothing;

insert into public.integrations (key, name, purpose, status, note) values
  ('ivms',     'IVMS telematics',          'GPS, valve, flow-meter and door sensors on every tanker', 'simulated', 'Simulated — IVMS interface spec pending'),
  ('tas',      'TAS (tanker authorisation)', 'Permit and owner records',                          'simulated', 'Simulated — interface spec pending'),
  ('tfs',      'TFS (filling stations)',   'Station meter readings and filling credit',            'simulated', 'Simulated — interface spec pending'),
  ('payments', 'Payment gateway',          'Cards, OmanNet, wallet top-ups, refunds',              'simulated', 'Simulated — card ending 0002 is always declined'),
  ('rop',      'ROP vehicle records',      'Plate, chassis and owner checks for permits',          'warn',      'Simulated — checks slower than 5 s in peak hours'),
  ('genesys',  'Genesys call centre',      'Screen pop, call-centre orders and cases',             'simulated', 'Simulated — queues NWS_Tanker_EN / NWS_Tanker_AR'),
  ('sms',      'SMS gateway',              'Order and permit notifications',                       'simulated', 'Simulated — messages are logged, not sent'),
  ('whatsapp', 'WhatsApp Business',        'Delivery confirmations and refill reminders',          'simulated', 'Simulated — messages are logged, not sent'),
  ('lims',     'Water-quality LIMS',       'Tanker water-test certificates',                       'simulated', 'Simulated — seeded certificates'),
  ('bi',       'BI warehouse',             'Nightly extracts for reporting',                       'simulated', 'Simulated — CSV export from Reports'),
  ('sso',      'NWS single sign-on',       'Staff sign-in with Active Directory',                  'simulated', 'Simulated — password sign-in'),
  ('osrm',     'Routing (OSRM)',           'Road routes and ETAs',                                 'ok',        'Public demo server; self-host for production')
on conflict (key) do nothing;

insert into public.promotions (code, label, pct, audience, max_uses, active, valid_to) values
  ('WELCOME10', '10% off your first delivery fee', 0.10, 'new', 5000, true, null),
  ('SUMMER5',   '5% off delivery fees this summer', 0.05, 'all', 20000, true, null),
  ('EID20',     'Eid special — 20% off delivery',   0.20, 'household', 2000, false, null)
on conflict (code) do nothing;

-- Pricing rule notes now that slots, emergency, plans and late cancellation are live.
update public.pricing_rules set notes = 'Evening peak (6–8 pm) multiplier on the delivery fee.' where rule_key = 'peak_multiplier';
update public.pricing_rules set notes = 'Emergency request multiplier on the delivery fee.' where rule_key = 'priority_multiplier';
update public.pricing_rules set notes = 'Monthly contract discount on the delivery fee (fraction).' where rule_key = 'discount_monthly';
update public.pricing_rules set notes = 'Yearly contract discount on the delivery fee (fraction).' where rule_key = 'discount_yearly';
update public.pricing_rules set notes = 'Cancellation fee once a tanker is assigned (OMR); paid to the tanker company.' where rule_key = 'cancel_fee_omr';

-- Storage for proof-of-delivery photos, complaint photos and documents (Supabase only).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('evidence', 'evidence', false) on conflict (id) do nothing;
    -- Signed-in users upload into a folder named after their user id; reads are open to signed-in users
    -- who know the path (paths are unguessable UUIDs and are only shown through RLS-protected rows).
    execute $p$create policy evidence_upload on storage.objects for insert to authenticated with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute $p$create policy evidence_read on storage.objects for select to authenticated using (bucket_id = 'evidence')$p$;
    -- Retaking a photo overwrites your own upload.
    execute $p$create policy evidence_update on storage.objects for update to authenticated using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  end if;
end $$;
