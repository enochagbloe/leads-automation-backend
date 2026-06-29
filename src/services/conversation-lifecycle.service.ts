import { AuditAction, ConversationStatus, LeadActivityAction, Prisma } from "@prisma/client";

type ReopenSource = "CUSTOMER_INBOUND" | "FOLLOW_UP_AUTOMATION" | "AI_MESSAGE" | "SYSTEM_MESSAGE";
export type ReopenState = {
  status: ConversationStatus;
  aiEnabled: boolean;
  humanTakeover: boolean;
  needsHumanReview: boolean;
};

function reasonForSource(source: ReopenSource) {
  if (source === "CUSTOMER_INBOUND") return "Conversation reopened by customer message.";
  if (source === "FOLLOW_UP_AUTOMATION") return "Conversation reopened by follow-up automation.";
  if (source === "AI_MESSAGE") return "Conversation reopened by AI message.";
  return "Conversation reopened by system message.";
}

function defaultReopenState(source: ReopenSource): ReopenState {
  if (source === "AI_MESSAGE") {
    return {
      status: ConversationStatus.AI_HANDLING,
      aiEnabled: true,
      humanTakeover: false,
      needsHumanReview: false,
    };
  }
  return {
    status: ConversationStatus.OPEN,
    aiEnabled: false,
    humanTakeover: false,
    needsHumanReview: false,
  };
}

export async function reopenConversationFromMessageActivity(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    leadId: string;
    conversationId: string;
    source: ReopenSource;
    actorUserId?: string | null;
    actorMembershipId?: string | null;
    metadata?: Prisma.InputJsonValue;
    reopenAs?: Partial<ReopenState>;
  },
) {
  const conversation = await tx.conversation.findFirst({
    where: {
      id: input.conversationId,
      businessId: input.businessId,
      leadId: input.leadId,
      deletedAt: null,
    },
    select: { id: true, status: true },
  });
  if (!conversation || conversation.status !== ConversationStatus.CLOSED) return { reopened: false };

  const reopenState = { ...defaultReopenState(input.source), ...input.reopenAs };
  const reopened = await tx.conversation.updateMany({
    where: {
      id: input.conversationId,
      businessId: input.businessId,
      leadId: input.leadId,
      status: ConversationStatus.CLOSED,
      deletedAt: null,
    },
    data: {
      status: reopenState.status,
      closedAt: null,
      aiEnabled: reopenState.aiEnabled,
      humanTakeover: reopenState.humanTakeover,
      needsHumanReview: reopenState.needsHumanReview,
      humanReviewResolvedAt: null,
      humanReviewResolvedByMembershipId: null,
    },
  });
  if (reopened.count !== 1) return { reopened: false };

  await tx.leadActivity.create({
    data: {
      businessId: input.businessId,
      leadId: input.leadId,
      actorUserId: input.actorUserId ?? undefined,
      action: LeadActivityAction.CONVERSATION_REOPENED,
      metadata: {
        conversationId: input.conversationId,
        source: input.source,
        reason: reasonForSource(input.source),
        previousStatus: ConversationStatus.CLOSED,
        newStatus: reopenState.status,
        actorMembershipId: input.actorMembershipId ?? null,
        ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}),
      },
    },
  });
  await tx.auditLog.create({
    data: {
      action: AuditAction.CONVERSATION_REOPENED,
      businessId: input.businessId,
      userId: input.actorUserId ?? undefined,
      actorMembershipId: input.actorMembershipId ?? undefined,
      metadata: {
        conversationId: input.conversationId,
        leadId: input.leadId,
        source: input.source,
        reason: reasonForSource(input.source),
        previousStatus: ConversationStatus.CLOSED,
        newStatus: reopenState.status,
        ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}),
      },
    },
  });

  return {
    reopened: true,
    changes: {
      status: reopenState.status,
      closedAt: null,
      aiEnabled: reopenState.aiEnabled,
      humanTakeover: reopenState.humanTakeover,
      needsHumanReview: reopenState.needsHumanReview,
    },
  };
}
