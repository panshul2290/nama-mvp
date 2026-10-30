// Unit tests for per-app sessions (lib/apps.ts): which app a page belongs to, its auth
// cookie, and which app each kind of account signs in to; plus the driver's go-online
// blockers (components/driver/blockers.ts).
//   npm run test:unit
import { onlineBlockers } from "../../components/driver/blockers";
import type { PermitRow, PermitState } from "../../components/driver/permit";
import { APP_KEYS, appFor, appForPage, appHome, areaApp, asApp, cookieNameFor, homeFor, isDesktopApp, isLegacyAuthCookie, SHARED_COOKIE } from "../../lib/apps";
import type { Role } from "../../lib/types";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail)}`}`);
};
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ---- page → app ----------------------------------------------------------------
eq("/nws → nws", appForPage("/nws"), "nws");
eq("/nws/orders/1 → nws", appForPage("/nws/orders/1"), "nws");
eq("/company/fleet → company", appForPage("/company/fleet"), "company");
eq("/business → business", appForPage("/business"), "business");
eq("/customer/orders/9 → customer", appForPage("/customer/orders/9"), "customer");
eq("/driver/jobs → driver", appForPage("/driver/jobs"), "driver");
eq("/onboarding belongs to the driver app", appForPage("/onboarding"), "driver");
eq("trailing slash (static export) /driver/jobs/ → driver", appForPage("/driver/jobs/"), "driver");
eq("a lookalike prefix is not an app (/nwsx)", appForPage("/nwsx"), null);
eq("launcher / → no app", appForPage("/"), null);
eq("/login?app=nws → nws", appForPage("/login", "?app=nws"), "nws");
eq("/login/reset?app=company → company", appForPage("/login/reset", "?app=company"), "company");
eq("/signup?app=business → business", appForPage("/signup", "?app=business"), "business");
eq("/auth/callback?app=customer&next=/login/reset → customer", appForPage("/auth/callback", "?app=customer&next=/login/reset"), "customer");
eq("/switch?app=driver → driver", appForPage("/switch", "?app=driver"), "driver");
eq("/login without ?app= → no app", appForPage("/login"), null);
eq("/login?app=bogus → no app", appForPage("/login", "?app=bogus"), null);
eq("the path wins over ?app= (/nws?app=customer)", appForPage("/nws", "?app=customer"), "nws");
eq("?app= only counts on the sign-in pages (/?app=nws)", appForPage("/", "?app=nws"), null);
eq("URLSearchParams works too", appForPage("/login", new URLSearchParams({ app: "driver" })), "driver");
eq("one-app build (APK target customer) on /login", appForPage("/login", "", "customer"), "customer");
eq("one-app build wins over the path and ?app=", appForPage("/login", "?app=nws", "driver"), "driver");
eq("unknown build target is ignored", appForPage("/nws", "", "web"), "nws");
eq("areaApp(/login) → null", areaApp("/login"), null);

// ---- cookies -------------------------------------------------------------------------
const names = APP_KEYS.map(cookieNameFor);
check("each app has its own cookie", new Set(names).size === APP_KEYS.length, names);
eq("nws cookie", cookieNameFor("nws"), "sb-nama-nws");
eq("driver cookie", cookieNameFor("driver"), "sb-nama-driver");
eq("no app → shared cookie", cookieNameFor(null), SHARED_COOKIE);
check("shared cookie differs from every app's", !names.includes(SHARED_COOKIE));
check("no app cookie is a prefix-chunk of another (sb-nama-x.0 vs sb-nama-xy)", names.every((a) => names.every((b) => a === b || !b.startsWith(`${a}.`))));
check("legacy sb-<ref>-auth-token is cleared", isLegacyAuthCookie("sb-abcdefghijklmnop-auth-token"));
check("legacy chunk .0 is cleared", isLegacyAuthCookie("sb-abcdefghijklmnop-auth-token.0"));
check("legacy code verifier is cleared", isLegacyAuthCookie("sb-abcdefghijklmnop-auth-token-code-verifier"));
check("per-app cookies are kept", names.every((n) => !isLegacyAuthCookie(n) && !isLegacyAuthCookie(`${n}.0`) && !isLegacyAuthCookie(`${n}-code-verifier`)));
check("shared cookie is kept", !isLegacyAuthCookie(SHARED_COOKIE));
check("unrelated cookies are kept", !isLegacyAuthCookie("nama.lang") && !isLegacyAuthCookie("sb-x"));

// ---- role → app ---------------------------------------------------------------------
const ROLE_APP: [Role, string][] = [
  ["nws_staff", "nws"],
  ["owner", "company"],
  ["business", "business"],
  ["driver", "driver"],
  ["customer", "customer"],
];
for (const [role, app] of ROLE_APP) eq(`${role} signs in to ${app}`, appFor(role), app);
// Each role's home is inside its own app, so a sign-in never leaves the app it was made on.
for (const [role] of ROLE_APP) {
  for (const tanker of [false, true]) {
    const home = homeFor(role, tanker);
    eq(`home of ${role}${role === "driver" ? (tanker ? " (tanker)" : " (no tanker)") : ""} (${home}) is in its app`, appForPage(home), appFor(role));
  }
}
for (const app of APP_KEYS) eq(`appHome(${app}) is in ${app}`, appForPage(appHome(app)), app);
// Web portals never admit phone-app accounts, and the other way round.
const phoneRoles: Role[] = ["customer", "driver"];
for (const app of APP_KEYS.filter((a) => isDesktopApp(a))) {
  check(`${app} (web) admits no customer/driver account`, phoneRoles.every((r) => appFor(r) !== app));
}
for (const app of APP_KEYS.filter((a) => !isDesktopApp(a))) {
  check(`${app} (phone) admits no portal account`, (["nws_staff", "owner", "business"] as Role[]).every((r) => appFor(r) !== app));
}
eq("asApp(company)", asApp("company"), "company");
eq("asApp(null)", asApp(null), null);

// ---- driver: why can't I go online -------------------------------------------------------
const row = (p: Partial<PermitRow>): PermitRow => ({ id: "p", permit_no: "P-1", type: "DW", status: "approved", issued_at: "2026-01-01", expires_at: "2027-01-01", ...p });
const state = (key: PermitState["key"], extra: Partial<PermitState> = {}): PermitState => ({ key, current: null, daysLeft: null, pending: null, ...extra });
type Input = Parameters<typeof onlineBlockers>[0];
const base: Input = { blocked: false, blockedReason: null, companySuspended: false, permit: state("valid"), shiftChecked: true };
const kinds = (s: Partial<Input>) => onlineBlockers({ ...base, ...s }).map((b) => b.kind);

eq("all clear → no blockers", kinds({}), []);
eq("expiring permit still lets you go online", kinds({ permit: state("expiring", { daysLeft: 5 }) }), []);
eq("permits still loading → no permit blocker", kinds({ permit: null }), []);
eq("shift check not done", kinds({ shiftChecked: false }), ["check"]);
eq("no permit", onlineBlockers({ ...base, permit: state("none") }), [{ kind: "permit_none", wrong: false }]);
eq("permit for another service", onlineBlockers({ ...base, permit: state("wrong") }), [{ kind: "permit_none", wrong: true }]);
eq(
  "pending application, stage inspection = 3 of 4, with NWS's request",
  onlineBlockers({ ...base, permit: state("none", { pending: row({ status: "pending", stage: "inspection", info_requested: " Upload the mulkiya " }) }) }),
  [{ kind: "permit_pending", stage: 3, stageKey: "inspection", info: "Upload the mulkiya" }],
);
eq(
  "pending renewal of an expired permit shows the review, not 'expired'",
  onlineBlockers({ ...base, permit: state("expired", { current: row({}), pending: row({ status: "pending", stage: "submitted" }) }) }),
  [{ kind: "permit_pending", stage: 1, stageKey: "submitted", info: null }],
);
eq(
  "unknown stage counts as stage 1",
  onlineBlockers({ ...base, permit: state("none", { pending: row({ status: "pending", stage: "weird" }) }) }).map((b) => (b.kind === "permit_pending" ? b.stage : 0)),
  [1],
);
eq(
  "rejected with NWS's reason",
  onlineBlockers({ ...base, permit: state("rejected", { current: row({ status: "rejected", reason: "Tank photos unclear" }) }) }),
  [{ kind: "permit_rejected", reason: "Tank photos unclear" }],
);
eq(
  "expired with its date",
  onlineBlockers({ ...base, permit: state("expired", { current: row({ expires_at: "2026-09-30T00:00:00Z" }) }) }),
  [{ kind: "permit_expired", expiredAt: "2026-09-30T00:00:00Z" }],
);
eq("blocked with NWS's reason", onlineBlockers({ ...base, blocked: true, blockedReason: "  IVMS tampering " }), [{ kind: "blocked", reason: "IVMS tampering" }]);
eq("blocked without a reason", onlineBlockers({ ...base, blocked: true, blockedReason: "" }), [{ kind: "blocked", reason: null }]);
eq("company suspended", kinds({ companySuspended: true }), ["company"]);
eq(
  "everything at once, in fixing order",
  kinds({ blocked: true, companySuspended: true, permit: state("none"), shiftChecked: false }),
  ["blocked", "company", "permit_none", "check"],
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
