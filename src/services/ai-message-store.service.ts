import { Prisma, ConversationStatus } from "@prisma/client";

/** Canonical persistence only. Delivery, billing and automation belong to callers. */
export async function storeAiReply(tx: Prisma.TransactionClient, data: Prisma.MessageUncheckedCreateInput, status: ConversationStatus, activity: Prisma.InputJsonObject) {
  const created = await tx.message.create({ data });
  await tx.conversation.update({
    where: { id: data.conversationId, businessId: data.businessId, leadId: data.leadId },
    data: { lastMessagePreview: data.content.slice(0, 240), lastMessageAt: created.createdAt, status: status === "OPEN" ? "AI_HANDLING" : status },
  });
  await tx.leadActivity.create({ data: { businessId: data.businessId, leadId: data.leadId, action: "MESSAGE_CREATED", metadata: { source: "AI_REPLY_ENGINE", conversationId: data.conversationId, messageId: created.id, senderType: "AI", direction: "OUTBOUND", ...activity } } });
  return created;
}
