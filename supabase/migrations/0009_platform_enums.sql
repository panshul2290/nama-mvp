-- New enum values for the full platform (0010+). Kept in their own migration:
-- Postgres can't use a value added by ALTER TYPE … ADD VALUE in the same
-- transaction that adds it.

-- Tanker company owners and B2B (business portal) users.
alter type public.user_role add value if not exists 'owner';
alter type public.user_role add value if not exists 'business';

-- Prototype "Users and roles": Super admin (admin), Control room operator
-- (operator), Permit officer, Inspector, Complaints agent, Finance, Read-only (BI).
alter type public.staff_role add value if not exists 'inspector';
alter type public.staff_role add value if not exists 'complaints_agent';
alter type public.staff_role add value if not exists 'finance';
alter type public.staff_role add value if not exists 'viewer';

-- scheduled: booked for a later slot, released to 'requested' shortly before it.
-- pending_approval: B2B order above the account's approval limit.
-- collected: wastewater collected at the customer, on its way to discharge.
alter type public.order_status add value if not exists 'scheduled' before 'requested';
alter type public.order_status add value if not exists 'pending_approval' before 'requested';
alter type public.order_status add value if not exists 'collected' after 'arrived';
