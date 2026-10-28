// Creates the demo accounts: customers, drivers (Salim gets his assigned,
// permitted tanker here; the rest of the fleet comes from `npm run seed:demo`),
// tanker company owners, business (B2B) users and NWS staff for every role.
// Safe to re-run.
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
  // More households for realistic history.
  { email: "customer2@nama.test", role: "customer", full_name: "Rashid Al Maskari", phone: "+968 9233 1180" },
  { email: "customer3@nama.test", role: "customer", full_name: "Maryam Al Farsi", phone: "+968 9677 2041" },
  { email: "customer4@nama.test", role: "customer", full_name: "Sultan Al Hosni", phone: "+968 9910 5523" },
  { email: "customer5@nama.test", role: "customer", full_name: "Noor Al Rashdi", phone: "+968 9340 7716" },
  { email: "customer6@nama.test", role: "customer", full_name: "Badr Al Saadi", phone: "+968 9822 3390" },
  { email: "customer7@nama.test", role: "customer", full_name: "Huda Al Mahrouqi", phone: "+968 9145 6604" },
  { email: "customer8@nama.test", role: "customer", full_name: "Talal Al Shukaili", phone: "+968 9701 8827" },
  // The rest of the fleet's drivers.
  { email: "driver2@nama.test", role: "driver", full_name: "Hamed Al Balushi", phone: "+968 9555 0231" },
  { email: "driver3@nama.test", role: "driver", full_name: "Yousuf Al Rawahi", phone: "+968 9555 0377" },
  { email: "driver4@nama.test", role: "driver", full_name: "Nasser Al Kindi", phone: "+968 9555 0418" },
  { email: "driver5@nama.test", role: "driver", full_name: "Khalid Al Siyabi", phone: "+968 9555 0590" },
  { email: "driver6@nama.test", role: "driver", full_name: "Said Al Amri", phone: "+968 9555 0626" },
  { email: "driver7@nama.test", role: "driver", full_name: "Ali Al Hinai", phone: "+968 9555 0784" },
  // Tanker company owners (Company portal).
  { email: "owner@nama.test", role: "owner", full_name: "Mohammed Al Harthy", phone: "+968 9900 1122" },
  { email: "owner2@nama.test", role: "owner", full_name: "Ahmed Al Busaidi", phone: "+968 9900 3344" },
  // Business portal (Al Noor Hotel): account admin, site manager, finance.
  { email: "business@nama.test", role: "business", full_name: "Aisha Al Zadjali", phone: "+968 2456 7700" },
  { email: "business-site@nama.test", role: "business", full_name: "Imran Qureshi", phone: "+968 2456 7711" },
  { email: "business-finance@nama.test", role: "business", full_name: "Laila Al Jabri", phone: "+968 2456 7722" },
] as const;

// NWS staff. Sign-up can never create staff; the seed (service role) or an admin assigns it.
const STAFF = [
  { email: "nws-admin@nama.test", staff_role: "admin", full_name: "Salma Al Kharusi" },
  { email: "nws-operator@nama.test", staff_role: "operator", full_name: "Zahir Al Wahaibi" },
  { email: "nws-permits@nama.test", staff_role: "permit_officer", full_name: "Asma Al Toobi" },
  { email: "nws-inspector@nama.test", staff_role: "inspector", full_name: "Hilal Al Sinani" },
  { email: "nws-complaints@nama.test", staff_role: "complaints_agent", full_name: "Rahma Al Mamari" },
  { email: "nws-finance@nama.test", staff_role: "finance", full_name: "Waleed Al Lamki" },
  { email: "nws-viewer@nama.test", staff_role: "viewer", full_name: "BI Read-only" },
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
  const ids: Record<string, string> = {};
  for (const u of USERS) ids[u.email] = await ensureUser(u);
  const driverId = ids["driver@nama.test"];
  const staffIds: Record<string, string> = {};
  for (const s of STAFF) staffIds[s.staff_role] = await ensureStaff(s);

  const tankerId = await ensureTanker(driverId);
  const { error } = await admin.from("tankers").update({ is_online: false }).eq("id", tankerId);
  if (error) throw error;
  const permit = await ensurePermit(tankerId, staffIds.permit_officer);

  console.log("Seeded (password for every account: SEED_PASSWORD in .env.local):");
  for (const u of USERS) console.log(`  ${u.role.padEnd(15)} ${u.email}${u.email === "driver@nama.test" ? `   tanker ${TANKER.plate} · ${TANKER.service_type} · ${TANKER.capacity_gal} gal · permit ${permit}` : ""}`);
  for (const s of STAFF) console.log(`  ${s.staff_role.padEnd(15)} ${s.email}`);
}

main().catch((e) => {
  console.error("Seed failed:", e.message ?? e);
  process.exit(1);
});
