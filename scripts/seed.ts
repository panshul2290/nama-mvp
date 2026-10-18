// Creates one test customer and one test driver (with a tanker). Safe to re-run.
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

async function ensureUser(u: (typeof USERS)[number]): Promise<string> {
  const meta = { role: u.role, full_name: u.full_name, phone: u.phone };
  let id = await findUserId(admin, u.email);
  if (id) {
    const { error } = await admin.auth.admin.updateUserById(id, { password, email_confirm: true, user_metadata: meta });
    if (error) throw error;
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: u.email, password, email_confirm: true, user_metadata: meta });
    if (error) throw error;
    id = data.user.id;
  }
  // The sign-up trigger creates the profile; upsert in case the user predates the migration.
  const { error } = await admin.from("profiles").upsert({ id, ...meta }, { onConflict: "id" });
  if (error) throw error;
  return id;
}

async function main() {
  await ensureUser(USERS[0]);
  const driverId = await ensureUser(USERS[1]);

  const { error } = await admin.from("tankers").upsert({ driver_id: driverId, ...TANKER, is_online: false }, { onConflict: "driver_id" });
  if (error) throw error;

  console.log("Seeded (password: SEED_PASSWORD in .env.local):");
  console.log(`  customer  ${USERS[0].email}`);
  console.log(`  driver    ${USERS[1].email}   tanker ${TANKER.plate} · ${TANKER.service_type} · ${TANKER.capacity_gal} gal`);
}

main().catch((e) => {
  console.error("Seed failed:", e.message ?? e);
  process.exit(1);
});
