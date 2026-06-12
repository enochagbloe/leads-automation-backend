import {
  AuditAction,
  BusinessRole,
  ConversationChannel,
  ConversationStatus,
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
import { getWhatsAppIntegration, whatsappProvider, WhatsAppSendResult } from "./whatsapp-provider.service";
import { realtimeService } from "./realtime.service";

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

async function invalidateOutboundCaches(businessId: string, conversationId: string, leadId: string) {
  await Promise.all([
    invalidateMessageCaches(businessId, conversationId),
    cacheService.delByPattern(`business:${businessId}:leads:detail:${leadId}*`),
  ]);
}

function metadataWith(existing: Prisma.JsonValue | null, values: Record<string, Prisma.JsonValue>): Prisma.InputJsonValue {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  return { ...base, ...values };
}

function providerError(result: WhatsAppSendResult) {
  return (result.error ?? "WhatsApp provider send failed").slice(0, 500);
}

async function accessibleConversation(actor: ConversationActor, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, businessId: actor.businessId, deletedAt: null },
    include: { lead: { select: { phone: true } } },
  });
  if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  if (actor.role === BusinessRole.STAFF && conversation.assignedStaffId !== actor.membershipId) {
    throw new AppError(403, "You do not have access to this conversation", "FORBIDDEN");
  }
  return conversation;
}

async function settleWhatsAppMessage(
  actor: ConversationActor,
  message: { id: string; businessId: string; conversationId: string; leadId: string; content: string; metadata: Prisma.JsonValue | null },
  phoneNumberId: string,
  customerPhone: string,
  assignedStaffId: string | null,
  context: Omit<AuditInput, "action">,
) {
  const result = await whatsappProvider.sendTextMessage({
    phoneNumberId,
    to: customerPhone,
    message: message.content,
    businessId: actor.businessId,
    conversationId: message.conversationId,
    messageId: message.id,
  });
  const deliveryStatus = result.success ? MessageDeliveryStatus.SENT : MessageDeliveryStatus.FAILED;
  const updated = await prisma.$transaction(async (tx) => {
    const record = await tx.message.update({
      where: { id: message.id },
      data: {
        deliveryStatus,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        metadata: metadataWith(message.metadata, {
          provider: result.provider,
          providerMessageId: result.providerMessageId ?? null,
          deliveryStatus,
          ...(result.success ? {} : { error: providerError(result) }),
        }),
      },
    });
    await tx.leadActivity.create({
      data: {
        businessId: actor.businessId,
        leadId: message.leadId,
        actorUserId: actor.userId,
        action: result.success ? LeadActivityAction.MESSAGE_SENT : LeadActivityAction.MESSAGE_SEND_FAILED,
        metadata: {
          conversationId: message.conversationId,
          messageId: message.id,
          provider: result.provider,
          providerMessageId: result.providerMessageId ?? null,
          ...(result.success ? {} : { error: providerError(result) }),
        },
      },
    });
    return record;
  });
  await Promise.all([
    auditService.log({
      ...context,
      action: result.success ? AuditAction.WHATSAPP_MESSAGE_SENT : AuditAction.WHATSAPP_MESSAGE_SEND_FAILED,
      businessId: actor.businessId,
      userId: actor.userId,
      metadata: {
        businessId: actor.businessId,
        conversationId: message.conversationId,
        messageId: message.id,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        provider: result.provider,
        providerMessageId: result.providerMessageId ?? null,
        deliveryStatus,
        ...(result.success ? {} : { error: providerError(result) }),
      },
    }),
    invalidateOutboundCaches(actor.businessId, message.conversationId, message.leadId),
  ]);
  realtimeService.publish({
    type: "message.status.updated",
    businessId: actor.businessId,
    conversationId: message.conversationId,
    leadId: message.leadId,
    messageId: message.id,
    assignedStaffId,
    payload: {
      messageId: message.id,
      conversationId: message.conversationId,
      previousStatus: message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? message.metadata.deliveryStatus ?? MessageDeliveryStatus.PENDING
        : MessageDeliveryStatus.PENDING,
      newStatus: updated.deliveryStatus,
      readAt: updated.readAt,
      updatedAt: updated.updatedAt,
    },
  });
  return updated;
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
      const conversation = await accessibleConversation(actor, conversationId);
      if (conversation.status === ConversationStatus.CLOSED) throw new AppError(422, "Cannot send a message to a closed conversation.", "CONVERSATION_CLOSED");
      const integration = conversation.channel === ConversationChannel.WHATSAPP
        ? await getWhatsAppIntegration(actor.businessId)
        : null;

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
            deliveryStatus: integration ? MessageDeliveryStatus.PENDING : MessageDeliveryStatus.INTERNAL,
            readAt: integration ? null : new Date(),
            metadata: {
              source: "BIZREPLY_APP",
              channel: conversation.channel,
              senderType: MessageSenderType.STAFF,
              direction: MessageDirection.OUTBOUND,
              deliveryStatus: integration ? MessageDeliveryStatus.PENDING : MessageDeliveryStatus.INTERNAL,
            },
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
            metadata: {
              source: "BIZREPLY_APP",
              channel: conversation.channel,
              conversationId,
              messageId: created.id,
              senderType: MessageSenderType.STAFF,
              direction: MessageDirection.OUTBOUND,
              deliveryStatus: created.deliveryStatus,
            },
          },
        });
        return created;
      });
      await auditService.log({
        ...context,
        action: AuditAction.MESSAGE_CREATED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: {
          conversationId,
          messageId: message.id,
          leadId: conversation.leadId,
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId,
          channel: conversation.channel,
          deliveryStatus: message.deliveryStatus,
        },
      });
      realtimeService.publish({
        type: "message.created",
        businessId: actor.businessId,
        conversationId,
        leadId: conversation.leadId,
        messageId: message.id,
        assignedStaffId: conversation.assignedStaffId,
        payload: {
          message,
          conversation: {
            id: conversation.id,
            lastMessagePreview: message.content.slice(0, 240),
            lastMessageAt: message.createdAt,
            unreadCount: conversation.unreadCount,
            status: conversation.status,
          },
        },
      });
      realtimeService.publish({
        type: "conversation.updated",
        businessId: actor.businessId,
        conversationId,
        leadId: conversation.leadId,
        assignedStaffId: conversation.assignedStaffId,
        payload: { conversationId, changes: { lastMessagePreview: message.content.slice(0, 240), lastMessageAt: message.createdAt } },
      });
      if (integration) return settleWhatsAppMessage(actor, message, integration.phoneNumberId, conversation.lead.phone, conversation.assignedStaffId, context);
      await invalidateOutboundCaches(actor.businessId, conversationId, conversation.leadId);
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

  async retryWhatsAppMessage(
    actor: ConversationActor,
    conversationId: string,
    messageId: string,
    context: Omit<AuditInput, "action">,
  ) {
    const conversation = await accessibleConversation(actor, conversationId);
    if (conversation.status === ConversationStatus.CLOSED) throw new AppError(422, "Cannot send a message to a closed conversation.", "CONVERSATION_CLOSED");
    const message = await prisma.message.findFirst({
      where: { id: messageId, conversationId, businessId: actor.businessId, deletedAt: null },
    });
    if (!message) throw new AppError(404, "Message not found", "MESSAGE_NOT_FOUND");
    if (
      conversation.channel !== ConversationChannel.WHATSAPP
      || message.senderType !== MessageSenderType.STAFF
      || message.direction !== MessageDirection.OUTBOUND
      || message.messageType !== MessageType.TEXT
      || message.deliveryStatus !== MessageDeliveryStatus.FAILED
    ) {
      throw new AppError(422, "Only failed outbound WhatsApp text messages can be retried.", "MESSAGE_NOT_RETRYABLE");
    }
    const integration = await getWhatsAppIntegration(actor.businessId);
    const retryCount = typeof message.metadata === "object" && message.metadata && !Array.isArray(message.metadata)
      && typeof message.metadata.retryCount === "number" ? message.metadata.retryCount + 1 : 1;
    const pending = await prisma.$transaction(async (tx) => {
      const claimed = await tx.message.updateMany({
        where: { id: message.id, deliveryStatus: MessageDeliveryStatus.FAILED },
        data: {
          deliveryStatus: MessageDeliveryStatus.PENDING,
          providerMessageId: null,
          metadata: metadataWith(message.metadata, { deliveryStatus: MessageDeliveryStatus.PENDING, retryCount, error: null }),
        },
      });
      if (claimed.count !== 1) {
        throw new AppError(422, "Only failed outbound WhatsApp text messages can be retried.", "MESSAGE_NOT_RETRYABLE");
      }
      const record = await tx.message.findUniqueOrThrow({ where: { id: message.id } });
      await tx.leadActivity.create({
        data: {
          businessId: actor.businessId,
          leadId: conversation.leadId,
          actorUserId: actor.userId,
          action: LeadActivityAction.MESSAGE_RETRY_ATTEMPTED,
          metadata: { conversationId, messageId, retryCount },
        },
      });
      return record;
    });
    await auditService.log({
      ...context,
      action: AuditAction.WHATSAPP_MESSAGE_RETRIED,
      businessId: actor.businessId,
      userId: actor.userId,
      metadata: {
        businessId: actor.businessId,
        conversationId,
        messageId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        retryCount,
      },
    });
    await invalidateOutboundCaches(actor.businessId, conversationId, conversation.leadId);
    realtimeService.publish({
      type: "message.status.updated",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      messageId,
      assignedStaffId: conversation.assignedStaffId,
      payload: { messageId, conversationId, previousStatus: MessageDeliveryStatus.FAILED, newStatus: MessageDeliveryStatus.PENDING, readAt: pending.readAt, updatedAt: pending.updatedAt },
    });
    return settleWhatsAppMessage(actor, pending, integration.phoneNumberId, conversation.lead.phone, conversation.assignedStaffId, context);
  },
};
