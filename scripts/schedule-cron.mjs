// Schedules the pg_cron jobs that migrations record in public.cron_wanted (0028+).
// On Supabase, cron.schedule can drop the connection, so each job gets its own
// connection and is retried; scheduling is idempotent (unschedule, then schedule).
// Usage: node --env-file=.env.local scripts/schedule-cron.mjs   (db:apply runs it too)
import { createRequire } from "node:module";
import { join } from "node:path";

const pg = createRequire(join(process.cwd(), "package.json"))("pg");

function connectionString() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set (expected in .env.local).");
  const url = new URL(raw);
  url.searchParams.delete("sslmode");
  return url.toString();
}

async function withClient(fn) {
  const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  client.on("error", () => {}); // a dropped connection surfaces as a rejected query
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function scheduleCron({ attempts = 6 } = {}) {
  const wanted = await withClient(async (c) => {
    if (!(await c.query("select to_regclass('public.cron_wanted') t")).rows[0].t) return null;
    if (!(await c.query("select 1 from pg_extension where extname = 'pg_cron'")).rowCount) return [];
    return (await c.query("select name, cron, command from public.cron_wanted order by name")).rows;
  });
  if (wanted === null) return console.log("  cron: no public.cron_wanted yet (before 0028)");
  if (!wanted.length) return console.log("  cron: pg_cron not installed; nothing scheduled");

  for (const job of wanted) {
    let done = false;
    for (let i = 1; i <= attempts && !done; i++) {
      done = await withClient(async (c) => {
        const cur = await c.query("select schedule, command from cron.job where jobname = $1", [job.name]);
        if (cur.rows[0]?.schedule === job.cron && cur.rows[0]?.command === job.command) return true;
        await c.query("select cron.unschedule(jobid) from cron.job where jobname = $1", [job.name]);
        await c.query("select cron.schedule($1, $2, $3)", [job.name, job.cron, job.command]);
        return true;
      }).catch(() => false);
      if (!done) await new Promise((r) => setTimeout(r, 1500 * i));
    }
    console.log(`  cron: ${job.name} (${job.cron}) ${done ? "scheduled" : "FAILED after retries"}`);
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("schedule-cron.mjs")) {
  scheduleCron().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
