// Margin dashboard (56b). GET /admin/margin — maintainer-only, guarded by the
// ADMIN_TOKEN secret. Queries Workers Analytics Engine's SQL API for aggregate
// usage/cost over the last 7 and 30 days. Reads hashed metrics only; no content.
//
// Degradation:
//   - ADMIN_TOKEN unset            -> 404 (endpoint is invisible)
//   - wrong/missing bearer token   -> 401
//   - CF_ANALYTICS_API_TOKEN unset -> 503 analytics_unavailable
//   - SQL API failure              -> 503 analytics_unavailable

import type { Env } from "./config";
import { ASSUMED_MONTHLY_REVENUE_USD, USAGE_DATASET } from "./config";
import { jsonError } from "./errors";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format an epoch-ms instant for the Analytics Engine SQL `toDateTime('...')`. */
export function isoForSql(ms: number): string {
  // 'YYYY-MM-DD HH:MM:SS' (UTC, no ms, no trailing Z) — the form the SQL API wants.
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** Aggregate query for one time window. `_sample_interval` reweights AE sampling. */
export function aggregateSql(dataset: string, sinceIso: string): string {
  return (
    `SELECT ` +
    `SUM(_sample_interval) AS drafts, ` +
    `SUM(_sample_interval * (double1 + double2)) AS tokens, ` +
    `SUM(_sample_interval * double3) AS cost_usd, ` +
    `quantileWeighted(0.5)(double3, _sample_interval) AS cost_p50, ` +
    `quantileWeighted(0.95)(double3, _sample_interval) AS cost_p95, ` +
    `COUNT(DISTINCT index1) AS active_accounts ` +
    `FROM ${dataset} ` +
    `WHERE timestamp >= toDateTime('${sinceIso}') AND blob3 = 'ok'`
  );
}

/** Top-10 accounts by estimated cost in one window (hashed ids). */
export function topAccountsSql(dataset: string, sinceIso: string): string {
  return (
    `SELECT index1 AS account, ` +
    `SUM(_sample_interval * double3) AS cost_usd, ` +
    `SUM(_sample_interval) AS drafts ` +
    `FROM ${dataset} ` +
    `WHERE timestamp >= toDateTime('${sinceIso}') AND blob3 = 'ok' ` +
    `GROUP BY index1 ORDER BY cost_usd DESC LIMIT 10`
  );
}

/** Constant-time, length-safe string equality (compares SHA-256 digests). */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

type Row = Record<string, unknown>;

async function runSql(env: Env, sql: string, fetchImpl: typeof fetch): Promise<Row[]> {
  const res = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`,
        "content-type": "text/plain",
      },
      body: sql,
    },
  );
  if (!res.ok) throw new Error("analytics_sql_failed");
  const json = await res.json<{ data?: Row[] }>();
  return json.data ?? [];
}

function shapeWindow(agg: Row | undefined, top: Row[]) {
  const drafts = num(agg?.drafts);
  const activeAccounts = num(agg?.active_accounts);
  const costUsdTotal = num(agg?.cost_usd);
  const costPerActive = activeAccounts > 0 ? costUsdTotal / activeAccounts : 0;
  return {
    drafts,
    tokens: num(agg?.tokens),
    estCostUsd: costUsdTotal,
    costPerDraftP50Usd: num(agg?.cost_p50),
    costPerDraftP95Usd: num(agg?.cost_p95),
    activeAccounts,
    estCostPerActiveAccountUsd: costPerActive,
    // Positive => the assumed subscription revenue covers inference cost per account.
    marginPerActiveAccountUsd: ASSUMED_MONTHLY_REVENUE_USD - costPerActive,
    topAccounts: top.map((r) => ({
      hashedUserId: str(r.account),
      estCostUsd: num(r.cost_usd),
      drafts: num(r.drafts),
    })),
  };
}

export async function handleMargin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // 404 when the feature is not configured — the endpoint should be invisible.
  if (!env.ADMIN_TOKEN) return jsonError(404, "not_found", "Not found.");

  const header = request.headers.get("authorization") ?? request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token || !(await constantTimeEqual(token, env.ADMIN_TOKEN))) {
    return jsonError(401, "unauthenticated", "Admin token required.");
  }

  if (!env.CF_ANALYTICS_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return jsonError(503, "analytics_unavailable", "Analytics API is not configured.");
  }

  const now = Date.now();
  try {
    const windows: Record<string, ReturnType<typeof shapeWindow>> = {};
    for (const [key, days] of [
      ["7d", 7],
      ["30d", 30],
    ] as const) {
      const since = isoForSql(now - days * DAY_MS);
      const [agg] = await runSql(env, aggregateSql(USAGE_DATASET, since), fetchImpl);
      const top = await runSql(env, topAccountsSql(USAGE_DATASET, since), fetchImpl);
      windows[key] = shapeWindow(agg, top);
    }
    return Response.json({
      generatedAt: new Date(now).toISOString(),
      assumedMonthlyRevenueUsd: ASSUMED_MONTHLY_REVENUE_USD,
      windows,
    });
  } catch {
    return jsonError(503, "analytics_unavailable", "Could not query analytics.");
  }
}
