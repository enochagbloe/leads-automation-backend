import { BusinessRole } from "@prisma/client";
import { RequestHandler } from "express";
import { realtimeService } from "../services/realtime.service";

const MAX_TIMEOUT_MS = 2_147_483_647;

function scheduleAt(timestamp: number, callback: () => void) {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;

  const scheduleNext = () => {
    if (cancelled) return;
    const remaining = timestamp - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(scheduleNext, Math.min(remaining, MAX_TIMEOUT_MS));
    timer.unref();
  };

  scheduleNext();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

export const realtimeController = {
  events: ((req, res) => {
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`event: connected\ndata: ${JSON.stringify({ businessId: req.auth!.businessId, connectedAt: new Date().toISOString() })}\n\n`);

    const client = realtimeService.subscribe({
      businessId: req.auth!.businessId!,
      userId: req.auth!.userId,
      membershipId: req.auth!.membershipId!,
      role: req.auth!.role as BusinessRole,
      response: res,
    });
    const cancelExpiryTimer = scheduleAt(req.auth!.accessTokenExpiresAt, () => {
      realtimeService.unsubscribe(client.id);
      res.end();
    });

    req.on("close", () => {
      cancelExpiryTimer();
      realtimeService.unsubscribe(client.id);
    });
  }) satisfies RequestHandler,
};
