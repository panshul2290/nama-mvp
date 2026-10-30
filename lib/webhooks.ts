// Verifying Nama webhooks (G11), for receivers written in TypeScript/Node.
//
// Each delivery carries "X-Nama-Signature: t=<unix seconds>,v1=<hex>", where hex is
// HMAC-SHA256(secret, `${t}.${rawBody}`) (webhook_sign, 0028). Verify against the raw
// request body, before parsing it, and reject old timestamps to stop replays.
import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyWebhook(secret: string, header: string | null, rawBody: string, toleranceSeconds = 300, now = Date.now()): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, t, rawBody).split("v1=")[1], "hex");
  const got = Buffer.from(m[2], "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
