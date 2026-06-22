import {
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
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
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { aiBusinessContextService, aiPromptContextFormatter } from "./ai-context-builder.service";
import { fallbackHumanReviewDecision } from "./ai-decision-parser.service";
import { aiProvider, AiGenerateReplyResult } from "./ai-provider.service";
import { aiSafetyService, AiSafetyResult } from "./ai-safety.service";
import { aiUsageService } from "./ai-usage.service";
import { cacheService } from "./cache.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { getWhatsAppIntegration, sendWhatsAppText } from "./whatsapp-provider.service";

export type AiReplyActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type ProcessInput = {
  businessId: string;
  conversationId: string;
  messageId?: string;
  triggeredBy: "WHATSAPP_INBOUND" | "MANUAL_TRIGGER";
  actor?: AiReplyActor;
};

type AiExecutionStatus =
  | "SUCCESS"
  | "BLOCKED_LOW_CONFIDENCE"
  | "BLOCKED_POLICY"
  | "BLOCKED_QUOTA"
  | "PROVIDER_ERROR"
  | "PARSE_ERROR"
  | "WHATSAPP_SEND_FAILED"
  | "AI_FALLBACK_EXHAUSTED"
  | "AI_BUSINESS_NOT_READY"
  | "SKIPPED";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isManager(actor: AiReplyActor) {
  return actor.role === BusinessRole.BUSINESS_OWNER || actor.role === BusinessRole.MANAGER;
}

function safeProviderError(error: unknown) {
  if (error instanceof AppError) return error.code;
  return "AI_PROVIDER_ERROR";
}

async function invalidateConversationCaches(businessId: string, conversationId: string, leadId: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:detail:${conversationId}:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:stats:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:unread:*`),
    cacheService.delByPattern(`business:${businessId}:leads:detail:${leadId}*`),
  ]);
}

function businessReadyForAi(readiness: { isAiReady: boolean; warnings: string[] }) {
  return readiness.isAiReady || !readiness.warnings.some((warning) =>
    /no active services|availability not configured|no customer-facing policies/i.test(warning));
}

async function createHumanReviewNotifications(input: {
  businessId: string;
  businessAccountId: string | null;
  conversationId: string;
  leadId: string;
  assignedStaffId: string | null;
  reason: string;
}) {
  const recipients = await prisma.businessMember.findMany({
    where: {
      businessId: input.businessId,
      status: "ACTIVE",
      OR: [
        { role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] } },
        ...(input.assignedStaffId ? [{ id: input.assignedStaffId }] : []),
      ],
    },
    select: { id: true },
  });
  await notificationService.createNotificationsForRecipients({
    businessId: input.businessId,
    businessAccountId: input.businessAccountId,
    recipientMembershipIds: recipients.map((recipient) => recipient.id),
    type: BusinessNotificationType.AI_HUMAN_REVIEW_REQUIRED,
    priority: BusinessNotificationPriority.HIGH,
    title: "AI needs human review",
    message: input.reason,
    entityType: BusinessNotificationEntityType.CONVERSATION,
    entityId: input.conversationId,
    actions: [
      { label: "View conversation", action: "VIEW_CONVERSATION", variant: "default" },
      { label: "Take over", action: "TAKE_OVER_CONVERSATION", variant: "secondary" },
    ],
    metadata: {
      conversationId: input.conversationId,
      leadId: input.leadId,
      reason: input.reason,
    },
  });
}

async function logInteraction(input: {
  businessId: string;
  businessAccountId: string | null;
  conversationId: string;
  messageId: string;
  aiMessageId?: string | null;
  providerResult?: AiGenerateReplyResult | null;
  safety?: AiSafetyResult | null;
  status: AiExecutionStatus;
  errorCode?: string | null;
  blockedReason?: string | null;
}) {
  const decision = input.safety?.decision ?? input.providerResult?.parsedDecision ?? null;
  return prisma.aiInteractionLog.create({
    data: {
      businessId: input.businessId,
      businessAccountId: input.businessAccountId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      aiMessageId: input.aiMessageId ?? null,
      provider: input.providerResult?.provider ?? "OPENROUTER",
      model: input.providerResult?.model ?? env.OPENROUTER_DEFAULT_MODEL ?? "unknown",
      intent: decision?.intent ?? null,
      confidence: decision?.confidence ?? null,
      suggestedAction: decision?.suggestedAction ?? null,
      shouldReply: decision?.shouldReply ?? false,
      requiresHumanReview: decision?.requiresHumanReview ?? false,
      blockedReason: input.blockedReason ?? input.safety?.blockedReason ?? null,
      primaryModel: input.providerResult?.primaryModel ?? env.OPENROUTER_DEFAULT_MODEL ?? null,
      finalModelUsed: input.providerResult?.finalModelUsed ?? input.providerResult?.model ?? null,
      fallbackAttempted: input.providerResult?.fallbackAttempted ?? false,
      fallbackModelsTried: input.providerResult ? json(input.providerResult.fallbackModelsTried) : undefined,
      fallbackFailureReasons: input.providerResult ? json(input.providerResult.fallbackFailureReasons) : undefined,
      providerRequestCount: input.providerResult?.providerRequestCount ?? 0,
      promptTokens: input.providerResult?.promptTokens,
      completionTokens: input.providerResult?.completionTokens,
      totalTokens: input.providerResult?.totalTokens,
      latencyMs: input.providerResult?.latencyMs ?? 0,
      status: input.status,
      errorCode: input.errorCode ?? null,
    },
  });
}

async function latestCustomerMessage(businessId: string, conversationId: string, messageId?: string) {
  if (messageId) {
    return prisma.message.findFirst({
      where: { id: messageId, businessId, conversationId, deletedAt: null },
    });
  }
  return prisma.message.findFirst({
    where: {
      businessId,
      conversationId,
      senderType: MessageSenderType.CUSTOMER,
      direction: MessageDirection.INBOUND,
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
}

export const aiReplyEngine = {
  async processLatestForActor(actor: AiReplyActor, conversationId: string) {
    if (!isManager(actor)) throw new AppError(403, "Only owners and managers can manually trigger AI processing.", "FORBIDDEN");
    return this.processInboundMessageForAi({
      businessId: actor.businessId,
      conversationId,
      triggeredBy: "MANUAL_TRIGGER",
      actor,
    });
  },

  async processInboundMessageForAi(input: ProcessInput) {
    if (!env.AI_REPLY_ENABLED) throw new AppError(503, "AI replies are disabled.", "AI_DISABLED");

    const conversation = await prisma.conversation.findFirst({
      where: { id: input.conversationId, businessId: input.businessId, deletedAt: null },
      include: {
        business: { select: { id: true, businessAccountId: true, deletedAt: true } },
        lead: { select: { id: true, phone: true } },
      },
    });
    if (!conversation || conversation.business.deletedAt) {
      throw new AppError(404, "Conversation not found.", "AI_CONVERSATION_NOT_FOUND");
    }
    if (input.actor && input.actor.businessId !== conversation.businessId) {
      throw new AppError(403, "Business access denied.", "BUSINESS_ACCESS_DENIED");
    }
    if (conversation.status === ConversationStatus.CLOSED) {
      throw new AppError(422, "AI cannot process a closed conversation.", "AI_CONVERSATION_CLOSED");
    }
    if (conversation.aiEnabled === false) {
      throw new AppError(403, "AI is disabled for this conversation.", "AI_DISABLED");
    }

    const message = await latestCustomerMessage(input.businessId, conversation.id, input.messageId);
    if (!message) throw new AppError(404, "Customer message not found.", "AI_MESSAGE_NOT_FOUND");
    if (message.senderType !== MessageSenderType.CUSTOMER || message.direction !== MessageDirection.INBOUND) {
      throw new AppError(422, "AI only processes inbound customer messages.", "AI_MESSAGE_NOT_FOUND");
    }

    realtimeService.publish({
      type: "business.ai.reply.started",
      businessId: conversation.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      messageId: message.id,
      assignedStaffId: conversation.assignedStaffId,
      payload: { conversationId: conversation.id, messageId: message.id, triggeredBy: input.triggeredBy },
    });

    const usage = await aiUsageService.assertCanUseAiReplies(conversation.business.businessAccountId);
    const businessUsage = await prisma.businessUsageRecord.findFirst({
      where: { businessId: conversation.businessId },
      orderBy: { periodStart: "desc" },
      select: { id: true },
    });

    let providerResult: AiGenerateReplyResult | null = null;
    try {
      const context = await aiBusinessContextService.buildBusinessContextForAi({
        businessId: conversation.businessId,
        conversationId: conversation.id,
        messageId: message.id,
        plan: usage.subscription.plan.code,
        maxMessages: env.AI_MAX_CONTEXT_MESSAGES,
        maxContextTokens: env.AI_MAX_BUSINESS_CONTEXT_TOKENS,
      });
      const providerInput = {
        businessId: conversation.businessId,
        conversationId: conversation.id,
        messageId: message.id,
        systemPrompt: aiPromptContextFormatter.buildSystemPrompt(context),
        userPrompt: aiPromptContextFormatter.buildUserPrompt(context),
        metadata: {
          plan: usage.subscription.plan.code,
          channel: conversation.channel === ConversationChannel.WHATSAPP ? "WHATSAPP" as const : "MANUAL" as const,
          source: "INBOUND_MESSAGE" as const,
        },
      };
      providerResult = await aiProvider.generateReply(providerInput);
      await aiUsageService.trackRequest({ accountUsageId: usage.usage.id, tokens: providerResult.totalTokens });
      if (providerResult.fallbackExhausted) {
        const fallbackDecision = providerResult.parsedDecision ?? fallbackHumanReviewDecision("AI provider failed after fallback attempts.");
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { humanTakeover: true, status: ConversationStatus.HUMAN_HANDLING },
        });
        await Promise.all([
          createHumanReviewNotifications({
            businessId: conversation.businessId,
            businessAccountId: conversation.business.businessAccountId,
            conversationId: conversation.id,
            leadId: conversation.leadId,
            assignedStaffId: conversation.assignedStaffId,
            reason: fallbackDecision.reason,
          }),
          logInteraction({
            businessId: conversation.businessId,
            businessAccountId: conversation.business.businessAccountId,
            conversationId: conversation.id,
            messageId: message.id,
            providerResult,
            safety: { allowed: false, decision: fallbackDecision, status: "BLOCKED_POLICY", blockedReason: fallbackDecision.reason },
            status: "AI_FALLBACK_EXHAUSTED",
            errorCode: "AI_FALLBACK_EXHAUSTED",
            blockedReason: fallbackDecision.reason,
          }),
          invalidateConversationCaches(conversation.businessId, conversation.id, conversation.leadId),
        ]);
        realtimeService.publish({
          type: "business.ai.reply.failed",
          businessId: conversation.businessId,
          conversationId: conversation.id,
          leadId: conversation.leadId,
          messageId: message.id,
          assignedStaffId: conversation.assignedStaffId,
          payload: {
            conversationId: conversation.id,
            messageId: message.id,
            errorCode: "AI_FALLBACK_EXHAUSTED",
            fallbackUsed: providerResult.fallbackAttempted,
            fallbackExhausted: true,
            finalModelUsed: providerResult.finalModelUsed,
            providerRequestCount: providerResult.providerRequestCount,
          },
        });
        return { status: "AI_FALLBACK_EXHAUSTED", blocked: true, decision: fallbackDecision };
      }
      const safety = aiSafetyService.evaluate({
        decision: providerResult.parsedDecision,
        businessReady: businessReadyForAi(context.readiness),
        humanTakeover: conversation.humanTakeover,
      });
      if (!safety.allowed) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { humanTakeover: true, status: ConversationStatus.HUMAN_HANDLING },
        });
        await Promise.all([
          createHumanReviewNotifications({
            businessId: conversation.businessId,
            businessAccountId: conversation.business.businessAccountId,
            conversationId: conversation.id,
            leadId: conversation.leadId,
            assignedStaffId: conversation.assignedStaffId,
            reason: safety.blockedReason ?? safety.decision.reason,
          }),
          logInteraction({
            businessId: conversation.businessId,
            businessAccountId: conversation.business.businessAccountId,
            conversationId: conversation.id,
            messageId: message.id,
            providerResult,
            safety,
            status: safety.status,
          }),
          invalidateConversationCaches(conversation.businessId, conversation.id, conversation.leadId),
        ]);
        realtimeService.publish({
          type: "business.ai.reply.blocked",
          businessId: conversation.businessId,
          conversationId: conversation.id,
          leadId: conversation.leadId,
          messageId: message.id,
          assignedStaffId: conversation.assignedStaffId,
          payload: {
            conversationId: conversation.id,
            messageId: message.id,
            reason: safety.blockedReason,
            intent: safety.decision.intent,
            confidence: safety.decision.confidence,
            fallbackUsed: providerResult.fallbackAttempted,
            finalModelUsed: providerResult.finalModelUsed,
            providerRequestCount: providerResult.providerRequestCount,
          },
        });
        return { status: safety.status, blocked: true, decision: safety.decision };
      }

      const replyText = safety.decision.replyText!;
      let deliveryStatus: MessageDeliveryStatus = conversation.channel === ConversationChannel.WHATSAPP ? MessageDeliveryStatus.PENDING : MessageDeliveryStatus.INTERNAL;
      let provider: string = providerResult.provider;
      let providerMessageId: string | null = null;
      let sendError: string | null = null;

      const aiMessage = await prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            businessId: conversation.businessId,
            conversationId: conversation.id,
            leadId: conversation.leadId,
            senderType: MessageSenderType.AI,
            content: replyText,
            messageType: MessageType.TEXT,
            direction: MessageDirection.OUTBOUND,
            deliveryStatus,
            readAt: deliveryStatus === MessageDeliveryStatus.INTERNAL ? new Date() : null,
            metadata: json({
              provider: providerResult?.provider,
              model: providerResult?.model,
              primaryModel: providerResult?.primaryModel,
              finalModelUsed: providerResult?.finalModelUsed,
              fallbackAttempted: providerResult?.fallbackAttempted,
              fallbackModelsTried: providerResult?.fallbackModelsTried,
              providerRequestCount: providerResult?.providerRequestCount,
              confidence: safety.decision.confidence,
              intent: safety.decision.intent,
              suggestedAction: safety.decision.suggestedAction,
              requiresHumanReview: safety.decision.requiresHumanReview,
            }),
          },
        });
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            lastMessagePreview: replyText.slice(0, 240),
            lastMessageAt: created.createdAt,
            status: conversation.status === ConversationStatus.OPEN ? ConversationStatus.AI_HANDLING : conversation.status,
          },
        });
        await tx.leadActivity.create({
          data: {
            businessId: conversation.businessId,
            leadId: conversation.leadId,
            action: LeadActivityAction.MESSAGE_CREATED,
            metadata: {
              source: "AI_REPLY_ENGINE",
              conversationId: conversation.id,
              messageId: created.id,
              senderType: MessageSenderType.AI,
              direction: MessageDirection.OUTBOUND,
              intent: safety.decision.intent,
              confidence: safety.decision.confidence,
            },
          },
        });
        return created;
      });

      if (conversation.channel === ConversationChannel.WHATSAPP) {
        try {
          const integration = await getWhatsAppIntegration(conversation.businessId);
          const result = await sendWhatsAppText(integration, {
            phoneNumberId: integration.phoneNumberId,
            to: conversation.lead.phone,
            message: replyText,
            businessId: conversation.businessId,
            conversationId: conversation.id,
            messageId: aiMessage.id,
          });
          deliveryStatus = result.success ? MessageDeliveryStatus.SENT : MessageDeliveryStatus.FAILED;
          provider = result.provider;
          providerMessageId = result.providerMessageId ?? null;
          sendError = result.success ? null : result.error ?? "WhatsApp send failed";
        } catch (error) {
          deliveryStatus = MessageDeliveryStatus.FAILED;
          sendError = error instanceof AppError ? error.code : "WHATSAPP_SEND_FAILED";
        }
      }

      const settledMessage = await prisma.message.update({
        where: { id: aiMessage.id },
        data: {
          deliveryStatus,
          provider,
          providerMessageId,
          metadata: json({
            ...(aiMessage.metadata && typeof aiMessage.metadata === "object" && !Array.isArray(aiMessage.metadata) ? aiMessage.metadata : {}),
            deliveryStatus,
            provider,
            providerMessageId,
            ...(sendError ? { error: sendError } : {}),
          }),
        },
      });

      const finalStatus: AiExecutionStatus = deliveryStatus === MessageDeliveryStatus.FAILED ? "WHATSAPP_SEND_FAILED" : "SUCCESS";
      await Promise.all([
        aiUsageService.trackReply({ accountUsageId: usage.usage.id, businessUsageId: businessUsage?.id }),
        logInteraction({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          messageId: message.id,
          aiMessageId: settledMessage.id,
          providerResult,
          safety,
          status: finalStatus,
          errorCode: sendError,
        }),
        invalidateConversationCaches(conversation.businessId, conversation.id, conversation.leadId),
      ]);

      realtimeService.publish({
        type: "message.created",
        businessId: conversation.businessId,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        messageId: settledMessage.id,
        assignedStaffId: conversation.assignedStaffId,
        payload: { message: settledMessage },
      });
      realtimeService.publish({
        type: finalStatus === "SUCCESS" ? "business.ai.reply.completed" : "business.ai.reply.failed",
        businessId: conversation.businessId,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        messageId: settledMessage.id,
        assignedStaffId: conversation.assignedStaffId,
        payload: {
          conversationId: conversation.id,
          sourceMessageId: message.id,
          aiMessageId: settledMessage.id,
          deliveryStatus,
          errorCode: sendError,
          fallbackUsed: providerResult.fallbackAttempted,
          finalModelUsed: providerResult.finalModelUsed,
          providerRequestCount: providerResult.providerRequestCount,
        },
      });
      return { status: finalStatus, blocked: false, message: settledMessage, decision: safety.decision };
    } catch (error) {
      const errorCode = safeProviderError(error);
      await logInteraction({
        businessId: conversation.businessId,
        businessAccountId: conversation.business.businessAccountId,
        conversationId: conversation.id,
        messageId: message.id,
        providerResult,
        safety: { allowed: false, decision: fallbackHumanReviewDecision(errorCode), status: "BLOCKED_POLICY", blockedReason: errorCode },
        status: errorCode === "AI_QUOTA_EXCEEDED" ? "BLOCKED_QUOTA" : "PROVIDER_ERROR",
        errorCode,
        blockedReason: errorCode,
      }).catch((logError) => console.error("AI interaction failure could not be logged", logError));
      realtimeService.publish({
        type: "business.ai.reply.failed",
        businessId: conversation.businessId,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        messageId: message.id,
        assignedStaffId: conversation.assignedStaffId,
        payload: { conversationId: conversation.id, messageId: message.id, errorCode },
      });
      throw error instanceof AppError ? error : new AppError(500, "AI reply processing failed.", "AI_PROVIDER_ERROR");
    }
  },

  processInboundMessageForAiSafely(input: ProcessInput) {
    this.processInboundMessageForAi(input).catch((error) => {
      const code = error instanceof AppError ? error.code : "AI_PROVIDER_ERROR";
      console.error("AI reply pipeline failed safely", {
        businessId: input.businessId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        code,
      });
    });
  },
};
