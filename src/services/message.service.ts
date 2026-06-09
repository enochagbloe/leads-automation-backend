import {
  AuditAction,
  BusinessRole,
  LeadActivityAction,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { AuditInput, auditService } from "./audit.service";
import { cacheService } from "./cache.service";

export type ConversationActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type SystemMessageInput = {
  businessId: string;
  leadId: string;
  conversationId: string;
  content: string;
  metadata?: Prisma.InputJsonValue;
};

export async function createSystemMessage(input: SystemMessageInput, tx: Prisma.TransactionClient = prisma) {
  const now = new Date();
  const message = await tx.message.create({
    data: {
      businessId: input.businessId,
      leadId: input.leadId,
      conversationId: input.conversationId,
      content: input.content,
      metadata: input.metadata,
      senderType: MessageSenderType.SYSTEM,
      messageType: MessageType.SYSTEM,
      direction: MessageDirection.INTERNAL,
      deliveryStatus: MessageDeliveryStatus.INTERNAL,
      readAt: now,
    },
  });
  await tx.conversation.update({
    where: { id: input.conversationId },
    data: { lastMessagePreview: input.content.slice(0, 240), lastMessageAt: message.createdAt },
  });
  await tx.leadActivity.create({
    data: {
      businessId: input.businessId,
      leadId: input.leadId,
      action: LeadActivityAction.MESSAGE_CREATED,
      metadata: { conversationId: input.conversationId, messageId: message.id, senderType: MessageSenderType.SYSTEM },
    },
  });
  return message;
}

async function invalidateMessageCaches(businessId: string, conversationId: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:stats:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:unread:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:detail:${conversationId}:*`),
  ]);
}

export async function createInboundCustomerMessage(input: SystemMessageInput) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, businessId: input.businessId, leadId: input.leadId, deletedAt: null },
  });
  if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        businessId: input.businessId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        content: input.content,
        metadata: input.metadata,
        senderType: MessageSenderType.CUSTOMER,
        messageType: MessageType.TEXT,
        direction: MessageDirection.INBOUND,
        deliveryStatus: MessageDeliveryStatus.DELIVERED,
      },
    });
    await tx.conversation.update({
      where: { id: input.conversationId },
      data: {
        lastMessagePreview: input.content.slice(0, 240),
        lastMessageAt: created.createdAt,
        unreadCount: { increment: 1 },
      },
    });
    await tx.leadActivity.create({
      data: {
        businessId: input.businessId,
        leadId: input.leadId,
        action: LeadActivityAction.MESSAGE_CREATED,
        metadata: { conversationId: input.conversationId, messageId: created.id, senderType: MessageSenderType.CUSTOMER },
      },
    });
    return created;
  });
  await invalidateMessageCaches(input.businessId, input.conversationId);
  return message;
}

export const messageService = {
  async createStaffMessage(
    actor: ConversationActor,
    conversationId: string,
    input: { content: string; messageType: MessageType; senderType: MessageSenderType },
    context: Omit<AuditInput, "action">,
  ) {
    try {
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          businessId: actor.businessId,
          deletedAt: null,
          ...(actor.role === BusinessRole.STAFF ? { assignedStaffId: actor.membershipId } : {}),
        },
      });
      if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
      if (conversation.status === "CLOSED") throw new AppError(422, "Closed conversations cannot receive messages", "INVALID_CONVERSATION_STATUS");

      const message = await prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            businessId: actor.businessId,
            conversationId,
            leadId: conversation.leadId,
            senderType: MessageSenderType.STAFF,
            senderUserId: actor.userId,
            content: input.content,
            messageType: MessageType.TEXT,
            direction: MessageDirection.OUTBOUND,
            deliveryStatus: MessageDeliveryStatus.INTERNAL,
            readAt: new Date(),
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessagePreview: input.content.slice(0, 240), lastMessageAt: created.createdAt },
        });
        await tx.leadActivity.create({
          data: {
            businessId: actor.businessId,
            leadId: conversation.leadId,
            actorUserId: actor.userId,
            action: LeadActivityAction.MESSAGE_CREATED,
            metadata: { conversationId, messageId: created.id, senderType: MessageSenderType.STAFF },
          },
        });
        return created;
      });
      await auditService.log({
        ...context,
        action: AuditAction.MESSAGE_CREATED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: { conversationId, messageId: message.id, leadId: conversation.leadId },
      });
      await invalidateMessageCaches(actor.businessId, conversationId);
      return message;
    } catch (error) {
      await auditService.log({
        ...context,
        action: AuditAction.MESSAGE_CREATE_FAILED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: { conversationId },
      });
      throw error instanceof AppError ? error : new AppError(500, "Message could not be created", "MESSAGE_CREATE_FAILED");
    }
  },
};
