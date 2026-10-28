// Loads the presentation demo data (supabase/seed/demo.sql) into DATABASE_URL.
// Run `npm run seed` first (accounts). Runs once; re-running is a no-op.
//   npm run seed:demo
// Never prints the connection string.
import { readFileSync } from "node:fs";
import pg from "pg";

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("DATABASE_URL is not set (expected in .env.local).");
  process.exit(1);
}
const url = new URL(raw);
const secrets = [raw, url.password, decodeURIComponent(url.password)].filter(Boolean);
const scrub = (s) => secrets.reduce((acc, x) => acc.split(x).join("***"), String(s));
url.searchParams.delete("sslmode");
const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
const client = new pg.Client({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false } });

try {
  await client.connect();
  client.on("notice", (n) => console.log(n.message));
  await client.query("begin");
  await client.query(readFileSync("supabase/seed/demo.sql", "utf8"));
  await client.query("commit");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("Demo seed failed and was rolled back:", scrub(e.message));
  process.exitCode = 1;
} finally {
  await client.end();
}
