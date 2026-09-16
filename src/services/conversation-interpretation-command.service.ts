import { conversationTransactionOptions } from "./conversation-transaction";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { assertConversationScope, ConversationScope, conversationStateService } from "./conversation-state.service";
import { interpretationSchema } from "./conversation-interpretation.schema";
import { planInterpretation } from "./conversation-interpretation-policy";

export type InterpretationScope = ConversationScope & { sourceMessageId: string };
async function source(db: Prisma.TransactionClient, input: InterpretationScope) {
  z.string().min(1).max(128).parse(input.sourceMessageId);
  const conversation = await assertConversationScope(db, input);
  const message = await db.message.findFirst({ where: { id: input.sourceMessageId, businessId: input.businessId, conversationId: input.conversationId, senderType: "CUSTOMER", direction: "INBOUND", deletedAt: null }, select: { id: true, content: true, senderType: true, createdAt: true } });
  if (!message) throw new AppError(403, "Interpretation source forbidden", "CONVERSATION_STATE_FORBIDDEN");
  return { conversation, message };
}
export const conversationInterpretationCommandService = {
  async getReplay(input: InterpretationScope) {
    return prisma.$transaction(async tx => {
      await source(tx, input);
      const receipt = await tx.conversationInterpretation.findFirst({ where: { businessId: input.businessId, conversationId: input.conversationId, sourceMessageId: input.sourceMessageId } });
      return receipt ? { interpretation: interpretationSchema.parse(receipt.result), appliedRevision: receipt.appliedRevision } : null;
    }, conversationTransactionOptions());
  },
  async apply(input: InterpretationScope & { snapshotRevision: number; interpretation: unknown }) {
    z.number().int().nonnegative().parse(input.snapshotRevision);
    const interpretation = interpretationSchema.parse(input.interpretation);
    if (Buffer.byteLength(JSON.stringify(interpretation)) > 24000) throw new AppError(400, "Interpretation exceeds size limit", "CONVERSATION_INTERPRETATION_INVALID");
    const result = await prisma.$transaction(async tx => {
      const { conversation, message } = await source(tx, input);
      await conversationStateService.get(input, tx);
      await tx.$queryRaw`SELECT "id" FROM "ConversationState" WHERE "businessId" = ${input.businessId} AND "conversationId" = ${input.conversationId} FOR UPDATE`;
      const state = await conversationStateService.get(input, tx);
      const receipt = await tx.conversationInterpretation.findFirst({ where: { businessId: input.businessId, conversationId: input.conversationId, sourceMessageId: input.sourceMessageId } });
      if (receipt) return { interpretation: interpretationSchema.parse(receipt.result), appliedRevision: receipt.appliedRevision, commands: [], replayed: true };
      if (state.revision !== input.snapshotRevision) throw new AppError(409, "Conversation changed during interpretation; reload and reinterpret", "CONVERSATION_STATE_CONFLICT");
      // Reload evidence from the database: the model cannot supply its own transcript.
      const history = await tx.message.findMany({ where: { businessId: input.businessId, conversationId: input.conversationId, deletedAt: null, senderType: { in: ["CUSTOMER", "AI", "STAFF"] }, OR: [{ createdAt: { lt: message.createdAt } }, { createdAt: message.createdAt, id: { lte: message.id } }] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, content: true, createdAt: true, senderType: true, direction: true } });
      const planned = planInterpretation({ state, timezone: conversation.business.timezone, currentMessage: { id: message.id, text: message.content, createdAt: message.createdAt.toISOString(), senderType: message.senderType }, recentMessages: history.reverse().map(m => ({ id: m.id, text: m.content, createdAt: m.createdAt.toISOString(), senderType: m.senderType, direction: m.direction })), customerMemorySummary: null }, interpretation);
      const updated = planned.commands.length ? await conversationStateService.patch({ ...input, expectedRevision: input.snapshotRevision, source: "AI_INTERPRETATION", sourceEffectId: `interpretation:v1:${message.id}` }, planned.patch, tx) : state;
      await tx.conversationInterpretation.create({ data: { businessId: input.businessId, conversationId: input.conversationId, sourceMessageId: message.id, snapshotRevision: input.snapshotRevision, appliedRevision: updated.revision, result: planned.interpretation as Prisma.InputJsonObject } });
      return { interpretation: planned.interpretation, appliedRevision: updated.revision, commands: planned.commands, replayed: false };
    }, conversationTransactionOptions());
    return result;
  },
};
