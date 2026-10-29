// Test harness shared by the PGlite and Supabase runs.
//
// A Target runs SQL as a given role/user exactly the way PostgREST does:
// inside a transaction with `SET LOCAL ROLE` and the JWT `sub` claim set, so
// auth.uid() and RLS behave as in production.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

export type Uid = string | null; // null = anon

export interface Session {
  /** Run one statement as uid inside its own transaction on this session's connection. */
  as<T = Record<string, unknown>>(uid: Uid, sql: string, params?: unknown[]): Promise<T[]>;
  /** Same, but the caller controls when the transaction commits (for barrier tests). */
  begin(uid: Uid): Promise<{ query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; commit(): Promise<void>; rollback(): Promise<void> }>;
  close(): Promise<void>;
}

export interface Target {
  name: "pglite" | "supabase";
  /** Fresh database built from the migrations (PGlite) vs. a live project (Supabase). */
  fresh: boolean;
  /** True when sessions are separate Postgres backends that really run in parallel. */
  parallel: boolean;
  runId: string;
  as: Session["as"];
  /** Privileged SQL (superuser on PGlite, the postgres role on Supabase). Only ever aimed at test rows. */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Privileged SQL inside a transaction that is always rolled back. */
  adminRollback<T>(fn: (q: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T>;
  /** Create a test-prefixed user; the sign-up trigger creates the profile. */
  createUser(label: string, meta: { role: "customer" | "driver"; full_name: string; phone?: string }): Promise<{ id: string; email: string; password: string }>;
  /** Independent connection(s) for concurrency tests. */
  session(): Promise<Session>;
  /** Supabase only: a supabase-js client signed in as a test user, for API-level checks. */
  apiClientFor?(email: string, password: string): Promise<SupabaseClient>;
  /** Path of a proof-of-delivery photo uploaded into this user's evidence folder (Storage on Supabase). */
  evidencePhoto(uid: string): Promise<string>;
  cleanup(): Promise<string[]>;
}

export const TEST_EMAIL_DOMAIN = "nama.test";
export const isTestEmail = (e: string | null | undefined) => !!e && e.startsWith("test-") && e.endsWith(`@${TEST_EMAIL_DOMAIN}`);

const MIGRATIONS = join(__dirname, "..", "..", "migrations");
export const migrationFiles = () =>
  readdirSync(MIGRATIONS)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), "utf8") }));

function claimsSql(uid: Uid) {
  const role = uid ? "authenticated" : "anon";
  const claims = uid ? JSON.stringify({ sub: uid, role }) : "";
  return { role, sub: uid ?? "", claims };
}

// ---------------------------------------------------------------- PGlite

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create role supabase_auth_admin nologin;
  create schema auth;
  -- Supabase Auth stores phone without the "+". Stub users get a confirmed email by default.
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    email_confirmed_at timestamptz default now(),
    phone text unique,
    phone_confirmed_at timestamptz,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  grant usage on schema public, auth to anon, authenticated;
  -- Supabase grants these by default; the migrations must lock them down themselves.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  create publication supabase_realtime;
`;

export async function pgliteTarget(opts: { beforeMigration?: Record<string, (db: PGlite, t: Target) => Promise<void>> } = {}): Promise<Target> {
  const db = new PGlite();
  // PGlite has one connection: serialise every transaction so roles never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const inTx = async <T>(uid: Uid, fn: (q: <R>(s: string, p?: unknown[]) => Promise<R[]>) => Promise<T>) => {
    const c = claimsSql(uid);
    return db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [c.sub, c.claims]);
      await tx.exec(`set local role ${c.role}`);
      return fn(async (s, p = []) => (await tx.query(s, p)).rows as never);
    });
  };

  const target: Target = {
    name: "pglite",
    fresh: true,
    parallel: false,
    runId: "pglite",
    as: (uid, sql, params = []) => serial(() => inTx(uid, (q) => q(sql, params))),
    admin: (sql, params = []) => serial(async () => (await db.query(sql, params)).rows as never),
    adminRollback: (fn) =>
      serial(async () => {
        let out: unknown;
        await db
          .transaction(async (tx) => {
            out = await fn(async (s, p = []) => (await tx.query(s, p)).rows as never);
            throw new RollbackSignal();
          })
          .catch((e) => {
            if (!(e instanceof RollbackSignal)) throw e;
          });
        return out as never;
      }),
    createUser: async (label, meta) => {
      const email = `test-pglite-${label}@${TEST_EMAIL_DOMAIN}`;
      const rows = await target.admin<{ id: string }>("insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id", [email, JSON.stringify(meta)]);
      return { id: rows[0].id, email, password: "" };
    },
    // One connection: "sessions" share it and calls are serialised, so this is
    // never a true race. Held transactions (barriers) aren't possible here.
    session: async () => ({
      as: target.as,
      begin: async () => {
        throw new Error("held transactions need separate backends (not available on PGlite)");
      },
      close: async () => undefined,
    }),
    // PGlite has no Storage; submit_pod only checks the path is in the caller's folder.
    evidencePhoto: async (uid) => `${uid}/test-pod.jpg`,
    cleanup: async () => [],
  };

  await db.exec(SUPABASE_STUB);
  for (const m of migrationFiles()) {
    const hook = opts.beforeMigration?.[m.file];
    if (hook) await hook(db, target);
    await db.exec(m.sql);
  }
  return target;
}

class RollbackSignal extends Error {}

// ---------------------------------------------------------------- Supabase

export async function supabaseTarget(): Promise<Target> {
  const { DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL } = process.env;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!DATABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NEXT_PUBLIC_SUPABASE_URL || !anonKey) {
    throw new Error("Supabase run needs DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL and the publishable/anon key in .env.local");
  }
  const url = new URL(DATABASE_URL);
  url.searchParams.delete("sslmode");
  url.port = "6543"; // transaction pooler: more client slots than session mode; SET LOCAL is transaction-scoped
  const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max: 24 });
  const adminApi = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const created: { id: string; email: string }[] = [];

  const onClient = async <T>(client: pg.PoolClient, uid: Uid | "admin", fn: (q: <R>(s: string, p?: unknown[]) => Promise<R[]>) => Promise<T>, rollback = false) => {
    await client.query("begin");
    try {
      if (uid !== "admin") {
        const c = claimsSql(uid);
        await client.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [c.sub, c.claims]);
        await client.query(`set local role ${c.role}`);
      }
      const out = await fn(async (s, p = []) => (await client.query(s, p as unknown[])).rows as never);
      await client.query(rollback ? "rollback" : "commit");
      return out;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    }
  };
  const withClient = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  };

  const target: Target = {
    name: "supabase",
    fresh: false,
    parallel: true,
    runId,
    as: (uid, sql, params = []) => withClient((c) => onClient(c, uid, (q) => q(sql, params))),
    admin: (sql, params = []) => withClient(async (c) => (await c.query(sql, params as unknown[])).rows as never),
    adminRollback: (fn) => withClient((c) => onClient(c, "admin", fn as never, true)) as never,
    createUser: async (label, meta) => {
      const email = `test-${runId}-${label}@${TEST_EMAIL_DOMAIN}`;
      const password = `T-${runId}-${Math.random().toString(36).slice(2)}A1!`;
      const { data, error } = await adminApi.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: meta });
      if (error) throw new Error(`createUser(${label}): ${error.message}`);
      created.push({ id: data.user.id, email });
      return { id: data.user.id, email, password };
    },
    session: async () => {
      const client = await pool.connect();
      return {
        as: (uid, sql, params = []) => onClient(client, uid, (q) => q(sql, params)),
        begin: async (uid) => {
          await client.query("begin");
          const c = claimsSql(uid);
          await client.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [c.sub, c.claims]);
          await client.query(`set local role ${c.role}`);
          return {
            query: async (s, p = []) => (await client.query(s, p as unknown[])).rows as never,
            commit: async () => void (await client.query("commit")),
            rollback: async () => void (await client.query("rollback")),
          };
        },
        close: async () => client.release(),
      };
    },
    evidencePhoto: async (uid) => {
      const path = `${uid}/test-${runId}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await adminApi.storage.from("evidence").upload(path, new Uint8Array([255, 216, 255, 217]), { contentType: "image/jpeg" });
      if (error) throw new Error(`upload ${path}: ${error.message}`);
      return path;
    },
    apiClientFor: async (email, password) => {
      const c = createClient(NEXT_PUBLIC_SUPABASE_URL, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await c.auth.signInWithPassword({ email, password });
      if (error) throw new Error(`sign-in ${email}: ${error.message}`);
      return c;
    },
    cleanup: async () => {
      const log: string[] = [];
      // Also sweep leftovers from earlier interrupted runs — test-prefixed only.
      const leftovers: { id: string; email: string }[] = [];
      for (let page = 1; ; page++) {
        const { data, error } = await adminApi.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        for (const u of data.users) if (isTestEmail(u.email)) leftovers.push({ id: u.id, email: u.email! });
        if (data.users.length < 200) break;
      }
      const all = [...new Map([...created, ...leftovers].map((u) => [u.id, u])).values()];
      const ids0 = all.map((u) => u.id);
      // Tankers outlive their drivers (tanker_assignments), so delete the test ones explicitly.
      // Only "TST…" plates assigned (now or before) to test users are touched; permits cascade.
      const [tk] = await target.admin<{ n: number }>(
        `with gone as (
           delete from public.tankers t
            where t.plate like 'TST%'
              and exists (select 1 from public.tanker_assignments a where a.tanker_id = t.id and a.driver_id = any($1::uuid[]))
           returning 1)
         select count(*)::int as n from gone`,
        [ids0],
      );
      const [orphans] = await target.admin<{ n: number }>(
        `with gone as (
           delete from public.tankers t
            where t.plate like 'TST%' and not exists (select 1 from public.tanker_assignments a where a.tanker_id = t.id)
           returning 1)
         select count(*)::int as n from gone`,
      );
      log.push(`deleted ${tk.n} test tankers (+${orphans.n} unassigned TST tankers) with their permits`);
      // Test companies and business accounts (CR numbers start with TST) and what hangs off them.
      const [orgs] = await target.admin<{ companies: number; orgs: number }>(
        `with tco as (select id from public.companies where cr_no like 'TST%'), torg as (select id from public.organizations where cr_no like 'TST%'),
              p as (delete from public.penalties where company_id in (select id from tco) returning 1),
              k as (delete from public.contracts where company_id in (select id from tco) or org_id in (select id from torg) returning 1)
         select (select count(*) from tco)::int as companies, (select count(*) from torg)::int as orgs`,
      );
      await target.admin("delete from public.companies where cr_no like 'TST%'");
      await target.admin("delete from public.organizations where cr_no like 'TST%'");
      log.push(`deleted ${orgs.companies} test companies and ${orgs.orgs} test business accounts`);
      // Test evidence uploads live in the test users' folders.
      for (const u of all) {
        const { data: files } = await adminApi.storage.from("evidence").list(u.id);
        if (files?.length) await adminApi.storage.from("evidence").remove(files.map((f) => `${u.id}/${f.name}`));
      }
      for (const u of all) {
        if (!isTestEmail(u.email)) throw new Error(`refusing to delete non-test user ${u.id}`);
        const { error } = await adminApi.auth.admin.deleteUser(u.id);
        if (error) log.push(`delete ${u.email}: ERROR ${error.message}`);
      }
      const ids = all.map((u) => u.id);
      const [left] = await target.admin<{ users: number; profiles: number; assignments: number; test_tankers: number; orders: number; locations: number }>(
        `select (select count(*) from auth.users where id = any($1::uuid[]))::int as users,
                (select count(*) from public.profiles where id = any($1::uuid[]))::int as profiles,
                (select count(*) from public.tanker_assignments where driver_id = any($1::uuid[]))::int as assignments,
                (select count(*) from public.tankers where plate like 'TST%')::int as test_tankers,
                (select count(*) from public.orders where customer_id = any($1::uuid[]) or driver_id = any($1::uuid[]))::int as orders,
                (select count(*) from public.order_locations l join public.orders o on o.id = l.order_id where o.customer_id = any($1::uuid[]))::int as locations`,
        [ids],
      );
      log.push(`deleted ${all.length} test users (${created.length} from this run, ${all.length - created.length} leftovers)`);
      log.push(`remaining rows for those users: ${JSON.stringify(left)}`);
      await pool.end();
      return log;
    },
  };
  return target;
}

// ---------------------------------------------------------------- reporting

export type Result = { section: string; id: string; name: string; ok: boolean; detail?: string; skipped?: boolean; note?: string };

export class Reporter {
  results: Result[] = [];
  section = "";
  private n = 0;
  constructor(private out: (line: string) => void) {}
  start(section: string) {
    this.section = section;
    this.n = 0;
    this.out(`\n## ${section}`);
  }
  /** `note` is context worth keeping even on success (e.g. how a race was run). */
  check(name: string, ok: boolean, detail?: unknown, note?: string) {
    const id = `${this.section.split(" ")[0]}-${String(++this.n).padStart(2, "0")}`;
    const d = detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail);
    this.results.push({ section: this.section, id, name, ok, detail: ok ? undefined : d, note });
    this.out(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${note ? `  [${note}]` : ""}${ok || !d ? "" : `  — ${d.slice(0, 300)}`}`);
  }
  skip(name: string, why: string) {
    const id = `${this.section.split(" ")[0]}-${String(++this.n).padStart(2, "0")}`;
    this.results.push({ section: this.section, id, name, ok: true, skipped: true, detail: why });
    this.out(`SKIP  ${id}  ${name}  — ${why}`);
  }
  /** Expect an error whose message contains `match`. */
  async denies(name: string, run: () => Promise<unknown>, match: string) {
    try {
      const r = await run();
      this.check(name, false, `allowed (no error): ${JSON.stringify(r).slice(0, 120)}`);
    } catch (e) {
      const msg = (e as Error).message;
      this.check(name, msg.includes(match), msg);
    }
  }
  /** Expect success; returns the result (or undefined on error). */
  async allows<T>(name: string, run: () => Promise<T>, accept: (r: T) => boolean = () => true): Promise<T | undefined> {
    try {
      const r = await run();
      this.check(name, accept(r), r);
      return r;
    } catch (e) {
      this.check(name, false, (e as Error).message);
      return undefined;
    }
  }
}
