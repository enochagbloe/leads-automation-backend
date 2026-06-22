import crypto from "node:crypto";
import {
  AuditAction,
  ConversationChannel,
  ConversationStatus,
  LeadActivityAction,
  LeadSource,
  LeadStatus,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageType,
  Prisma,
  WebhookEventType,
  WebhookProcessingStatus,
  WebhookProvider,
  WhatsAppIntegrationStatus,
  WhatsAppProvider,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { createSystemMessage } from "./message.service";
import { subscriptionService } from "./subscription.service";
import { realtimeService } from "./realtime.service";
import { aiReplyEngine } from "./ai-reply-engine.service";

const PROVIDER_NAME = "META_WHATSAPP";
const MOCK_VERIFY_TOKEN = "bizreplyai-mock-verify-token";

export type WhatsAppInboundText = {
  businessId?: string;
  phoneNumberId?: string;
  customerPhone: string;
  customerName?: string;
  text: string;
  providerMessageId: string;
  timestamp?: Date;
  rawWebhookEventId?: string;
  rawPayload: Prisma.InputJsonValue;
};

export type WhatsAppStatusUpdate = {
  providerMessageId: string;
  status: string;
  timestamp?: Date;
  rawPayload: Prisma.InputJsonValue;
};

type PersistedInbound = {
  lead: { id: string; businessId: string; fullName: string; phone: string; assignedStaffId: string | null };
  conversation: {
    id: string;
    displayId: string;
    businessId: string;
    leadId: string;
    assignedStaffId: string | null;
    status: ConversationStatus;
    lastMessagePreview: string | null;
    lastMessageAt: Date | null;
    unreadCount: number;
    aiEnabled: boolean;
  };
  message: { id: string; providerMessageId: string | null };
  leadCreated: boolean;
  conversationCreated: boolean;
  conversationReopened: boolean;
  duplicate: boolean;
};

type ConversationCapacity = {
  accountUsageId: string;
  businessUsageId: string;
  maximum: number | null;
};

function normalizePhone(phone: string) {
  return phone.trim().replace(/[\s()-]/g, "");
}

function safeErrorMessage(error: unknown) {
  if (error instanceof AppError) return `${error.code}: ${error.message}`.slice(0, 500);
  return "Webhook processing failed";
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function invalidateCaches(businessId: string, leadId: string, conversationId: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:leads:list:*`),
    cacheService.delByPattern(`business:${businessId}:leads:detail:${leadId}*`),
    cacheService.delByPattern(`business:${businessId}:leads:counts*`),
    cacheService.delByPattern(`business:${businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:detail:${conversationId}:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:stats:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:unread:*`),
  ]);
}

async function resolveBusiness(input: WhatsAppInboundText) {
  if (input.businessId) {
    const business = await prisma.business.findFirst({
      where: { id: input.businessId, deletedAt: null },
      select: { id: true, businessAccountId: true, name: true },
    });
    if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
    const integration = await prisma.whatsAppIntegration.findFirst({
      where: { businessId: business.id },
      orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
      select: { status: true },
    });
    return { ...business, integrationStatus: integration?.status ?? WhatsAppIntegrationStatus.NOT_CONNECTED };
  }
  if (!input.phoneNumberId) throw new AppError(422, "WhatsApp phone number ID is required", "WHATSAPP_BUSINESS_MAPPING_FAILED");
  const integration = await prisma.whatsAppIntegration.findFirst({
    where: { phoneNumberId: input.phoneNumberId },
    orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
    include: { business: { select: { id: true, businessAccountId: true, name: true, deletedAt: true } } },
  });
  const acceptedStatuses: WhatsAppIntegrationStatus[] = env.WHATSAPP_PROVIDER_MODE === "live"
    ? [WhatsAppIntegrationStatus.CONNECTED, WhatsAppIntegrationStatus.DEACTIVATED, WhatsAppIntegrationStatus.DISCONNECTED]
    : [WhatsAppIntegrationStatus.CONNECTED, WhatsAppIntegrationStatus.MOCK_CONNECTED, WhatsAppIntegrationStatus.DEACTIVATED, WhatsAppIntegrationStatus.DISCONNECTED];
  if (!integration || integration.business.deletedAt || !acceptedStatuses.includes(integration.status)) {
    throw new AppError(404, "No WhatsApp integration matches this phone number", "WHATSAPP_BUSINESS_MAPPING_FAILED");
  }
  return { ...integration.business, integrationStatus: integration.status };
}

async function getConversationCapacity(businessAccountId: string, businessId: string): Promise<ConversationCapacity> {
  const subscription = await subscriptionService.getCurrentRecord(businessAccountId);
  const accountUsage = subscription.usageRecords[0];
  const businessUsage = await prisma.businessUsageRecord.findFirst({ where: { businessId }, orderBy: { periodStart: "desc" } });
  if (!accountUsage || !businessUsage) throw new AppError(500, "Current usage records are unavailable");
  return { accountUsageId: accountUsage.id, businessUsageId: businessUsage.id, maximum: subscription.plan.maxConversationsPerMonth };
}

async function persistInbound(
  business: { id: string; businessAccountId: string; integrationStatus: WhatsAppIntegrationStatus },
  input: WhatsAppInboundText,
  attempt = 0,
): Promise<PersistedInbound> {
  const customerPhone = normalizePhone(input.customerPhone);
  const duplicate = await prisma.message.findFirst({
    where: { businessId: business.id, provider: PROVIDER_NAME, providerMessageId: input.providerMessageId },
    include: { lead: true, conversation: true },
  });
  if (duplicate) {
    return { lead: duplicate.lead, conversation: duplicate.conversation, message: duplicate, leadCreated: false, conversationCreated: false, conversationReopened: false, duplicate: true };
  }

  const existingLead = await prisma.lead.findFirst({ where: { businessId: business.id, phone: customerPhone, deletedAt: null } });
  const activeConversation = existingLead ? await prisma.conversation.findFirst({
    where: {
      businessId: business.id,
      leadId: existingLead.id,
      channel: ConversationChannel.WHATSAPP,
      status: { not: ConversationStatus.CLOSED },
      deletedAt: null,
    },
  }) : null;
  const closedConversation = existingLead && !activeConversation ? await prisma.conversation.findFirst({
    where: {
      businessId: business.id,
      leadId: existingLead.id,
      channel: ConversationChannel.WHATSAPP,
      status: ConversationStatus.CLOSED,
      deletedAt: null,
    },
    orderBy: { updatedAt: "desc" },
  }) : null;
  const existingConversation = activeConversation ?? closedConversation;
  const conversationReopened = Boolean(closedConversation);
  const capacity = existingConversation ? null : await getConversationCapacity(business.businessAccountId, business.id);

  try {
    return await prisma.$transaction(async (tx) => {
      if (capacity) {
        await tx.$queryRaw`SELECT "id" FROM "AccountUsageRecord" WHERE "id" = ${capacity.accountUsageId} FOR UPDATE`;
        const usage = await tx.accountUsageRecord.findUniqueOrThrow({ where: { id: capacity.accountUsageId } });
        if (capacity.maximum !== null && usage.conversationsUsed >= capacity.maximum) {
          throw new AppError(403, "Your account has reached the monthly conversation limit for the current plan.", "PLAN_LIMIT_REACHED", {
            limit: capacity.maximum,
            current: usage.conversationsUsed,
          });
        }
      }
      const lead = existingLead ?? await tx.lead.create({
        data: {
          businessId: business.id,
          fullName: input.customerName?.trim() || "WhatsApp Customer",
          phone: customerPhone,
          source: LeadSource.WHATSAPP,
          status: LeadStatus.NEW,
          assignedStaffId: null,
        },
      });
      if (!existingLead) {
        await tx.leadActivity.create({
          data: {
            businessId: business.id,
            leadId: lead.id,
            action: LeadActivityAction.LEAD_CREATED,
            metadata: { source: LeadSource.WHATSAPP, createdBy: "SYSTEM", assignedStaffId: null, customerPhone },
          },
        });
      }

      let conversation = existingConversation ?? await tx.conversation.create({
        data: {
          businessId: business.id,
          leadId: lead.id,
          channel: ConversationChannel.WHATSAPP,
          status: ConversationStatus.OPEN,
          assignedStaffId: null,
          aiEnabled: false,
          humanTakeover: false,
        },
      });
      let didReopen = false;
      if (conversationReopened) {
        const claimed = await tx.conversation.updateMany({
          where: { id: conversation.id, status: ConversationStatus.CLOSED },
          data: { status: ConversationStatus.OPEN, closedAt: null, humanTakeover: false },
        });
        conversation = await tx.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
        didReopen = claimed.count === 1;
        if (didReopen) {
          await createSystemMessage({
            businessId: business.id,
            leadId: lead.id,
            conversationId: conversation.id,
            content: "Conversation reopened because the customer replied.",
            metadata: { reason: "CUSTOMER_REPLY", providerMessageId: input.providerMessageId },
          }, tx);
          await tx.leadActivity.create({
            data: {
              businessId: business.id,
              leadId: lead.id,
              action: LeadActivityAction.CONVERSATION_REOPENED,
              metadata: {
                reason: "CUSTOMER_REPLY",
                previousStatus: ConversationStatus.CLOSED,
                newStatus: ConversationStatus.OPEN,
                leadId: lead.id,
                conversationId: conversation.id,
                providerMessageId: input.providerMessageId,
              },
            },
          });
        }
      }
      if (!existingConversation) {
        await tx.leadActivity.create({
          data: {
            businessId: business.id,
            leadId: lead.id,
            action: LeadActivityAction.CONVERSATION_CREATED,
            metadata: { source: LeadSource.WHATSAPP, createdBy: "SYSTEM", leadId: lead.id, conversationId: conversation.id },
          },
        });
      }

      const message = await tx.message.create({
        data: {
          businessId: business.id,
          conversationId: conversation.id,
          leadId: lead.id,
          senderType: MessageSenderType.CUSTOMER,
          content: input.text,
          messageType: MessageType.TEXT,
          direction: MessageDirection.INBOUND,
          deliveryStatus: MessageDeliveryStatus.DELIVERED,
          provider: PROVIDER_NAME,
          providerMessageId: input.providerMessageId,
          metadata: {
            provider: PROVIDER_NAME,
            providerMessageId: input.providerMessageId,
            customerPhone,
            customerName: input.customerName ?? null,
            rawWebhookEventId: input.rawWebhookEventId ?? null,
            reopenedConversation: didReopen,
            integrationStatus: business.integrationStatus,
            automationSkipped: business.integrationStatus === WhatsAppIntegrationStatus.DEACTIVATED
              || business.integrationStatus === WhatsAppIntegrationStatus.DISCONNECTED,
          },
          createdAt: input.timestamp,
        },
      });
      const updatedConversation = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessagePreview: input.text.slice(0, 240),
          lastMessageAt: message.createdAt,
          unreadCount: { increment: 1 },
        },
      });
      await tx.leadActivity.create({
        data: {
          businessId: business.id,
          leadId: lead.id,
          action: LeadActivityAction.MESSAGE_CREATED,
          metadata: {
            source: LeadSource.WHATSAPP,
            conversationId: conversation.id,
            messageId: message.id,
            senderType: MessageSenderType.CUSTOMER,
            direction: MessageDirection.INBOUND,
            providerMessageId: input.providerMessageId,
          },
        },
      });
      if (!existingConversation && capacity) {
        await tx.accountUsageRecord.update({ where: { id: capacity.accountUsageId }, data: { conversationsUsed: { increment: 1 } } });
        await tx.businessUsageRecord.update({ where: { id: capacity.businessUsageId }, data: { conversationsUsed: { increment: 1 } } });
      }
      return {
        lead,
        conversation: updatedConversation,
        message,
        leadCreated: !existingLead,
        conversationCreated: !existingConversation,
        conversationReopened: didReopen,
        duplicate: false,
      };
    }, { maxWait: 15_000, timeout: 30_000 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const duplicateMessage = await prisma.message.findFirst({
        where: { businessId: business.id, provider: PROVIDER_NAME, providerMessageId: input.providerMessageId },
        include: { lead: true, conversation: true },
      });
      if (duplicateMessage) {
        return { lead: duplicateMessage.lead, conversation: duplicateMessage.conversation, message: duplicateMessage, leadCreated: false, conversationCreated: false, conversationReopened: false, duplicate: true };
      }
      if (attempt === 0) return persistInbound(business, input, 1);
    }
    throw error;
  }
}

async function logSystemActions(result: PersistedInbound, input: WhatsAppInboundText) {
  const logs: Promise<unknown>[] = [
    auditService.log({
      action: AuditAction.MESSAGE_CREATED,
      businessId: result.lead.businessId,
      metadata: {
        source: LeadSource.WHATSAPP,
        senderType: MessageSenderType.CUSTOMER,
        direction: MessageDirection.INBOUND,
        providerMessageId: input.providerMessageId,
        messageId: result.message.id,
        conversationId: result.conversation.id,
      },
    }),
  ];
  if (result.leadCreated) logs.push(auditService.log({
    action: AuditAction.LEAD_CREATED,
    businessId: result.lead.businessId,
    metadata: { source: LeadSource.WHATSAPP, createdBy: "SYSTEM", assignedStaffId: null, customerPhone: result.lead.phone, leadId: result.lead.id },
  }));
  if (result.conversationCreated) {
    logs.push(auditService.log({
      action: AuditAction.CONVERSATION_CREATED,
      businessId: result.lead.businessId,
      metadata: { source: LeadSource.WHATSAPP, createdBy: "SYSTEM", leadId: result.lead.id, conversationId: result.conversation.id },
    }));
    logs.push(auditService.log({
      action: AuditAction.USAGE_RECORD_UPDATED,
      businessId: result.lead.businessId,
      metadata: { usageKey: "conversationsUsed", delta: 1, source: "WHATSAPP", conversationId: result.conversation.id },
    }));
  }
  if (result.conversationReopened) {
    logs.push(auditService.log({
      action: AuditAction.CONVERSATION_REOPENED,
      businessId: result.lead.businessId,
      metadata: {
        businessId: result.lead.businessId,
        leadId: result.lead.id,
        conversationId: result.conversation.id,
        reason: "CUSTOMER_REPLY",
        triggeredBy: "SYSTEM",
        providerMessageId: input.providerMessageId,
      },
    }));
  }
  await Promise.all(logs);
}

export function parseMetaWebhook(payload: unknown): WhatsAppInboundText[] {
  if (!payload || typeof payload !== "object") return [];
  const result: WhatsAppInboundText[] = [];
  const entries = Array.isArray((payload as { entry?: unknown }).entry) ? (payload as { entry: unknown[] }).entry : [];
  for (const entryValue of entries) {
    const entry = entryValue as { id?: string; changes?: unknown[] };
    for (const changeValue of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = (changeValue as { value?: Record<string, unknown> }).value;
      if (!value) continue;
      const metadata = value.metadata as { phone_number_id?: string } | undefined;
      const contacts = Array.isArray(value.contacts) ? value.contacts as Array<{ profile?: { name?: string }; wa_id?: string }> : [];
      const messages = Array.isArray(value.messages) ? value.messages as Array<Record<string, unknown>> : [];
      for (const message of messages) {
        const text = message.text as { body?: string } | undefined;
        if (message.type !== "text" || !text?.body || typeof message.id !== "string" || typeof message.from !== "string") continue;
        const profile = contacts.find((contact) => contact.wa_id === message.from)?.profile;
        result.push({
          phoneNumberId: metadata?.phone_number_id,
          customerPhone: message.from,
          customerName: profile?.name,
          text: text.body,
          providerMessageId: message.id,
          timestamp: typeof message.timestamp === "string" ? new Date(Number(message.timestamp) * 1000) : undefined,
          rawWebhookEventId: entry.id,
          rawPayload: payload as Prisma.InputJsonValue,
        });
      }
    }
  }
  return result;
}

export function parseMetaStatusWebhook(payload: unknown): WhatsAppStatusUpdate[] {
  if (!payload || typeof payload !== "object") return [];
  const result: WhatsAppStatusUpdate[] = [];
  const entries = Array.isArray((payload as { entry?: unknown }).entry) ? (payload as { entry: unknown[] }).entry : [];
  for (const entryValue of entries) {
    const entry = entryValue as { changes?: unknown[] };
    for (const changeValue of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = (changeValue as { value?: Record<string, unknown> }).value;
      const statuses = value && Array.isArray(value.statuses) ? value.statuses as Array<Record<string, unknown>> : [];
      for (const status of statuses) {
        if (typeof status.id !== "string" || typeof status.status !== "string") continue;
        result.push({
          providerMessageId: status.id,
          status: status.status,
          timestamp: typeof status.timestamp === "string" ? new Date(Number(status.timestamp) * 1000) : undefined,
          rawPayload: payload as Prisma.InputJsonValue,
        });
      }
    }
  }
  return result;
}

function mapProviderStatus(status: string) {
  const statuses: Record<string, MessageDeliveryStatus> = {
    sent: MessageDeliveryStatus.SENT,
    delivered: MessageDeliveryStatus.DELIVERED,
    read: MessageDeliveryStatus.READ,
    failed: MessageDeliveryStatus.FAILED,
  };
  return statuses[status.toLowerCase()];
}

function mergeMetadata(metadata: Prisma.JsonValue | null, values: Record<string, Prisma.JsonValue>): Prisma.InputJsonValue {
  const current = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  return { ...current, ...values };
}

export const whatsappService = {
  verifyWebhook(mode?: string, token?: string) {
    if (mode !== "subscribe" || !token) return false;
    const expected = env.META_WHATSAPP_VERIFY_TOKEN ?? (env.WHATSAPP_PROVIDER_MODE === "mock" ? MOCK_VERIFY_TOKEN : "");
    if (!expected || token.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  },

  verifySignature(rawBody: Buffer | undefined, signature: string | undefined) {
    if (env.WHATSAPP_PROVIDER_MODE !== "live") return true;
    if (!rawBody || !signature || !env.META_APP_SECRET) return false;
    const expected = `sha256=${crypto.createHmac("sha256", env.META_APP_SECRET).update(rawBody).digest("hex")}`;
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  },

  async ensureMockIntegration(businessId: string) {
    const business = await prisma.business.findFirst({ where: { id: businessId, deletedAt: null }, select: { id: true } });
    if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
    const current = await prisma.whatsAppIntegration.findFirst({
      where: { businessId },
      orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
    });
    if (current) return current;
    return prisma.whatsAppIntegration.create({
      data: {
        businessId,
        provider: WhatsAppProvider.MOCK_WHATSAPP,
        phoneNumberId: `mock-${businessId}-${crypto.randomUUID()}`,
        status: WhatsAppIntegrationStatus.MOCK_CONNECTED,
        automationEnabled: true,
        connectedAt: new Date(),
        metadata: { createdBy: "DEV_MOCK_INBOUND" },
      },
    });
  },

  async logIgnoredWebhook(payload: Prisma.InputJsonValue) {
    return prisma.webhookEventLog.create({
      data: { provider: WebhookProvider.META_WHATSAPP, eventType: WebhookEventType.UNKNOWN, payload, processingStatus: WebhookProcessingStatus.PROCESSED, processedAt: new Date() },
    });
  },

  async processInbound(input: WhatsAppInboundText) {
    const event = await prisma.webhookEventLog.create({
      data: {
        provider: WebhookProvider.META_WHATSAPP,
        eventType: WebhookEventType.WHATSAPP_INBOUND_MESSAGE,
        providerMessageId: input.providerMessageId,
        payload: input.rawPayload,
        processingStatus: WebhookProcessingStatus.RECEIVED,
      },
    });
    let resolvedBusinessId: string | undefined;
    try {
      const business = await resolveBusiness(input);
      resolvedBusinessId = business.id;
      await prisma.webhookEventLog.update({ where: { id: event.id }, data: { businessId: business.id } });
      const result = await persistInbound(business, input);
      await prisma.webhookEventLog.update({
        where: { id: event.id },
        data: {
          businessId: business.id,
          conversationId: result.conversation.id,
          messageId: result.message.id,
          processingStatus: result.duplicate ? WebhookProcessingStatus.DUPLICATE : WebhookProcessingStatus.PROCESSED,
          processedAt: new Date(),
        },
      });
      if (!result.duplicate) {
        await Promise.all([
          logSystemActions(result, input),
          invalidateCaches(business.id, result.lead.id, result.conversation.id),
        ]);
        if (result.leadCreated) {
          realtimeService.publish({
            type: "lead.created",
            businessId: business.id,
            leadId: result.lead.id,
            assignedStaffId: result.lead.assignedStaffId,
            payload: { lead: result.lead },
          });
        }
        if (result.conversationCreated) {
          realtimeService.publish({
            type: "conversation.created",
            businessId: business.id,
            conversationId: result.conversation.id,
            leadId: result.lead.id,
            payload: { conversation: result.conversation },
          });
        }
        if (result.conversationReopened) {
          realtimeService.publish({
            type: "conversation.reopened",
            businessId: business.id,
            conversationId: result.conversation.id,
            leadId: result.lead.id,
            assignedStaffId: result.conversation.assignedStaffId,
            payload: {
              conversationId: result.conversation.id,
              status: ConversationStatus.OPEN,
              closedAt: null,
              reason: "CUSTOMER_REPLY",
              messageId: result.message.id,
            },
          });
        }
        realtimeService.publish({
          type: "message.created",
          businessId: business.id,
          conversationId: result.conversation.id,
          leadId: result.lead.id,
          messageId: result.message.id,
          assignedStaffId: result.conversation.assignedStaffId,
          payload: { message: result.message, conversation: result.conversation },
        });
        realtimeService.publish({
          type: "conversation.updated",
          businessId: business.id,
          conversationId: result.conversation.id,
          leadId: result.lead.id,
          assignedStaffId: result.conversation.assignedStaffId,
          payload: {
            conversationId: result.conversation.id,
            changes: {
              lastMessagePreview: result.conversation.lastMessagePreview,
              lastMessageAt: result.conversation.lastMessageAt,
              unreadCount: result.conversation.unreadCount,
              status: result.conversation.status,
            },
          },
        });
        realtimeService.publish({
          type: "conversation.unread_count.updated",
          businessId: business.id,
          conversationId: result.conversation.id,
          leadId: result.lead.id,
          assignedStaffId: result.conversation.assignedStaffId,
          payload: { conversationId: result.conversation.id, unreadCount: result.conversation.unreadCount },
        });
        if (env.AI_REPLY_ENABLED && result.conversation.aiEnabled && result.conversation.status !== ConversationStatus.CLOSED) {
          aiReplyEngine.processInboundMessageForAiSafely({
            businessId: business.id,
            conversationId: result.conversation.id,
            messageId: result.message.id,
            triggeredBy: "WHATSAPP_INBOUND",
          });
        }
      }
      return result;
    } catch (error) {
      if (error instanceof AppError && error.code === "PLAN_LIMIT_REACHED" && resolvedBusinessId) {
        await auditService.log({
          action: AuditAction.PLAN_LIMIT_REACHED,
          businessId: resolvedBusinessId,
          metadata: { usageKey: "conversationsUsed", source: "WHATSAPP", ...error.context },
        });
      }
      await prisma.webhookEventLog.update({
        where: { id: event.id },
        data: {
          processingStatus: error instanceof AppError && error.code === "PLAN_LIMIT_REACHED" ? WebhookProcessingStatus.LIMIT_BLOCKED : WebhookProcessingStatus.FAILED,
          errorMessage: safeErrorMessage(error),
          processedAt: new Date(),
        },
      }).catch((logError) => console.error("Webhook event failure could not be logged", logError));
      throw error;
    }
  },

  async processStatusUpdate(input: WhatsAppStatusUpdate) {
    const event = await prisma.webhookEventLog.create({
      data: {
        provider: WebhookProvider.META_WHATSAPP,
        eventType: WebhookEventType.WHATSAPP_STATUS_UPDATE,
        providerMessageId: input.providerMessageId,
        payload: input.rawPayload,
        processingStatus: WebhookProcessingStatus.RECEIVED,
      },
    });
    try {
      const message = await prisma.message.findFirst({
        where: { providerMessageId: input.providerMessageId, direction: MessageDirection.OUTBOUND, deletedAt: null },
        include: { conversation: { select: { assignedStaffId: true } } },
      });
      if (!message) {
        await prisma.webhookEventLog.update({
          where: { id: event.id },
          data: { processingStatus: WebhookProcessingStatus.MESSAGE_NOT_FOUND, processedAt: new Date() },
        });
        return { messageFound: false, providerMessageId: input.providerMessageId };
      }
      const mapped = mapProviderStatus(input.status);
      const updated = await prisma.$transaction(async (tx) => {
        const record = await tx.message.update({
          where: { id: message.id },
          data: {
            ...(mapped ? { deliveryStatus: mapped } : {}),
            ...(mapped === MessageDeliveryStatus.READ ? { readAt: input.timestamp ?? new Date() } : {}),
            metadata: mergeMetadata(message.metadata, {
              providerStatus: input.status,
              providerStatusAt: (input.timestamp ?? new Date()).toISOString(),
              providerStatusPayload: input.rawPayload as Prisma.JsonValue,
              deliveryStatus: mapped ?? message.deliveryStatus,
            }),
          },
        });
        await tx.leadActivity.create({
          data: {
            businessId: message.businessId,
            leadId: message.leadId,
            action: LeadActivityAction.MESSAGE_STATUS_UPDATED,
            metadata: {
              conversationId: message.conversationId,
              messageId: message.id,
              providerMessageId: input.providerMessageId,
              providerStatus: input.status,
              deliveryStatus: mapped ?? message.deliveryStatus,
            },
          },
        });
        await tx.webhookEventLog.update({
          where: { id: event.id },
          data: {
            businessId: message.businessId,
            conversationId: message.conversationId,
            messageId: message.id,
            processingStatus: WebhookProcessingStatus.PROCESSED,
            processedAt: new Date(),
          },
        });
        return record;
      }, { maxWait: 15_000, timeout: 30_000 });
      await Promise.all([
        auditService.log({
          action: AuditAction.WHATSAPP_MESSAGE_STATUS_UPDATED,
          businessId: message.businessId,
          metadata: {
            conversationId: message.conversationId,
            messageId: message.id,
            providerMessageId: input.providerMessageId,
            providerStatus: input.status,
            deliveryStatus: mapped ?? message.deliveryStatus,
          },
        }),
        cacheService.delByPattern(`business:${message.businessId}:conversations:list:*`),
        cacheService.delByPattern(`business:${message.businessId}:conversations:detail:${message.conversationId}:*`),
        cacheService.delByPattern(`business:${message.businessId}:conversations:stats:*`),
      ]);
      realtimeService.publish({
        type: "message.status.updated",
        businessId: message.businessId,
        conversationId: message.conversationId,
        leadId: message.leadId,
        messageId: message.id,
        assignedStaffId: message.conversation.assignedStaffId,
        payload: {
          messageId: message.id,
          conversationId: message.conversationId,
          previousStatus: message.deliveryStatus,
          newStatus: updated.deliveryStatus,
          readAt: updated.readAt,
          updatedAt: updated.updatedAt,
        },
      });
      return { messageFound: true, message: updated, mappedStatus: mapped ?? null };
    } catch (error) {
      await prisma.webhookEventLog.update({
        where: { id: event.id },
        data: { processingStatus: WebhookProcessingStatus.FAILED, errorMessage: safeErrorMessage(error), processedAt: new Date() },
      }).catch((logError) => console.error("Status webhook failure could not be logged", logError));
      throw new AppError(500, "WhatsApp status update failed", "WHATSAPP_STATUS_UPDATE_FAILED");
    }
  },
};
