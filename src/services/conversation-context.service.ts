import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { ConversationScope, conversationStateService } from "./conversation-state.service";

export const conversationContextService = {
  async getSnapshot(input: ConversationScope & { messageId?: string; maxMessages?: number; customerMemorySummary?: string }) {
    const limit = Math.min(50, Math.max(1, Math.floor(input.maxMessages ?? env.AI_MAX_CONTEXT_MESSAGES)));
    if (!Number.isFinite(limit)) throw new AppError(400, "Invalid context window", "CONVERSATION_CONTEXT_INVALID");
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(async tx => {
          const state = await conversationStateService.get(input, tx);
          const currentMessage = input.messageId ? await tx.message.findFirst({ where: { id: input.messageId, businessId: input.businessId, conversationId: input.conversationId, deletedAt: null }, select: { id: true, content: true, createdAt: true, senderType: true } }) : null;
          if (input.messageId && !currentMessage) throw new AppError(403, "Context message forbidden", "CONVERSATION_STATE_FORBIDDEN");
          const rows = await tx.message.findMany({ where: { businessId: input.businessId, conversationId: input.conversationId, deletedAt: null, senderType: { in: ["CUSTOMER", "AI", "STAFF"] }, ...(currentMessage ? { OR: [{ createdAt: { lt: currentMessage.createdAt } }, { createdAt: currentMessage.createdAt, id: { lte: currentMessage.id } }] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit, select: { id: true, content: true, senderType: true, direction: true, createdAt: true } });
          return {
            state,
            currentMessage: currentMessage ? { id: currentMessage.id, text: currentMessage.content.slice(0, 8000), senderType: currentMessage.senderType, createdAt: currentMessage.createdAt.toISOString() } : null,
            recentMessages: rows.reverse().map(m => ({ id: m.id, text: m.content.slice(0, 2000), senderType: m.senderType, direction: m.direction, createdAt: m.createdAt.toISOString() })),
            customerMemorySummary: input.demoSessionId ? null : input.customerMemorySummary?.slice(0, 4000) ?? null,
          };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      } catch (error) {
        // Concurrent lazy initialization can abort a repeatable-read snapshot.
        if (attempt >= 2 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") throw error;
      }
    }
  },
};
export type ConversationContextSnapshot = Awaited<ReturnType<typeof conversationContextService.getSnapshot>>;
