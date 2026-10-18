// Creates the test customer, driver (with an assigned, permitted tanker) and the
// three NWS staff accounts (admin, operator, permit officer). Safe to re-run.
//   npm run seed
// This is the only code that uses the service-role key. It runs locally in
// Node and is never bundled into the Next.js app.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
// No default: the seeded accounts' password must come from .env.local and is never printed.
const password = process.env.SEED_PASSWORD;

if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.");
  process.exit(1);
}
if (!password) {
  console.error("Set SEED_PASSWORD in .env.local (the password for both seeded accounts). There is no default.");
  process.exit(1);
}
if (password.length < 12) {
  console.error("SEED_PASSWORD must be at least 12 characters.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const USERS = [
  { email: "customer@nama.test", role: "customer", full_name: "Fatma Al Lawati", phone: "+968 9124 4512" },
  { email: "driver@nama.test", role: "driver", full_name: "Salim Al Habsi", phone: "+968 9555 0142" },
] as const;

// NWS staff. Sign-up can never create staff; the seed (service role) or an admin assigns it.
const STAFF = [
  { email: "nws-admin@nama.test", staff_role: "admin", full_name: "NWS Admin" },
  { email: "nws-operator@nama.test", staff_role: "operator", full_name: "NWS Operator" },
  { email: "nws-permits@nama.test", staff_role: "permit_officer", full_name: "NWS Permit Officer" },
] as const;

const TANKER = { plate: "4521 TK", service_type: "DW", capacity_gal: 5000 } as const;

async function findUserId(db: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
}

async function ensureAuthUser(email: string, meta: Record<string, string>): Promise<string> {
  const id = await findUserId(admin, email);
  if (id) {
    const { error } = await admin.auth.admin.updateUserById(id, { password, email_confirm: true, user_metadata: meta });
    if (error) throw error;
    return id;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: meta });
  if (error) throw error;
  return data.user.id;
}

async function ensureUser(u: (typeof USERS)[number]): Promise<string> {
  const meta = { role: u.role, full_name: u.full_name, phone: u.phone };
  const id = await ensureAuthUser(u.email, meta);
  // The sign-up trigger creates the profile; upsert in case the user predates the migration.
  const { error } = await admin.from("profiles").upsert({ id, ...meta }, { onConflict: "id" });
  if (error) throw error;
  return id;
}

async function ensureStaff(u: (typeof STAFF)[number]): Promise<string> {
  // Created as a customer by the sign-up trigger, then promoted here (service role).
  const id = await ensureAuthUser(u.email, { role: "customer", full_name: u.full_name });
  const { error } = await admin.from("profiles").upsert({ id, role: "nws_staff", staff_role: u.staff_role, full_name: u.full_name }, { onConflict: "id" });
  if (error) throw error;
  return id;
}

/** The driver's tanker: their current assignment, else the existing plate, else a new tanker; assigned to them. */
async function ensureTanker(driverId: string): Promise<string> {
  const { data: current, error: e1 } = await admin.from("tanker_assignments").select("tanker_id").eq("driver_id", driverId).is("unassigned_at", null).maybeSingle();
  if (e1) throw e1;
  if (current) return current.tanker_id as string;
  const { data: byPlate, error: e2 } = await admin.from("tankers").select("id").eq("plate", TANKER.plate).maybeSingle();
  if (e2) throw e2;
  let tankerId = byPlate?.id as string | undefined;
  if (!tankerId) {
    const { data, error } = await admin.from("tankers").insert({ ...TANKER, is_online: false }).select("id").single();
    if (error) throw error;
    tankerId = data.id as string;
  }
  const { error } = await admin.from("tanker_assignments").insert({ driver_id: driverId, tanker_id: tankerId, assigned_by: driverId });
  if (error) throw error;
  return tankerId;
}

/** An approved DW permit valid for 12 months, so the existing driver flow keeps working. */
async function ensurePermit(tankerId: string, reviewerId: string) {
  const { data: valid, error: e1 } = await admin
    .from("permits")
    .select("id")
    .eq("tanker_id", tankerId)
    .eq("status", "approved")
    .eq("type", TANKER.service_type)
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  if (e1) throw e1;
  if (valid?.length) return "kept existing approved permit";
  const now = new Date();
  const expires = new Date(now);
  expires.setFullYear(now.getFullYear() + 1);
  const { error } = await admin.from("permits").insert({
    tanker_id: tankerId,
    permit_no: `NWS-DW-${now.getFullYear()}-SEED-${tankerId.slice(0, 6).toUpperCase()}`,
    type: TANKER.service_type,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: "approved",
    reviewed_by: reviewerId,
    reviewed_at: now.toISOString(),
    created_by: reviewerId,
    reason: "Seeded test permit",
  });
  if (error) throw error;
  return `approved until ${expires.toISOString().slice(0, 10)}`;
}

async function main() {
  await ensureUser(USERS[0]);
  const driverId = await ensureUser(USERS[1]);
  const staffIds: Record<string, string> = {};
  for (const s of STAFF) staffIds[s.staff_role] = await ensureStaff(s);

  const tankerId = await ensureTanker(driverId);
  const { error } = await admin.from("tankers").update({ is_online: false }).eq("id", tankerId);
  if (error) throw error;
  const permit = await ensurePermit(tankerId, staffIds.permit_officer);

  console.log("Seeded (password for every account: SEED_PASSWORD in .env.local):");
  console.log(`  customer        ${USERS[0].email}`);
  console.log(`  driver          ${USERS[1].email}   tanker ${TANKER.plate} · ${TANKER.service_type} · ${TANKER.capacity_gal} gal · permit ${permit}`);
  for (const s of STAFF) console.log(`  ${s.staff_role.padEnd(15)} ${s.email}`);
}

main().catch((e) => {
  console.error("Seed failed:", e.message ?? e);
  process.exit(1);
});
