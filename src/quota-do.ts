// AccountQuota Durable Object (56b). One instance per Clerk userId
// (`idFromName(userId)`). Stores ONLY counters and timestamps — never prompts,
// never draft content, never emails.
//
// Storage keys:
//   "window" -> WindowState  (weekly drafts/tokens used + reset timestamps)
//   "rate"   -> number[]     (recent request timestamps, sliding 60s window)
//
// The Worker calls three ops over the DO's internal fetch (see quota-client.ts):
//   POST /check   { now, rateLimitPerMin } -> { allowed, retryAfterSeconds, window }
//   POST /reserve { now, limits } -> { reserved, blockedByQuota, window }
//   POST /settle  { now, reservationWindowStart, tokensDelta } -> { window }
//   POST /release { now, reservationWindowStart } -> { window }
//   POST /peek    { now } -> { window }   (read + roll only; no rate-limit, no increment)

import type { Env } from "./config";
import {
  isOverQuota,
  pruneStamps,
  rollWindow,
  RATE_WINDOW_MS,
  type ResolvedLimits,
  type WindowState,
} from "./metering";

interface CheckBody {
  now: number;
  rateLimitPerMin: number;
}
interface SettleBody {
  now: number;
  reservationWindowStart?: number;
  draftsDelta?: number;
  tokensDelta: number;
}
interface ReserveBody {
  now: number;
  limits: ResolvedLimits;
}
interface ReleaseBody {
  now: number;
  reservationWindowStart: number;
}
interface PeekBody {
  now: number;
}

export class AccountQuota {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState, _env: Env) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/check":
        return this.handleCheck(await request.json<CheckBody>());
      case "/reserve":
        return this.handleReserve(await request.json<ReserveBody>());
      case "/settle":
        return this.handleSettle(await request.json<SettleBody>());
      case "/release":
        return this.handleRelease(await request.json<ReleaseBody>());
      case "/peek":
        return this.handlePeek(await request.json<PeekBody>());
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async loadWindow(now: number): Promise<WindowState> {
    const stored = await this.storage.get<WindowState>("window");
    return rollWindow(stored, now);
  }

  private async handleCheck(body: CheckBody): Promise<Response> {
    const window = await this.loadWindow(body.now);

    let stamps = pruneStamps((await this.storage.get<number[]>("rate")) ?? [], body.now);
    let allowed = true;
    let retryAfterSeconds = 0;
    if (stamps.length >= body.rateLimitPerMin) {
      allowed = false;
      const oldest = stamps[0];
      retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - body.now) / 1000));
    } else {
      stamps = [...stamps, body.now];
    }

    await this.storage.put("window", window);
    await this.storage.put("rate", stamps);
    return Response.json({ allowed, retryAfterSeconds, window });
  }

  private async handleReserve(body: ReserveBody): Promise<Response> {
    const window = await this.loadWindow(body.now);
    if (body.limits.enforcement === "hard" && isOverQuota(window, body.limits)) {
      await this.storage.put("window", window);
      return Response.json({ reserved: false, blockedByQuota: true, window });
    }

    window.draftsUsed += 1;
    await this.storage.put("window", window);
    return Response.json({ reserved: true, blockedByQuota: false, window });
  }

  private async handleSettle(body: SettleBody): Promise<Response> {
    const { window, appliesToStoredReservation } = await this.loadMutationWindow(
      body.now,
      body.reservationWindowStart,
    );
    if (appliesToStoredReservation) {
      window.draftsUsed = Math.max(0, window.draftsUsed + (body.draftsDelta ?? 0));
      window.tokensUsed = Math.max(0, window.tokensUsed + body.tokensDelta);
    }
    await this.storage.put("window", window);
    return Response.json({ window });
  }

  private async handleRelease(body: ReleaseBody): Promise<Response> {
    const { window, appliesToStoredReservation } = await this.loadMutationWindow(
      body.now,
      body.reservationWindowStart,
    );
    if (appliesToStoredReservation) {
      window.draftsUsed = Math.max(0, window.draftsUsed - 1);
    }
    await this.storage.put("window", window);
    return Response.json({ window });
  }

  private async handlePeek(body: PeekBody): Promise<Response> {
    const window = await this.loadWindow(body.now);
    await this.storage.put("window", window);
    return Response.json({ window });
  }

  private async loadMutationWindow(
    now: number,
    reservationWindowStart: number | undefined,
  ): Promise<{ window: WindowState; appliesToStoredReservation: boolean }> {
    const stored = await this.storage.get<WindowState>("window");
    if (reservationWindowStart === undefined) {
      return { window: rollWindow(stored, now), appliesToStoredReservation: true };
    }
    if (stored?.windowStart === reservationWindowStart) {
      return { window: stored, appliesToStoredReservation: true };
    }
    return { window: rollWindow(stored, now), appliesToStoredReservation: false };
  }
}
