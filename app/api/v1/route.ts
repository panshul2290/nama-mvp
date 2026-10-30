// GET /api/v1: the API's index (no key needed). Spec: docs/api/openapi.yaml.
import { json } from "@/lib/api/server";

export function GET() {
  return json({
    name: "Nama Tanker integration API",
    version: "v1",
    auth: "Authorization: Bearer <API key> (NWS Settings, Integrations)",
    endpoints: [
      "GET /api/v1/orders", "GET /api/v1/tankers", "GET /api/v1/permits", "PATCH /api/v1/permits/{permit_no}",
      "POST /api/v1/events", "POST /api/v1/ivms/fixes", "GET /api/v1/reports/{dataset}",
      "POST /api/v1/notifications/claim", "POST /api/v1/notifications/report",
    ],
  });
}
