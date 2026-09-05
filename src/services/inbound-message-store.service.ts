import { LeadActivityAction, MessageDeliveryStatus, MessageDirection, MessageSenderType, MessageType, Prisma } from "@prisma/client";

export type InboundMessageStoreInput = {
  businessId: string; conversationId: string; leadId: string; content: string;
  provider?: string; providerMessageId?: string; metadata?: Prisma.InputJsonValue; createdAt?: Date;
  lastMessagePreview?: string;
  conversationChanges?: Prisma.ConversationUpdateInput;
  activityMetadata?: Prisma.InputJsonObject;
};

// Transactional storage only. Transport adapters own authentication, dedupe and limits.
// No providers, AI, cache, realtime, subscriptions or automation hooks belong here.
export async function storeInboundCustomerMessage(tx: Prisma.TransactionClient, input: InboundMessageStoreInput) {
  const message = await tx.message.create({ data: {
    businessId: input.businessId, conversationId: input.conversationId, leadId: input.leadId,
    content: input.content, senderType: MessageSenderType.CUSTOMER,
    direction: MessageDirection.INBOUND, messageType: MessageType.TEXT, deliveryStatus: MessageDeliveryStatus.DELIVERED,
    provider: input.provider, providerMessageId: input.providerMessageId, metadata: input.metadata, createdAt: input.createdAt,
  } });
  const conversation = await tx.conversation.update({
    where: { id: input.conversationId, businessId: input.businessId, leadId: input.leadId },
    data: { ...input.conversationChanges, lastMessagePreview: input.lastMessagePreview ?? input.content.slice(0, 240), lastMessageAt: message.createdAt, unreadCount: { increment: 1 } },
  });
  await tx.leadActivity.create({ data: {
    businessId: input.businessId, leadId: input.leadId, action: LeadActivityAction.MESSAGE_CREATED,
    metadata: { ...input.activityMetadata, conversationId: input.conversationId, messageId: message.id, senderType: MessageSenderType.CUSTOMER },
  } });
  return { message, conversation };
}
