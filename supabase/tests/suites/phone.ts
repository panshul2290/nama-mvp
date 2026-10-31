// Mobile-number identity (0019): phone normalisation, the Send SMS hook and its
// outbox, the demo code RPC, and invitations by mobile number — matched only on
// a verified phone, with consent, expiry and tenant isolation.
import type { Reporter, Target } from "../lib/harness";
import { giveTanker, plateFor } from "../lib/world";
import { PHONE_CASES } from "../../../tests/unit/phone-cases";

type Row = Record<string, unknown>;

export async function phoneSuite(t: Target, r: Reporter) {
  r.start("PHONE mobile identity, SMS hook and invitations by phone");

  // ---- normalisation: the server agrees with lib/phone.ts ---------------------------
  const got = await t.admin<{ i: string; o: string | null }>(
    "select x.i, public.normalize_phone(x.i) as o from unnest($1::text[]) as x(i)",
    [PHONE_CASES.map(([i]) => i)],
  );
  const wrong = got.filter((g, n) => g.o !== PHONE_CASES[n][1]);
  r.check(`normalize_phone() matches lib/phone.ts on ${PHONE_CASES.length} cases`, wrong.length === 0, wrong);

  // ---- the hook and the outbox: access control ------------------------------------
  const [priv] = await t.admin<Record<string, boolean>>(
    `select has_function_privilege('supabase_auth_admin', 'public.send_sms_hook(jsonb)', 'execute') as auth_admin,
            has_function_privilege('authenticated', 'public.send_sms_hook(jsonb)', 'execute') as authed,
            has_function_privilege('anon', 'public.send_sms_hook(jsonb)', 'execute') as anon,
            has_table_privilege('authenticated', 'public.sms_outbox', 'select') as authed_read,
            has_table_privilege('anon', 'public.sms_outbox', 'select') as anon_read,
            has_table_privilege('authenticated', 'public.sms_outbox', 'insert') as authed_write`,
  );
  r.check("only supabase_auth_admin may run send_sms_hook (not anon, not signed-in users)", priv.auth_admin && !priv.authed && !priv.anon, priv);
  r.check("no client role can read or write sms_outbox", !priv.authed_read && !priv.anon_read && !priv.authed_write, priv);

  if (!t.fresh) {
    r.skip("SMS hook, demo codes and phone invitations", "need phone-only auth users and a settings change; run on the fresh PGlite build");
    return;
  }

  const C = await t.createUser("ph-c", { role: "customer", full_name: "Test Phone Customer" });
  await r.denies("a signed-in user can't read sms_outbox", () => t.as(C.id, "select * from sms_outbox"), "permission denied");
  await r.denies("anon can't read sms_outbox", () => t.as(null, "select * from sms_outbox"), "permission denied");
  await r.denies("a signed-in user can't call send_sms_hook to plant a code", () => t.as(C.id, "select send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890009999" }, sms: { otp: "000000" } })]), "permission denied");

  const asAuthAdmin = (event: unknown) =>
    t.adminRollback(async (q) => {
      await q("set local role supabase_auth_admin");
      const [res] = await q<{ r: Row }>("select public.send_sms_hook($1::jsonb) as r", [JSON.stringify(event)]);
      await q("reset role");
      const rows = await q<Row>("select phone, otp, kind from sms_outbox where otp = $1", [(event as { sms?: { otp?: string } }).sms?.otp ?? ""]);
      return { res: res.r, rows };
    });
  const ok = await asAuthAdmin({ user: { id: C.id, phone: "96890001234", phone_confirmed_at: null }, sms: { otp: "482913" } });
  r.check("as supabase_auth_admin the hook returns {} and queues the code for +96890001234 (sign-up)",
    JSON.stringify(ok.res) === "{}" && ok.rows.length === 1 && ok.rows[0].phone === "+96890001234" && ok.rows[0].kind === "verify_phone", ok);
  const later = await asAuthAdmin({ user: { phone: "96890001234", phone_confirmed_at: "2026-01-01T00:00:00Z" }, sms: { otp: "771100" } });
  r.check("a code for a verified number is queued as sign_in (code sign-in / password reset)", later.rows[0]?.kind === "sign_in", later);
  const bad = await asAuthAdmin({ user: { phone: "96890001234" }, sms: {} });
  r.check("an event without an OTP returns an error object (Supabase Auth reports it)", (bad.res as { error?: { http_code?: number } }).error?.http_code === 400 && bad.rows.length === 0, bad);

  // ---- demo code RPC: only when DEMO_SMS_CODES is on --------------------------------
  await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890005555" }, sms: { otp: "111111" } })]);
  await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890005555" }, sms: { otp: "222222" } })]);
  const [setting] = await t.admin<{ value: string }>("select value from app_settings where key = 'DEMO_SMS_CODES'");
  r.check("DEMO_SMS_CODES defaults to off", setting?.value === "off", setting);
  const demo = async (uid: string | null, phone: string) => (await t.as<{ c: string | null }>(uid, "select demo_sms_code($1) as c", [phone]))[0].c;
  r.check("with DEMO_SMS_CODES off, demo_sms_code returns nothing (anon and signed in)", (await demo(null, "9000 5555")) === null && (await demo(C.id, "+96890005555")) === null);
  await r.denies("app_settings rejects a DEMO_SMS_CODES value other than on/off", () => t.admin("update app_settings set value = 'yes' where key = 'DEMO_SMS_CODES'"), "app_settings_demo_sms_codes");
  await t.admin("update app_settings set value = 'on' where key = 'DEMO_SMS_CODES'");
  try {
    r.check("with DEMO_SMS_CODES on, anon gets the latest code for the number, in any format", (await demo(null, "9000 5555")) === "222222" && (await demo(null, "+968 9000 5555")) === "222222");
    await t.admin("update sms_outbox set created_at = now() - interval '11 minutes' where phone = '+96890005555'");
    r.check("codes older than 10 minutes are not returned", (await demo(null, "90005555")) === null);
    r.check("an invalid number returns nothing", (await demo(null, "abc")) === null);
  } finally {
    await t.admin("update app_settings set value = 'off' where key = 'DEMO_SMS_CODES'");
  }
  await t.admin("update sms_outbox set created_at = now() - interval '2 days' where phone = '+96890005555'");
  await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890006666" }, sms: { otp: "333333" } })]);
  const [pruned] = await t.admin<{ n: number }>("select count(*)::int as n from sms_outbox where phone = '+96890005555'");
  r.check("the hook prunes codes older than a day", pruned.n === 0, pruned);

  // ---- phone-only accounts ------------------------------------------------------------
  const phoneUser = async (phone: string, role: string, name: string, opts: { confirmed?: boolean; contactEmail?: string } = {}) => {
    const [u] = await t.admin<{ id: string }>(
      "insert into auth.users (email, email_confirmed_at, phone, phone_confirmed_at, raw_user_meta_data) values (null, null, $1, $2, $3) returning id",
      [phone, opts.confirmed === false ? null : new Date().toISOString(), JSON.stringify({ role, full_name: name, phone: `+${phone}`, contact_email: opts.contactEmail })],
    );
    return u.id;
  };
  const DP = await phoneUser("96890001111", "driver", "Test Phone Driver", { contactEmail: "Phone.Driver@Example.com" });
  const [dpp] = await t.admin<{ role: string; phone: string; email: string | null }>("select role, phone, email from profiles where id = $1", [DP]);
  r.check("a phone sign-up gets a profile with role, E.164 phone and the optional email", dpp.role === "driver" && dpp.phone === "+96890001111" && dpp.email === "phone.driver@example.com", dpp);
  const [me] = await t.as<{ p: string | null; e: string | null; priv: { email: string } }>(DP, "select my_phone() as p, my_email() as e, my_private_profile() as priv");
  r.check("my_phone() is the verified number; my_email() is null (the profile email is unverified)", me.p === "+96890001111" && me.e === null && me.priv.email === "phone.driver@example.com", me);
  await r.denies("profile email must look like an email", () => t.as(DP, "update profiles set email = 'not-an-email' where id = auth.uid()"), "check constraint");
  await t.as(DP, "update profiles set email = 'new@example.com' where id = auth.uid()");
  r.check("the person can change their own profile email", (await t.as<{ priv: { email: string } }>(DP, "select my_private_profile() as priv"))[0].priv.email === "new@example.com");
  await r.denies("another user can't read the private email column", () => t.as(C.id, "select email from profiles"), "permission denied");

  // ---- 0046: demo codes only for new numbers, demo accounts and named testers ------------
  await t.admin("update app_settings set value = 'on' where key = 'DEMO_SMS_CODES'");
  try {
    await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890001111" }, sms: { otp: "909090" } })]);
    r.check("demo mode never shows the code of a real (non-demo) account to anyone", (await demo(null, "90001111")) === null && (await demo(C.id, "+96890001111")) === null);
    await t.admin("update app_settings set value = ' +968 9000 1111 ,99999999' where key = 'DEMO_SMS_ALLOWLIST'");
    r.check("a number on DEMO_SMS_ALLOWLIST shows its code", (await demo(null, "90001111")) === "909090");
    await t.admin("update app_settings set value = '' where key = 'DEMO_SMS_ALLOWLIST'");
    await t.admin("select public.send_sms_hook($1::jsonb)", [JSON.stringify({ user: { phone: "96890004321" }, sms: { otp: "434343" } })]);
    r.check("a number with no account (sign-up) still shows its code", (await demo(null, "90004321")) === "434343");
  } finally {
    await t.admin("update app_settings set value = 'off' where key = 'DEMO_SMS_CODES'");
    await t.admin("update app_settings set value = '' where key = 'DEMO_SMS_ALLOWLIST'");
  }

  // Two companies, each with an owner.
  const company = async (label: string) => {
    const [co] = await t.admin<{ id: string }>("insert into companies (name, cr_no) values ($1, $2) returning id", [`TST ${label}`, `TSTPH${label}`]);
    const ow = await t.createUser(`ph-${label.toLowerCase()}`, { role: "owner" as never, full_name: `Test Owner ${label}` });
    await t.admin("update profiles set company_id = $1 where id = $2", [co.id, ow.id]);
    return { co: co.id, ow: ow.id };
  };
  const A = await company("A");
  const B = await company("B");
  const one = async <T = Row>(uid: string, sql: string, params: unknown[] = []) => (await t.as<T>(uid, sql, params))[0];
  const visible = async (uid: string, id: unknown) => (await t.as(uid, "select 1 from invitations where id = $1", [id])).length === 1;
  const companyOf = async (uid: string) => (await t.admin<{ c: string | null }>("select company_id as c from profiles where id = $1", [uid]))[0].c;

  const tk = await giveTanker(t, DP, plateFor(t, "PHDP"), "DW", 3000);
  const inv = await one<Row>(A.ow, "select * from owner_add_driver($1)", ["+968 9000 1111"]);
  r.check("an owner invites a driver by mobile number (stored E.164, no email)", inv.phone === "+96890001111" && inv.email === null && inv.status === "pending", inv);
  r.check("inviting changes nothing: the driver and their tanker stay unaffiliated",
    (await companyOf(DP)) === null && (await t.admin<{ c: string | null }>("select company_id as c from tankers where id = $1", [tk]))[0].c === null);
  await r.denies("a second pending invitation to the same number → invitation_pending", () => one(A.ow, "select * from owner_add_driver($1)", ["90001111"]), "invitation_pending");
  await r.denies("a landline can't be invited → invalid_phone", () => one(A.ow, "select * from owner_add_driver($1)", ["2456 7700"]), "invalid_phone");
  await r.denies("a malformed email can't be invited → invalid_email", () => one(A.ow, "select * from owner_add_driver($1)", ["driver@nama"]), "invalid_email");
  await r.denies("a row with both a phone and an email is rejected", () => t.admin("insert into invitations (kind, company_id, email, phone) values ('driver', $1, 'x@example.com', '+96890001111')", [A.co]), "invitations_one_target");
  await r.denies("a row with neither is rejected", () => t.admin("insert into invitations (kind, company_id) values ('driver', $1)", [A.co]), "invitations_one_target");
  r.check("the invitee sees the invitation (verified phone)", await visible(DP, inv.id));
  r.check("another customer and the other company's owner don't", !(await visible(C.id, inv.id)) && !(await visible(B.ow, inv.id)));
  await r.denies("anon can't read invitations at all", () => t.as(null, "select 1 from invitations"), "permission denied");
  await r.denies("someone else can't accept it", () => one(C.id, "select * from respond_invitation($1, true)", [inv.id]), "not_found");
  await r.denies("the other company's owner can't revoke it", () => one(B.ow, "select revoke_invitation($1)", [inv.id]), "not_found");
  // Company B also invites the same driver; accepting A's makes B's impossible to accept.
  const invB = await one<Row>(B.ow, "select * from owner_add_driver($1)", ["0096890001111"]);
  r.check("each company may have its own pending invitation for the same number", invB.phone === "+96890001111");
  await one(DP, "select * from respond_invitation($1, true)", [inv.id]);
  r.check("on accept the driver joins company A, and their own tanker joins with them",
    (await companyOf(DP)) === A.co && (await t.admin<{ c: string }>("select company_id as c from tankers where id = $1", [tk]))[0].c === A.co);
  await r.denies("then accepting company B's invitation → driver_in_other_company", () => one(DP, "select * from respond_invitation($1, true)", [invB.id]), "driver_in_other_company");
  r.check("…and company B gained nothing", (await t.admin<{ c: string }>("select company_id as c from tankers where id = $1", [tk]))[0].c === A.co && (await companyOf(DP)) === A.co);

  // Unverified number: knowing it gives nothing until the person verifies it themselves.
  const DU = await phoneUser("96890002222", "driver", "Test Unverified Driver", { confirmed: false });
  const tkU = await giveTanker(t, DU, plateFor(t, "PHDU"), "DW", 3000);
  const invU = await one<Row>(A.ow, "select * from owner_add_driver($1)", ["9000 2222"]);
  r.check("an account whose number isn't verified can't see an invitation to it", !(await visible(DU, invU.id)) && (await one<{ p: string | null }>(DU, "select my_phone() as p")).p === null);
  await r.denies("…nor accept it", () => one(DU, "select * from respond_invitation($1, true)", [invU.id]), "not_found");
  r.check("…and its tanker doesn't move", (await t.admin<{ c: string | null }>("select company_id as c from tankers where id = $1", [tkU]))[0].c === null);
  await t.admin("update auth.users set phone_confirmed_at = now() where id = $1", [DU]);
  r.check("once verified, the invitation shows up and the profile phone is synced",
    (await visible(DU, invU.id)) && (await t.admin<{ phone: string }>("select phone from profiles where id = $1", [DU]))[0].phone === "+96890002222");
  const dec = await one<Row>(DU, "select * from respond_invitation($1, false)", [invU.id]);
  r.check("the driver can decline; nothing changes", dec.status === "declined" && (await companyOf(DU)) === null);

  // Expiry.
  const DE = await phoneUser("96890003333", "driver", "Test Late Driver");
  const invE = await one<Row>(A.ow, "select * from owner_add_driver($1)", ["+96890003333"]);
  await t.admin("update invitations set expires_at = now() - interval '1 minute' where id = $1", [invE.id]);
  await r.denies("an expired invitation can't be accepted → invitation_expired", () => one(DE, "select * from respond_invitation($1, true)", [invE.id]), "invitation_expired");
  r.check("…and the driver stays unaffiliated", (await companyOf(DE)) === null);

  // Email invitations still work, but only for a confirmed email.
  const DM = await t.createUser("ph-dm", { role: "driver", full_name: "Test Email Driver" });
  await t.admin("update auth.users set email_confirmed_at = null where id = $1", [DM.id]);
  const invM = await one<Row>(A.ow, "select * from owner_add_driver($1)", [DM.email.toUpperCase()]);
  r.check("an email invitation is stored lower-case", invM.email === DM.email && invM.phone === null, invM);
  r.check("an unconfirmed email doesn't match", !(await visible(DM.id, invM.id)));
  await t.admin("update auth.users set email_confirmed_at = now() where id = $1", [DM.id]);
  await one(DM.id, "select * from respond_invitation($1, true)", [invM.id]);
  r.check("a confirmed email matches and the driver joins", (await companyOf(DM.id)) === A.co);
  const inviteUnverifiedProfileEmail = await one<Row>(B.ow, "select * from owner_add_driver($1)", ["new@example.com"]);
  r.check("a self-declared profile email never matches an invitation", !(await visible(DP, inviteUnverifiedProfileEmail.id)));

  // Business accounts by phone.
  const BA = await phoneUser("96890004444", "business", "Test Phone Biz Admin");
  const BM = await phoneUser("96890004545", "business", "Test Phone Biz Member");
  const [org] = await t.admin<{ id: string }>("insert into organizations (name, cr_no) values ('TST Phone Org', 'TSTPHORG') returning id");
  await t.admin("update profiles set org_id = $1, org_role = 'admin' where id = $2", [org.id, BA]);
  await r.denies("a business admin can't invite their own number → cannot_change_own_role", () => one(BA, "select * from org_add_member($1, 'finance')", ["9000 4444"]), "cannot_change_own_role");
  const invO = await one<Row>(BA, "select * from org_add_member($1, 'finance')", ["9000 4545"]);
  r.check("the invitee can read the inviting organisation's name before joining", (await t.as(BM, "select name from organizations where id = $1", [org.id])).length === 1);
  await one(BM, "select * from respond_invitation($1, true)", [invO.id]);
  const [bm] = await t.admin<{ org_id: string; org_role: string }>("select org_id, org_role from profiles where id = $1", [BM]);
  r.check("a business user joins by phone with the invited role", bm.org_id === org.id && bm.org_role === "finance", bm);
  await r.denies("a driver can't take a business invitation addressed to them → user_not_found", async () => {
    const i = await one<Row>(BA, "select * from org_add_member($1, 'finance')", ["+96890003333"]);
    return one(DE, "select * from respond_invitation($1, true)", [i.id]);
  }, "user_not_found");
}
