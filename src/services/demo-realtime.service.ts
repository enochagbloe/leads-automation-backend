import { Response } from "express";
import { prisma } from "../config/prisma";
import { DemoActor, assertDemoEnabled } from "./demo.service";
import { canonical, resolveResources } from "./demo-message.service";
import { realtimeService } from "./realtime.service";

async function scope(actor: DemoActor) {
  assertDemoEnabled();
  // Streams are available before business setup. Message/AI writes still require READY.
  return resolveResources(prisma, actor, false);
}

export const demoRealtimeService = {
  async connect(actor: DemoActor, response: Response) {
    const resources = await scope(actor);
    return realtimeService.subscribeDemo({ demoSessionId: actor.demoSessionId, businessId: actor.businessId, conversationId: resources.conversation.id, expiresAt: resources.session.expiresAt.getTime(), response,
      isValid: async () => { const current = await scope(actor); return current.conversation.id === resources.conversation.id && current.lead.id === resources.lead.id; },
    });
  },
  /** Best-effort delivery after commit; never turn a persisted success into an HTTP failure. */
  async message(actor: DemoActor, conversationId: string, message: ReturnType<typeof canonical>) {
    try {
      const current = await scope(actor);
      if (current.conversation.id !== conversationId) return;
      realtimeService.publishDemo({ demoSessionId: actor.demoSessionId, businessId: actor.businessId, conversationId, type: "message.created", payload: { ...message, conversationId } });
      const c = current.conversation;
      realtimeService.publishDemo({ demoSessionId: actor.demoSessionId, businessId: actor.businessId, conversationId, type: "conversation.updated", payload: { id: c.id, conversationId, lastMessagePreview: c.lastMessagePreview, lastMessageAt: c.lastMessageAt, unreadCount: c.unreadCount, status: c.status, updatedAt: c.updatedAt } });
    } catch { /* Recovery is GET history; never retry a committed write for SSE failure. */ }
  },
  async processing(actor: DemoActor, conversationId: string, messageId: string, status: "STARTED" | "COMPLETED" | "FAILED") {
    try {
      const current = await scope(actor);
      if (current.conversation.id !== conversationId) return;
      realtimeService.publishDemo({ demoSessionId: actor.demoSessionId, businessId: actor.businessId, conversationId, type: "demo.ai.processing", payload: { conversationId, messageId, status } });
    } catch { /* Expired/destroyed sessions must not receive late failures. */ }
  },
};
