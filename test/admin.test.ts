import { describe, it, expect, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../src/config";
import {
  aggregateSql,
  constantTimeEqual,
  handleMargin,
  isoForSql,
  topAccountsSql,
} from "../src/admin";
import { USAGE_DATASET } from "../src/config";

function baseEnv(overrides: Partial<Env>): Env {
  return {
    ...testEnv,
    CLERK_SECRET_KEY: "sk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLERK_PUBLISHABLE_KEY: "pk_test",
    ...overrides,
  };
}

function marginReq(token?: string): Request {
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("https://sentwise-inference.test/admin/margin", { headers });
}

describe("SQL builders", () => {
  it("aggregateSql targets the dataset and time window and filters to ok drafts", () => {
    const sql = aggregateSql(USAGE_DATASET, "2026-08-01 00:00:00");
    expect(sql).toContain(`FROM ${USAGE_DATASET}`);
    expect(sql).toContain("toDateTime('2026-08-01 00:00:00')");
    expect(sql).toContain("blob3 = 'ok'");
    expect(sql).toContain("quantileWeighted(0.5)");
    expect(sql).toContain("quantileWeighted(0.95)");
    expect(sql).toContain("COUNT(DISTINCT index1)");
  });
  it("topAccountsSql groups by account and limits to 10", () => {
    const sql = topAccountsSql(USAGE_DATASET, "2026-08-01 00:00:00");
    expect(sql).toContain("GROUP BY index1");
    expect(sql).toContain("ORDER BY cost_usd DESC");
    expect(sql).toContain("LIMIT 10");
  });
  it("isoForSql yields a space-separated UTC timestamp with no ms/Z", () => {
    expect(isoForSql(Date.parse("2026-08-29T09:15:30.500Z"))).toBe("2026-08-29 09:15:30");
  });
});

describe("constantTimeEqual", () => {
  it("is true for equal strings and false otherwise", async () => {
    expect(await constantTimeEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(await constantTimeEqual("s3cret-token", "s3cret-toke")).toBe(false);
    expect(await constantTimeEqual("a", "b")).toBe(false);
  });
});

describe("GET /admin/margin auth gating", () => {
  it("404s when ADMIN_TOKEN is unset (endpoint invisible)", async () => {
    const env = baseEnv({ ADMIN_TOKEN: undefined });
    const res = await handleMargin(marginReq("anything"), env);
    expect(res.status).toBe(404);
  });

  it("401s a missing or wrong bearer token", async () => {
    const env = baseEnv({ ADMIN_TOKEN: "correct-token", CF_ANALYTICS_API_TOKEN: "cf" });
    expect((await handleMargin(marginReq(), env)).status).toBe(401);
    expect((await handleMargin(marginReq("wrong"), env)).status).toBe(401);
  });

  it("503s when the analytics API token is unset", async () => {
    const env = baseEnv({ ADMIN_TOKEN: "correct-token", CF_ANALYTICS_API_TOKEN: undefined });
    const res = await handleMargin(marginReq("correct-token"), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.type).toBe("analytics_unavailable");
  });
});

describe("GET /admin/margin success", () => {
  it("shapes 7d/30d windows from the SQL API and computes per-account margin", async () => {
    const env = baseEnv({
      ADMIN_TOKEN: "correct-token",
      CF_ANALYTICS_API_TOKEN: "cf-token",
      CF_ACCOUNT_ID: "acct123",
    });
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const sql = init.body as string;
      if (sql.includes("GROUP BY")) {
        return Promise.resolve(
          Response.json({ data: [{ account: "hashA", cost_usd: "0.30", drafts: "5" }] }),
        );
      }
      return Promise.resolve(
        Response.json({
          data: [
            {
              drafts: "10",
              tokens: "1000",
              cost_usd: "0.50",
              cost_p50: "0.05",
              cost_p95: "0.09",
              active_accounts: "2",
            },
          ],
        }),
      );
    });

    const res = await handleMargin(
      marginReq("correct-token"),
      env,
      fetchMock as unknown as typeof fetch,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // 2 windows x (aggregate + top) = 4 SQL calls, hitting the right account URL.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toContain("/accounts/acct123/analytics_engine/sql");

    expect(body.assumedMonthlyRevenueUsd).toBe(19);
    const w = body.windows["7d"];
    expect(w.drafts).toBe(10);
    expect(w.activeAccounts).toBe(2);
    expect(w.estCostUsd).toBeCloseTo(0.5, 6);
    expect(w.estCostPerActiveAccountUsd).toBeCloseTo(0.25, 6);
    expect(w.projectedMonthlyCostPerActiveAccountUsd).toBeCloseTo(0.25 * (365 / 12 / 7), 6);
    expect(w.marginPerActiveAccountUsd).toBeCloseTo(19 - 0.25 * (365 / 12 / 7), 6);
    expect(w.topAccounts[0]).toEqual({ hashedUserId: "hashA", estCostUsd: 0.3, drafts: 5 });
    expect(body.windows["30d"]).toBeDefined();
  });

  it("503s when a SQL query fails", async () => {
    const env = baseEnv({
      ADMIN_TOKEN: "correct-token",
      CF_ANALYTICS_API_TOKEN: "cf-token",
      CF_ACCOUNT_ID: "acct123",
    });
    const fetchMock = vi.fn(() => Promise.resolve(new Response("boom", { status: 500 })));
    const res = await handleMargin(marginReq("correct-token"), env, fetchMock);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.type).toBe("analytics_unavailable");
  });
});
