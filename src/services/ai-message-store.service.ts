import { ResponseValidationMetadata } from "./conversation-response.schema";
import { conversationStateService } from "./conversation-state.service";
import { StatePatch } from "./conversation-state.schema";
import { Prisma, ConversationStatus, Message } from "@prisma/client";
import { ConversationPlan, conversationPlanSchema } from "./conversation-plan.schema";
import { assistantPlanPatch, assertPlanCurrent } from "./conversation-planner.service";
import { AppError } from "../utils/errors";

/** Canonical persistence only. Delivery, billing and automation belong to callers. */
export async function storeAiReply(tx: Prisma.TransactionClient, data: Prisma.MessageUncheckedCreateInput, status: ConversationStatus, activity: Prisma.InputJsonObject, options?: { demoSessionId?: string; stateChange?: { expectedRevision: number; patch: StatePatch }; plan?: ConversationPlan; response?: { text: string | null; metadata: ResponseValidationMetadata } }) {
  if (options?.plan) {
    const plan = conversationPlanSchema.parse(options.plan);
    if (plan.businessId !== data.businessId || plan.conversationId !== data.conversationId || plan.demoSessionId !== options.demoSessionId) throw new AppError(403, "Plan scope forbidden", "CONVERSATION_STATE_FORBIDDEN");
    // Match inbound persistence's conversation -> state lock order, and serialize staff control changes.
    await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "businessId" = ${data.businessId} AND "id" = ${data.conversationId} FOR UPDATE`;
    await conversationStateService.get(plan, tx);
    await tx.$queryRaw`SELECT "id" FROM "ConversationState" WHERE "businessId" = ${data.businessId} AND "conversationId" = ${data.conversationId} FOR UPDATE`;
    const prior = await tx.message.findFirst({ where: { businessId: data.businessId, conversationId: data.conversationId, senderType: "AI", direction: "OUTBOUND", deletedAt: null, metadata: { path: ["conversationPlan", "sourceMessageId"], equals: plan.sourceMessageId } } });
    if (prior) {
      console.info("conversation_plan.replayed", { businessId: data.businessId, conversationId: data.conversationId, sourceMessageId: plan.sourceMessageId });
      return prior;
    }
    await assertPlanCurrent(plan, tx);
    if (options.stateChange && options.stateChange.expectedRevision !== plan.stateRevision) throw new AppError(409, "Outcome revision differs from plan", "CONVERSATION_STATE_CONFLICT");
    options = { ...options, stateChange: options.stateChange ?? { expectedRevision: plan.stateRevision, patch: assistantPlanPatch(plan, data.content) } };
    const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata as Prisma.InputJsonObject : {};
    data = { ...data, metadata: { ...metadata, conversationPlan: JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonObject } };
  }
  if (options?.response) {
    if (options.response.text?.trim() !== data.content.trim()) throw new AppError(422, "Validated response differs from persisted text", "CONVERSATION_RESPONSE_TEXT_MISMATCH");
    const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata as Prisma.InputJsonObject : {};
    data = { ...data, metadata: { ...metadata, conversationResponse: JSON.parse(JSON.stringify(options.response.metadata)) as Prisma.InputJsonObject } };
  }
  const created = await tx.message.create({ data });
  await tx.conversation.update({
    where: { id: data.conversationId, businessId: data.businessId, leadId: data.leadId },
    data: { lastMessagePreview: data.content.slice(0, 240), lastMessageAt: created.createdAt, status: status === "OPEN" ? "AI_HANDLING" : status },
  });
  await tx.leadActivity.create({ data: { businessId: data.businessId, leadId: data.leadId, action: "MESSAGE_CREATED", metadata: { source: "AI_REPLY_ENGINE", conversationId: data.conversationId, messageId: created.id, senderType: "AI", direction: "OUTBOUND", ...activity } } });
  await conversationStateService.recordMessage({ businessId: data.businessId, conversationId: data.conversationId, demoSessionId: options?.demoSessionId }, created.id, "AI_INTERPRETATION", tx, options?.stateChange);

  return created;
}

/** Call only after the enclosing message/state transaction has committed. */
export function logConversationResponsePersisted(message: Message) {
  const metadata = message.metadata as Prisma.JsonObject | null;
  const response = metadata?.conversationResponse as Prisma.JsonObject | undefined;
  const plan = metadata?.conversationPlan as Prisma.JsonObject | undefined;
  if (response) console.info("conversation_response.persisted", {
    businessId: message.businessId, conversationId: message.conversationId, sourceMessageId: plan?.sourceMessageId,
    planMove: plan?.move, planPurpose: plan?.responseDirective && typeof plan.responseDirective === "object" && !Array.isArray(plan.responseDirective) ? plan.responseDirective.purpose : undefined,
    validationOutcome: "VALID", ...response,
  });
}
