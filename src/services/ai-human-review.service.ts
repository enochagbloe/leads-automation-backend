import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessRole,
  ConversationStatus,
  HumanReviewType,
  MembershipStatus,
  PlanCode,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { AuditInput, auditService } from "./audit.service";
import { invalidateAiBusinessContext } from "./ai-context-builder.service";
import { ConversationActor, createSystemMessage } from "./message.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { subscriptionService } from "./subscription.service";
import { invalidateConversationCache } from "./conversation.service";

type RequestHumanReviewInput = {
  businessId: string;
  businessAccountId: string | null;
  conversationId: string;
  messageId?: string | null;
  reviewType: HumanReviewType;
  reason: string;
  priority?: BusinessNotificationPriority;
  source: string;
  metadata?: Record<string, unknown>;
};

type ResolutionInput = {
  businessId: string;
  conversationId: string;
  actorMembershipId: string;
  resolution: "TAKE_OVER" | "RESUME_AI" | "RESOLVED";
  reason?: string | null;
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function canAccessConversation(actor: ConversationActor, conversation: { assignedStaffId: string | null }) {
  return actor.role !== BusinessRole.STAFF || conversation.assignedStaffId === actor.membershipId;
}

async function loadConversationForActor(actor: ConversationActor, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, businessId: actor.businessId, deletedAt: null },
    select: {
      id: true,
      businessId: true,
      leadId: true,
      assignedStaffId: true,
      status: true,
      aiEnabled: true,
      humanTakeover: true,
      needsHumanReview: true,
      humanReviewReason: true,
      humanReviewType: true,
      closedAt: true,
    },
  });
  if (!conversation) throw new AppError(404, "Conversation not found.", "CONVERSATION_NOT_FOUND");
  if (!canAccessConversation(actor, conversation)) {
    throw new AppError(403, "You do not have access to this conversation.", "CONVERSATION_ACCESS_DENIED");
  }
  return conversation;
}

async function activeRecipients(input: {
  businessId: string;
  businessAccountId: string | null;
  assignedStaffId: string | null;
}) {
  let planCode: PlanCode = PlanCode.BASIC;
  if (input.businessAccountId) {
    try {
      const subscription = await subscriptionService.getCurrentRecord(input.businessAccountId);
      planCode = subscription.plan.code;
    } catch {
      planCode = PlanCode.BASIC;
    }
  }
  const recipientWhere: Prisma.BusinessMemberWhereInput = {
    businessId: input.businessId,
    status: MembershipStatus.ACTIVE,
    OR: [
      { role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] } },
      ...(planCode !== PlanCode.BASIC && input.assignedStaffId ? [{ id: input.assignedStaffId }] : []),
    ],
  };
  const recipients = await prisma.businessMember.findMany({
    where: recipientWhere,
    select: { id: true },
  });
  return Array.from(new Set(recipients.map((recipient) => recipient.id)));
}

function reviewEventPayload(input: {
  businessId: string;
  conversationId: string;
  status: ConversationStatus;
  needsHumanReview: boolean;
  humanReviewType?: HumanReviewType | null;
  reason?: string | null;
}) {
  return {
    businessId: input.businessId,
    conversationId: input.conversationId,
    status: input.status,
    needsHumanReview: input.needsHumanReview,
    humanReviewType: input.humanReviewType ?? null,
    reason: input.reason ?? null,
  };
}

export function humanReviewTypeForBlockedAi(input: {
  status?: string | null;
  intent?: string | null;
  reason?: string | null;
  errorCode?: string | null;
}) {
  const reason = `${input.reason ?? ""} ${input.errorCode ?? ""}`.toLowerCase();
  if (input.status === "BLOCKED_LOW_CONFIDENCE") return HumanReviewType.LOW_CONFIDENCE;
  if (input.status === "AI_FALLBACK_EXHAUSTED" || input.errorCode === "AI_FALLBACK_EXHAUSTED") return HumanReviewType.AI_PROVIDER_FAILED;
  if (input.status === "BLOCKED_QUOTA" || input.errorCode === "AI_QUOTA_EXCEEDED") return HumanReviewType.QUOTA_EXCEEDED;
  if (input.intent === "HUMAN_REQUEST" || /human|person|agent|staff/.test(reason)) return HumanReviewType.CUSTOMER_REQUESTED_HUMAN;
  if (input.intent === "COMPLAINT" || /complaint|angry|dispute|issue/.test(reason)) return HumanReviewType.COMPLAINT;
  if (input.intent === "PAYMENT_QUESTION" || /payment|refund|charge|invoice/.test(reason)) return HumanReviewType.PAYMENT_OR_REFUND;
  if (/policy|refund|terms/.test(reason)) return HumanReviewType.POLICY_UNCERTAINTY;
  if (/booking|appointment|slot|service not found|missing/i.test(reason)) return HumanReviewType.BOOKING_UNCLEAR;
  if (input.status === "AI_BUSINESS_NOT_READY" || /context|setup|business.*ready|missing/.test(reason)) return HumanReviewType.MISSING_BUSINESS_CONTEXT;
  return HumanReviewType.SAFETY_BLOCKED;
}

export const aiHumanReviewService = {
  async requestHumanReview(input: RequestHumanReviewInput) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: input.conversationId, businessId: input.businessId, deletedAt: null },
      select: {
        id: true,
        businessId: true,
        leadId: true,
        assignedStaffId: true,
        status: true,
        needsHumanReview: true,
      },
    });
    if (!conversation) throw new AppError(404, "Conversation not found.", "CONVERSATION_NOT_FOUND");
    if (conversation.status === ConversationStatus.CLOSED) {
      throw new AppError(422, "Closed conversations cannot enter human review.", "AI_CONVERSATION_NOT_ELIGIBLE");
    }

    const now = new Date();
    const recipients = await activeRecipients({
      businessId: input.businessId,
      businessAccountId: input.businessAccountId,
      assignedStaffId: conversation.assignedStaffId,
    });

    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          status: ConversationStatus.NEEDS_HUMAN_REVIEW,
          aiEnabled: false,
          humanTakeover: false,
          needsHumanReview: true,
          humanReviewReason: input.reason,
          humanReviewType: input.reviewType,
          humanReviewCreatedAt: conversation.needsHumanReview ? undefined : now,
          humanReviewResolvedAt: null,
          humanReviewResolvedByMembershipId: null,
          lastAiBlockedReason: input.reason,
        },
      });
      await createSystemMessage({
        businessId: input.businessId,
        leadId: conversation.leadId,
        conversationId: conversation.id,
        content: "AI paused for human review.",
        metadata: json({
          type: "AI_HUMAN_REVIEW_REQUIRED",
          reviewType: input.reviewType,
          reason: input.reason,
          messageId: input.messageId ?? null,
          source: input.source,
        }),
      }, tx);
      await tx.auditLog.create({
        data: {
          action: AuditAction.AI_HUMAN_REVIEW_REQUESTED,
          businessId: input.businessId,
          metadata: json({
            businessId: input.businessId,
            conversationId: conversation.id,
            messageId: input.messageId ?? null,
            reviewType: input.reviewType,
            reason: input.reason,
            previousStatus: conversation.status,
            newStatus: ConversationStatus.NEEDS_HUMAN_REVIEW,
            source: input.source,
            ...(input.metadata ?? {}),
          }),
        },
      });
      return record;
    });

    const notifications = await notificationService.createNotificationsForRecipients({
      businessId: input.businessId,
      businessAccountId: input.businessAccountId,
      recipientMembershipIds: recipients,
      type: BusinessNotificationType.AI_HUMAN_REVIEW_REQUIRED,
      priority: input.priority ?? BusinessNotificationPriority.HIGH,
      title: "AI needs human review",
      message: input.reason || "A customer message needs human review before AI can continue.",
      entityType: BusinessNotificationEntityType.CONVERSATION,
      entityId: conversation.id,
      actions: [
        { label: "View conversation", action: "VIEW_CONVERSATION", variant: "default" },
        { label: "Take over", action: "TAKE_OVER_CONVERSATION", variant: "secondary" },
        { label: "Dismiss", action: "DISMISS", variant: "secondary" },
      ],
      metadata: {
        conversationId: conversation.id,
        leadId: conversation.leadId,
        reviewType: input.reviewType,
        reason: input.reason,
        messageId: input.messageId ?? null,
        source: input.source,
      },
    });

    await Promise.all([
      invalidateConversationCache(input.businessId, conversation.id),
      invalidateAiBusinessContext(input.businessId, conversation.id),
    ]);
    realtimeService.publish({
      type: "business.ai.human_review.required",
      businessId: input.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      assignedStaffId: conversation.assignedStaffId,
      payload: reviewEventPayload({
        businessId: input.businessId,
        conversationId: conversation.id,
        status: ConversationStatus.NEEDS_HUMAN_REVIEW,
        needsHumanReview: true,
        humanReviewType: input.reviewType,
        reason: input.reason,
      }),
    });
    realtimeService.publish({
      type: "business.conversation.updated",
      businessId: input.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      assignedStaffId: conversation.assignedStaffId,
      payload: { conversation: updated },
    });
    return { conversation: updated, notifications };
  },

  async takeOverConversation(actor: ConversationActor, conversationId: string, reason: string | null, context: Omit<AuditInput, "action">) {
    const conversation = await loadConversationForActor(actor, conversationId);
    if (conversation.status === ConversationStatus.CLOSED) throw new AppError(422, "Closed conversations cannot be taken over.", "CONVERSATION_CLOSED");
    if (conversation.humanTakeover && conversation.status === ConversationStatus.HUMAN_HANDLING) {
      throw new AppError(409, "Conversation is already in human handling.", "CONVERSATION_ALREADY_HUMAN_HANDLING");
    }
    const assignedStaffId = conversation.assignedStaffId ?? actor.membershipId;
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          status: ConversationStatus.HUMAN_HANDLING,
          humanTakeover: true,
          aiEnabled: false,
          needsHumanReview: false,
          humanReviewResolvedAt: new Date(),
          humanReviewResolvedByMembershipId: actor.membershipId,
          assignedStaffId,
        },
      });
      await createSystemMessage({
        businessId: actor.businessId,
        leadId: conversation.leadId,
        conversationId: conversation.id,
        content: "Human takeover started.",
        metadata: json({ type: "CONVERSATION_HUMAN_TAKEOVER_STARTED", actorMembershipId: actor.membershipId, reason }),
      }, tx);
      return record;
    });
    await Promise.all([
      auditService.log({
        ...context,
        action: AuditAction.CONVERSATION_HUMAN_TAKEOVER_STARTED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: json({
          businessId: actor.businessId,
          conversationId: conversation.id,
          actorMembershipId: actor.membershipId,
          reason,
          previousStatus: conversation.status,
          newStatus: ConversationStatus.HUMAN_HANDLING,
        }),
      }),
      invalidateConversationCache(actor.businessId, conversation.id),
    ]);
    realtimeService.publish({
      type: "business.conversation.human_takeover.started",
      businessId: actor.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      assignedStaffId,
      payload: {
        businessId: actor.businessId,
        conversationId: conversation.id,
        status: ConversationStatus.HUMAN_HANDLING,
        humanTakeover: true,
        aiEnabled: false,
        actorMembershipId: actor.membershipId,
        reason,
      },
    });
    realtimeService.publish({
      type: "business.conversation.updated",
      businessId: actor.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      assignedStaffId,
      payload: { conversation: updated },
    });
    return updated;
  },

  async resumeAiConversation(actor: ConversationActor, conversationId: string, reason: string | null, context: Omit<AuditInput, "action">) {
    const conversation = await loadConversationForActor(actor, conversationId);
    if (conversation.status === ConversationStatus.CLOSED) throw new AppError(422, "Closed conversations cannot resume AI.", "CONVERSATION_CLOSED");
    if (conversation.aiEnabled && !conversation.humanTakeover && !conversation.needsHumanReview && conversation.status === ConversationStatus.AI_HANDLING) {
      throw new AppError(409, "AI is already enabled for this conversation.", "AI_ALREADY_ENABLED");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          status: ConversationStatus.AI_HANDLING,
          humanTakeover: false,
          aiEnabled: true,
          needsHumanReview: false,
          humanReviewResolvedAt: new Date(),
          humanReviewResolvedByMembershipId: actor.membershipId,
        },
      });
      await createSystemMessage({
        businessId: actor.businessId,
        leadId: conversation.leadId,
        conversationId: conversation.id,
        content: "AI replies resumed.",
        metadata: json({ type: "CONVERSATION_AI_RESUMED", actorMembershipId: actor.membershipId, reason }),
      }, tx);
      return record;
    });
    await Promise.all([
      auditService.log({
        ...context,
        action: AuditAction.CONVERSATION_AI_RESUMED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: json({
          businessId: actor.businessId,
          conversationId: conversation.id,
          actorMembershipId: actor.membershipId,
          reason,
          previousStatus: conversation.status,
          newStatus: ConversationStatus.AI_HANDLING,
        }),
      }),
      invalidateConversationCache(actor.businessId, conversation.id),
    ]);
    realtimeService.publish({
      type: "business.conversation.ai_resumed",
      businessId: actor.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      payload: {
        businessId: actor.businessId,
        conversationId: conversation.id,
        status: ConversationStatus.AI_HANDLING,
        humanTakeover: false,
        aiEnabled: true,
        actorMembershipId: actor.membershipId,
        reason,
      },
    });
    realtimeService.publish({
      type: "business.conversation.updated",
      businessId: actor.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      payload: { conversation: updated },
    });
    return updated;
  },

  async resolveHumanReview(input: ResolutionInput) {
    await prisma.conversation.updateMany({
      where: { id: input.conversationId, businessId: input.businessId },
      data: {
        needsHumanReview: false,
        humanReviewResolvedAt: new Date(),
        humanReviewResolvedByMembershipId: input.actorMembershipId,
      },
    });
  },
};
