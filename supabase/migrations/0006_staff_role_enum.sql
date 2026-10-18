-- NWS staff role. On its own migration because a new enum value can't be used
-- in the same transaction that adds it (0008 uses it).
alter type public.user_role add value if not exists 'nws_staff';
