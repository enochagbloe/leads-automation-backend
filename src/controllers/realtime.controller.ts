import { BusinessRole } from "@prisma/client";
import { RequestHandler } from "express";
import { realtimeService } from "../services/realtime.service";

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
    const expiryTimer = setTimeout(() => {
      realtimeService.unsubscribe(client.id);
      res.end();
    }, Math.max(0, req.auth!.accessTokenExpiresAt - Date.now()));
    expiryTimer.unref();

    req.on("close", () => {
      clearTimeout(expiryTimer);
      realtimeService.unsubscribe(client.id);
    });
  }) satisfies RequestHandler,
};
