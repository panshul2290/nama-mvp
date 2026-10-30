// The driver app's training quizzes (components/driver/training.ts) must use the same answers
// as the database grades against (training_lessons in 0030).  npm run test:unit
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LESSONS } from "../../components/driver/training";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};

console.log("## UNIT driver training content");
const sql = readFileSync(join(__dirname, "../../supabase/migrations/0030_mobile_features.sql"), "utf8");
const db = new Map<string, number[]>();
for (const m of sql.matchAll(/\('(\w+)',\s*\d+,\s*array\[([\d,\s]+)\],\s*\d+\)/g)) db.set(m[1], m[2].split(",").map((x) => Number(x.trim())));
check("the migration lists five lessons", db.size === 5, [...db.keys()]);
check("the app lists the same lessons", LESSONS.length === db.size && LESSONS.every((l) => db.has(l.key)), LESSONS.map((l) => l.key));
for (const l of LESSONS) {
  check(`${l.key}: answers match the database key`, JSON.stringify(l.quiz.map((q) => q.answer)) === JSON.stringify(db.get(l.key)), { app: l.quiz.map((q) => q.answer), db: db.get(l.key) });
  const texts = [l.title, ...l.body, ...l.quiz.flatMap((q) => [q.q, q.why, ...q.options])];
  check(`${l.key}: every text has English and Arabic`, texts.every((x) => x.en.trim() && /[؀-ۿ]/.test(x.ar)), l.key);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
