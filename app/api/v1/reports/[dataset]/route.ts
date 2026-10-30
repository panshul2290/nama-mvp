// GET /api/v1/reports/{dataset} (scope reports:read): paged export for BI / a data warehouse.
import { callApi, num, qp } from "@/lib/api/server";

export async function GET(req: Request, ctx: { params: Promise<{ dataset: string }> }) {
  const { dataset } = await ctx.params;
  const q = qp(req);
  return callApi(req, `/api/v1/reports/${dataset}`, "api_v1_report", {
    p_dataset: dataset, p_from: q.get("from"), p_to: q.get("to"), p_limit: num(q.get("limit")), p_cursor: q.get("cursor"),
  });
}
