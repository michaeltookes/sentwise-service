import { describe, it, expect } from "vitest";
import {
  adjustedTransactionIdFromEvent,
  adjustmentIdFromEvent,
  buildSubscriptionRecord,
  clerkUserIdFromEvent,
  computeHmacSha256Hex,
  customerIdFromEvent,
  HANDLED_EVENT_TYPES,
  isApprovedOverageAdjustment,
  isAdjustmentEvent,
  isApprovedOverageReversal,
  isApprovedOverageRestore,
  isSubscriptionEvent,
  normalizeIso,
  overageAdjustmentFromEvent,
  overageCreditFromEvent,
  overageDraftsFromEvent,
  parsePaddleEvent,
  parsePaddleSignatureHeader,
  planFromEvent,
  priceIdsFromEvent,
  resolvePlanDraftLimit,
  statusFromEvent,
  subscriptionIdFromEvent,
  transactionIdFromEvent,
  timingSafeEqualHex,
  verifyPaddleSignature,
} from "../src/paddle";
import {
  DEFAULT_PRO_DRAFT_LIMIT,
  DEFAULT_STARTER_DRAFT_LIMIT,
  DEFAULT_UNLIMITED_DRAFT_LIMIT,
} from "../src/config";

const SECRET = "pdl_ntfset_testsecret";
const STARTER_PRICE = "pri_01m1syd7nfarp8pggpcnvjbgyy";
const PRO_PRICE = "pri_01m1symsxarc4c3jdea0ntb09w";
const UNLIMITED_PRICE = "pri_01m1syrdg05f49kz705gbzn6tz";

/** Build a signed Paddle-Signature header for `rawBody` at `tsSeconds`. */
async function signHeader(rawBody: string, tsSeconds: number, secret = SECRET): Promise<string> {
  const h1 = await computeHmacSha256Hex(secret, `${tsSeconds}:${rawBody}`);
  return `ts=${tsSeconds};h1=${h1}`;
}

function subscriptionEventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "evt_sub_1",
    event_type: "subscription.created",
    occurred_at: "2026-09-05T10:00:00.000Z",
    notification_id: "ntf_1",
    data: {
      id: "sub_123",
      status: "active",
      customer_id: "ctm_123",
      next_billed_at: "2026-10-05T10:00:00.000Z",
      custom_data: { clerkUserId: "user_abc" },
      items: [{ price: { id: PRO_PRICE }, quantity: 1 }],
      ...overrides,
    },
  });
}

describe("parsePaddleSignatureHeader", () => {
  it("parses ts and h1", () => {
    expect(parsePaddleSignatureHeader("ts=1671552777;h1=abcdef01")).toEqual({
      ts: 1671552777,
      h1: "abcdef01",
    });
  });

  it("tolerates whitespace and extra elements", () => {
    expect(parsePaddleSignatureHeader(" ts=100 ; h1=deadbeef ; other=x")).toEqual({
      ts: 100,
      h1: "deadbeef",
    });
  });

  it("rejects missing/garbage headers", () => {
    expect(parsePaddleSignatureHeader(null)).toBeNull();
    expect(parsePaddleSignatureHeader("")).toBeNull();
    expect(parsePaddleSignatureHeader("h1=abc")).toBeNull(); // no ts
    expect(parsePaddleSignatureHeader("ts=abc;h1=deadbeef")).toBeNull(); // non-numeric ts
    expect(parsePaddleSignatureHeader("ts=100;h1=nothex!")).toBeNull(); // non-hex h1
  });
});

describe("timingSafeEqualHex", () => {
  it("is true only for identical equal-length strings", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abcde")).toBe(false);
  });
});

describe("verifyPaddleSignature", () => {
  const now = Date.parse("2026-09-05T10:00:05.000Z");
  const ts = Math.floor(now / 1000);

  it("accepts a correctly signed, fresh payload", async () => {
    const body = subscriptionEventBody();
    const header = await signHeader(body, ts);
    await expect(verifyPaddleSignature(body, header, SECRET, now, 300)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects a tampered body (mismatch)", async () => {
    const body = subscriptionEventBody();
    const header = await signHeader(body, ts);
    const tampered = body.replace("sub_123", "sub_evil");
    await expect(verifyPaddleSignature(tampered, header, SECRET, now, 300)).resolves.toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects the wrong secret (mismatch)", async () => {
    const body = subscriptionEventBody();
    const header = await signHeader(body, ts, "pdl_ntfset_other");
    await expect(verifyPaddleSignature(body, header, SECRET, now, 300)).resolves.toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a stale timestamp beyond the tolerance", async () => {
    const body = subscriptionEventBody();
    const staleTs = Math.floor((now - 10 * 60_000) / 1000); // 10 min old
    const header = await signHeader(body, staleTs);
    await expect(verifyPaddleSignature(body, header, SECRET, now, 300)).resolves.toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("rejects a future timestamp beyond the tolerance", async () => {
    const body = subscriptionEventBody();
    const futureTs = Math.floor((now + 10 * 60_000) / 1000);
    const header = await signHeader(body, futureTs);
    await expect(verifyPaddleSignature(body, header, SECRET, now, 300)).resolves.toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("rejects a malformed header and a missing secret", async () => {
    const body = subscriptionEventBody();
    await expect(verifyPaddleSignature(body, "garbage", SECRET, now, 300)).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
    await expect(
      verifyPaddleSignature(body, await signHeader(body, ts), "", now, 300),
    ).resolves.toEqual({
      ok: false,
      reason: "no_secret",
    });
  });

  it("signs over the EXACT raw body (byte-for-byte), not a re-serialization", async () => {
    // Extra whitespace that JSON.parse would collapse must still verify.
    const body = '{"event_id":"e",  "event_type":"subscription.updated","data":{"id":"s"}}';
    const header = await signHeader(body, ts);
    await expect(verifyPaddleSignature(body, header, SECRET, now, 300)).resolves.toEqual({
      ok: true,
    });
  });
});

describe("parsePaddleEvent", () => {
  it("parses a well-formed event", () => {
    const event = parsePaddleEvent(subscriptionEventBody());
    expect(event).toMatchObject({
      eventId: "evt_sub_1",
      eventType: "subscription.created",
      occurredAt: "2026-09-05T10:00:00.000Z",
    });
    expect(event?.data.id).toBe("sub_123");
  });

  it("returns null on invalid JSON or missing required fields", () => {
    expect(parsePaddleEvent("not json")).toBeNull();
    expect(parsePaddleEvent(JSON.stringify({ event_type: "x", data: {} }))).toBeNull(); // no event_id
    expect(parsePaddleEvent(JSON.stringify({ event_id: "x", data: {} }))).toBeNull(); // no event_type
    expect(parsePaddleEvent(JSON.stringify({ event_id: "x", event_type: "y" }))).toBeNull(); // no data
  });
});

describe("field extraction", () => {
  it("reads clerkUserId, customer id, subscription id, and price ids", () => {
    const event = parsePaddleEvent(subscriptionEventBody())!;
    expect(clerkUserIdFromEvent(event)).toBe("user_abc");
    expect(customerIdFromEvent(event)).toBe("ctm_123");
    expect(subscriptionIdFromEvent(event)).toBe("sub_123");
    expect(priceIdsFromEvent(event)).toEqual([PRO_PRICE]);
  });

  it("returns null clerkUserId when custom_data lacks it", () => {
    const event = parsePaddleEvent(subscriptionEventBody({ custom_data: {} }))!;
    expect(clerkUserIdFromEvent(event)).toBeNull();
  });

  it("isSubscriptionEvent distinguishes subscription.* from transaction.*", () => {
    expect(isSubscriptionEvent("subscription.updated")).toBe(true);
    expect(isSubscriptionEvent("transaction.completed")).toBe(false);
  });

  it("reads transaction and adjustment ids", () => {
    const transaction = parsePaddleEvent(
      JSON.stringify({
        event_id: "evt_txn",
        event_type: "transaction.completed",
        data: { id: "txn_123" },
      }),
    )!;
    expect(transactionIdFromEvent(transaction)).toBe("txn_123");

    const adjustment = parsePaddleEvent(
      JSON.stringify({
        event_id: "evt_adj",
        event_type: "adjustment.updated",
        data: { id: "adj_123", transaction_id: "txn_123" },
      }),
    )!;
    expect(adjustmentIdFromEvent(adjustment)).toBe("adj_123");
    expect(adjustedTransactionIdFromEvent(adjustment)).toBe("txn_123");
  });
});

describe("handled event types", () => {
  it("includes activation, pause/resume, and adjustment lifecycle events", () => {
    expect(HANDLED_EVENT_TYPES).toContain("subscription.activated");
    expect(HANDLED_EVENT_TYPES).toContain("subscription.paused");
    expect(HANDLED_EVENT_TYPES).toContain("subscription.resumed");
    expect(HANDLED_EVENT_TYPES).toContain("adjustment.created");
    expect(HANDLED_EVENT_TYPES).toContain("adjustment.updated");
    expect(isAdjustmentEvent("adjustment.created")).toBe(true);
    expect(isAdjustmentEvent("transaction.completed")).toBe(false);
  });
});

describe("planFromEvent (price -> tier map)", () => {
  it("maps each sandbox price id to its tier", () => {
    for (const [price, plan] of [
      [STARTER_PRICE, "starter"],
      [PRO_PRICE, "pro"],
      [UNLIMITED_PRICE, "unlimited"],
    ] as const) {
      const event = parsePaddleEvent(
        subscriptionEventBody({ items: [{ price: { id: price }, quantity: 1 }] }),
      )!;
      expect(planFromEvent(event)).toEqual({ plan, priceId: price });
    }
  });

  it("returns null for an unknown price id", () => {
    const event = parsePaddleEvent(
      subscriptionEventBody({ items: [{ price: { id: "pri_unknown" }, quantity: 1 }] }),
    )!;
    expect(planFromEvent(event)).toBeNull();
  });

  it("picks the first item that maps to a known tier", () => {
    const event = parsePaddleEvent(
      subscriptionEventBody({
        items: [
          { price: { id: "pri_unknown" }, quantity: 1 },
          { price: { id: STARTER_PRICE }, quantity: 1 },
        ],
      }),
    )!;
    expect(planFromEvent(event)).toEqual({ plan: "starter", priceId: STARTER_PRICE });
  });
});

describe("statusFromEvent", () => {
  it("prefers the entity status", () => {
    expect(statusFromEvent(parsePaddleEvent(subscriptionEventBody({ status: "active" }))!)).toBe(
      "active",
    );
    expect(statusFromEvent(parsePaddleEvent(subscriptionEventBody({ status: "trialing" }))!)).toBe(
      "trialing",
    );
    expect(statusFromEvent(parsePaddleEvent(subscriptionEventBody({ status: "past_due" }))!)).toBe(
      "past_due",
    );
    expect(statusFromEvent(parsePaddleEvent(subscriptionEventBody({ status: "canceled" }))!)).toBe(
      "canceled",
    );
    // "paused" maps to canceled for access purposes.
    expect(statusFromEvent(parsePaddleEvent(subscriptionEventBody({ status: "paused" }))!)).toBe(
      "canceled",
    );
  });

  it("falls back to the event type when entity status is absent/unknown", () => {
    const canceled = JSON.stringify({
      event_id: "e",
      event_type: "subscription.canceled",
      data: { id: "s", items: [{ price: { id: PRO_PRICE } }] },
    });
    expect(statusFromEvent(parsePaddleEvent(canceled)!)).toBe("canceled");
    const pastDue = JSON.stringify({
      event_id: "e",
      event_type: "subscription.past_due",
      data: { id: "s", items: [{ price: { id: PRO_PRICE } }] },
    });
    expect(statusFromEvent(parsePaddleEvent(pastDue)!)).toBe("past_due");
    const paused = JSON.stringify({
      event_id: "e",
      event_type: "subscription.paused",
      data: { id: "s", items: [{ price: { id: PRO_PRICE } }] },
    });
    expect(statusFromEvent(parsePaddleEvent(paused)!)).toBe("canceled");
    const resumed = JSON.stringify({
      event_id: "e",
      event_type: "subscription.resumed",
      data: { id: "s", items: [{ price: { id: PRO_PRICE } }] },
    });
    expect(statusFromEvent(parsePaddleEvent(resumed)!)).toBe("active");
    const activated = JSON.stringify({
      event_id: "e",
      event_type: "subscription.activated",
      data: { id: "s", items: [{ price: { id: PRO_PRICE } }] },
    });
    expect(statusFromEvent(parsePaddleEvent(activated)!)).toBe("active");
  });
});

describe("isApprovedOverageReversal", () => {
  function adjustment(data: Record<string, unknown>): ReturnType<typeof parsePaddleEvent> {
    return parsePaddleEvent(
      JSON.stringify({ event_id: "evt_adj", event_type: "adjustment.updated", data }),
    );
  }

  it("requires an approved refund, chargeback, or credit adjustment", () => {
    expect(isApprovedOverageReversal(adjustment({ action: "refund", status: "approved" })!)).toBe(
      true,
    );
    expect(
      isApprovedOverageReversal(adjustment({ action: "chargeback", status: "approved" })!),
    ).toBe(true);
    expect(isApprovedOverageReversal(adjustment({ action: "credit", status: "approved" })!)).toBe(
      true,
    );
    expect(
      isApprovedOverageReversal(adjustment({ action: "refund", status: "pending_approval" })!),
    ).toBe(false);
    expect(
      isApprovedOverageReversal(adjustment({ action: "chargeback_warning", status: "approved" })!),
    ).toBe(false);
  });

  it("recognizes approved restore adjustments separately", () => {
    const restored = adjustment({ action: "chargeback_reverse", status: "approved" })!;
    expect(isApprovedOverageReversal(restored)).toBe(false);
    expect(isApprovedOverageRestore(restored)).toBe(true);
    expect(isApprovedOverageAdjustment(restored)).toBe(true);
  });

  it("extracts partial adjustment item details", () => {
    const event = adjustment({
      action: "refund",
      status: "approved",
      type: "partial",
      items: [{ item_id: "txnitm_123", type: "partial", amount: "1000" }],
    })!;
    expect(overageAdjustmentFromEvent(event)).toEqual({
      action: "refund",
      adjustmentType: "partial",
      items: [{ transactionItemId: "txnitm_123", type: "partial", amount: 1000 }],
    });
  });
});

describe("normalizeIso", () => {
  it("normalizes microsecond / offset timestamps to canonical ISO-millis", () => {
    expect(normalizeIso("2026-10-05T10:00:00.123456Z")).toBe("2026-10-05T10:00:00.123Z");
    expect(normalizeIso("2026-10-05T10:00:00Z")).toBe("2026-10-05T10:00:00.000Z");
  });

  it("returns null for junk", () => {
    expect(normalizeIso("nope")).toBeNull();
    expect(normalizeIso(undefined)).toBeNull();
    expect(normalizeIso(42)).toBeNull();
  });
});

describe("resolvePlanDraftLimit", () => {
  it("uses env vars when present", () => {
    const env = { STARTER_DRAFT_LIMIT: "25", PRO_DRAFT_LIMIT: 200, UNLIMITED_DRAFT_LIMIT: "9999" };
    expect(resolvePlanDraftLimit(env, "starter")).toBe(25);
    expect(resolvePlanDraftLimit(env, "pro")).toBe(200);
    expect(resolvePlanDraftLimit(env, "unlimited")).toBe(9999);
  });

  it("falls back to placeholder defaults", () => {
    expect(resolvePlanDraftLimit({}, "starter")).toBe(DEFAULT_STARTER_DRAFT_LIMIT);
    expect(resolvePlanDraftLimit({}, "pro")).toBe(DEFAULT_PRO_DRAFT_LIMIT);
    expect(resolvePlanDraftLimit({}, "unlimited")).toBe(DEFAULT_UNLIMITED_DRAFT_LIMIT);
  });
});

describe("overageDraftsFromEvent", () => {
  function txn(data: Record<string, unknown>): ReturnType<typeof parsePaddleEvent> {
    return parsePaddleEvent(
      JSON.stringify({
        event_id: "evt_txn",
        event_type: "transaction.completed",
        data: { id: "txn_123", ...data },
      }),
    );
  }

  it("credits nothing for a non-transaction event", () => {
    const sub = parsePaddleEvent(subscriptionEventBody())!;
    expect(overageDraftsFromEvent(sub, {})).toBe(0);
  });

  it("credits nothing for a plain transaction (a subscription renewal)", () => {
    const event = txn({ items: [{ price: { id: PRO_PRICE }, quantity: 1 }] })!;
    expect(overageDraftsFromEvent(event, {})).toBe(0);
  });

  it("ignores buyer-supplied custom_data.extraDrafts without the configured overage price", () => {
    const event = txn({ custom_data: { kind: "overage", extraDrafts: 50 }, items: [] })!;
    expect(overageDraftsFromEvent(event, {})).toBe(0);
  });

  it("sums quantities of the configured overage price id", () => {
    const event = txn({
      items: [
        { price: { id: "pri_overage" }, quantity: 3 },
        { price: { id: "pri_overage" }, quantity: 2 },
        { price: { id: PRO_PRICE }, quantity: 1 }, // ignored
      ],
    })!;
    expect(overageDraftsFromEvent(event, { EXTRA_DRAFTS_PRICE_ID: "pri_overage" })).toBe(5);
  });

  it("multiplies matched quantity by EXTRA_DRAFTS_PER_UNIT", () => {
    const event = txn({ items: [{ price: { id: "pri_overage" }, quantity: 2 }] })!;
    expect(
      overageDraftsFromEvent(event, {
        EXTRA_DRAFTS_PRICE_ID: "pri_overage",
        EXTRA_DRAFTS_PER_UNIT: 10,
      }),
    ).toBe(20);
  });

  it("derives credit from line items rather than buyer-supplied custom_data.extraDrafts", () => {
    const event = txn({
      custom_data: { kind: "overage", extraDrafts: 1_000_000 },
      items: [{ price: { id: "pri_overage" }, quantity: 2 }],
    })!;
    expect(
      overageDraftsFromEvent(event, {
        EXTRA_DRAFTS_PRICE_ID: "pri_overage",
        EXTRA_DRAFTS_PER_UNIT: 10,
      }),
    ).toBe(20);
  });

  it("does not credit an overage-kind purchase with no matching price item", () => {
    const event = txn({ custom_data: { kind: "overage" }, items: [] })!;
    expect(overageDraftsFromEvent(event, { EXTRA_DRAFTS_PRICE_ID: "pri_overage" })).toBe(0);
  });

  it("prefers details.line_items so partial adjustments can target transaction items", () => {
    const event = txn({
      items: [{ price: { id: "pri_overage" }, quantity: 100 }],
      details: {
        line_items: [
          {
            id: "txnitm_123",
            price_id: "pri_overage",
            quantity: 2,
            totals: { total: "5000" },
          },
        ],
      },
    })!;
    expect(
      overageCreditFromEvent(event, {
        EXTRA_DRAFTS_PRICE_ID: "pri_overage",
        EXTRA_DRAFTS_PER_UNIT: 10,
      }),
    ).toEqual({
      extraDrafts: 20,
      credits: [{ transactionItemId: "txnitm_123", extraDrafts: 20, amount: 5000 }],
    });
  });
});

describe("buildSubscriptionRecord", () => {
  it("assembles the stored record with normalized timestamps and reconciliation ids", () => {
    const event = parsePaddleEvent(
      subscriptionEventBody({ next_billed_at: "2026-10-05T10:00:00.500000Z" }),
    )!;
    const record = buildSubscriptionRecord(
      event,
      "pro",
      PRO_PRICE,
      Date.parse("2026-09-05T10:00:05.000Z"),
    );
    expect(record).toEqual({
      plan: "pro",
      status: "active",
      renewsAt: "2026-10-05T10:00:00.500Z",
      manageBillingUrl: null,
      paddleSubscriptionId: "sub_123",
      paddleCustomerId: "ctm_123",
      priceId: PRO_PRICE,
      updatedAt: "2026-09-05T10:00:00.000Z", // from occurred_at
      lastEventId: "evt_sub_1",
    });
  });

  it("falls back updatedAt to now when occurred_at is absent", () => {
    const raw = JSON.stringify({
      event_id: "e2",
      event_type: "subscription.updated",
      data: { id: "s2", status: "active", items: [{ price: { id: STARTER_PRICE } }] },
    });
    const event = parsePaddleEvent(raw)!;
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const record = buildSubscriptionRecord(event, "starter", STARTER_PRICE, now);
    expect(record.updatedAt).toBe("2026-09-05T12:00:00.000Z");
    expect(record.renewsAt).toBeNull();
    expect(record.manageBillingUrl).toBeNull();
  });
});
