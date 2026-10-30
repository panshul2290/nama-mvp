// The seam for real notification gateways (E13).
//
// The database queues one message per channel (notification_outbox, 0026). Channels set
// to "Simulated" in NWS Settings → Notifications are sent by the built-in simulator. When
// a real gateway is contracted (an Omani SMS aggregator, WhatsApp Business, FCM, SMTP),
// set its channel to "External gateway", give the worker an API key with the notify:send
// scope, and run runGatewayWorker on a schedule (a cron job, a queue consumer, a small
// container in the Oman hosting). It claims queued messages, hands each to the provider
// adapter and reports the answer, which NWS sees in the outbox.
//
// No provider credentials exist yet: the adapters below are stubs that refuse to send.

export type Channel = "push" | "sms" | "whatsapp" | "email";

/** A message as /api/v1/notifications/claim returns it. */
export type OutboxMessage = { id: number; channel: Channel; to: string | null; lang: "en" | "ar"; title: string; body: string; event: string; attempt: number };

/** What a provider answered. permanent: don't retry (bad number, unregistered token). */
export type SendResult = { ok: boolean; providerRef?: string; response?: unknown; error?: string; permanent?: boolean };

export interface NotificationProvider {
  channel: Channel;
  name: string;
  send(m: OutboxMessage): Promise<SendResult>;
}

/** Placeholder for a provider whose credentials don't exist yet. */
export function notConfigured(channel: Channel, name: string): NotificationProvider {
  return {
    channel,
    name,
    send: async () => ({ ok: false, error: `${name} is not configured (no credentials in this environment)` }),
  };
}

// Where each real provider plugs in. Replace the stub with an implementation that calls
// the provider's HTTP API; keep secrets in the worker's environment, never in the database.
export const PROVIDERS: Record<Channel, NotificationProvider> = {
  sms: notConfigured("sms", "SMS gateway"),
  whatsapp: notConfigured("whatsapp", "WhatsApp Business API"),
  push: notConfigured("push", "Firebase Cloud Messaging"),
  email: notConfigured("email", "SMTP / email API"),
};

type Fetch = typeof fetch;

/** Claim up to `limit` messages of one channel, send them, report each result. */
export async function runGatewayWorker(opts: { baseUrl: string; apiKey: string; channel: Channel; provider?: NotificationProvider; limit?: number; fetchImpl?: Fetch }) {
  const f = opts.fetchImpl ?? fetch;
  const provider = opts.provider ?? PROVIDERS[opts.channel];
  const headers = { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" };
  const claim = await f(`${opts.baseUrl}/api/v1/notifications/claim`, { method: "POST", headers, body: JSON.stringify({ channel: opts.channel, limit: opts.limit ?? 50 }) });
  if (!claim.ok) throw new Error(`claim failed: ${claim.status} ${await claim.text()}`);
  const { data } = (await claim.json()) as { data: OutboxMessage[] };
  let sent = 0;
  for (const m of data) {
    let r: SendResult;
    try {
      r = m.to ? await provider.send(m) : { ok: false, permanent: true, error: "No destination" };
    } catch (e) {
      r = { ok: false, error: (e as Error).message };
    }
    await f(`${opts.baseUrl}/api/v1/notifications/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: m.id, ok: r.ok, provider_ref: r.providerRef, response: r.response ?? null, error: r.error, permanent: r.permanent ?? false }),
    });
    if (r.ok) sent += 1;
  }
  return { claimed: data.length, sent };
}
