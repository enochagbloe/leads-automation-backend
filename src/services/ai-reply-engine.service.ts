import {
  BusinessRole,
  ConversationChannel,
  ConversationStatus,
  LeadActivityAction,
  AppointmentConfirmationSource,
  AppointmentLocationType,
  AppointmentSource,
  AppointmentStatus,
  HumanReviewType,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageType,
  PlanCode,
  Prisma,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { AiBusinessContext, aiBusinessContextService, aiPromptContextFormatter } from "./ai-context-builder.service";
import { fallbackHumanReviewDecision } from "./ai-decision-parser.service";
import { aiProvider, AiGenerateReplyResult } from "./ai-provider.service";
import { aiSafetyService, AiSafetyResult } from "./ai-safety.service";
import { aiUsageService } from "./ai-usage.service";
import { cacheService } from "./cache.service";
import { realtimeService } from "./realtime.service";
import { getWhatsAppIntegration, sendWhatsAppText } from "./whatsapp-provider.service";
import { appointmentInternalService } from "./appointment.service";
import { aiHumanReviewService, humanReviewTypeForBlockedAi } from "./ai-human-review.service";
import { customerIssueService } from "./customer-issue.service";

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
  | "SUCCESS_AUTO_REPLIED"
  | "SUCCESS_BOOKING_REQUEST_CREATED"
  | "BLOCKED_UNAVAILABLE_SLOT"
  | "BLOCKED_MISSING_CONTEXT"
  | "BLOCKED_UNSAFE"
  | "AI_BUSINESS_NOT_READY"
  | "SKIPPED";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

const aiBookingAppointmentInclude = {
  service: {
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      bufferMinutes: true,
      isBookable: true,
      autoConfirmEligible: true,
      requiresManualApproval: true,
      requiresPayment: true,
      paymentRequiredBeforeBooking: true,
      requiresDepositBeforeConfirmation: true,
      requiresLocationBeforeConfirmation: true,
      requiresStaffAssignment: true,
      isActive: true,
      isArchived: true,
      readinessStatus: true,
    },
  },
  lead: { select: { id: true, fullName: true, phone: true, email: true, status: true } },
  conversation: { select: { id: true, displayId: true, channel: true, status: true, subject: true } },
  assignedStaff: {
    select: {
      id: true,
      role: true,
      status: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  updatedBy: { select: { id: true, firstName: true, lastName: true } },
  confirmedBy: { select: { id: true, firstName: true, lastName: true } },
  lastRescheduledBy: {
    select: {
      id: true,
      role: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
  outcomeConfirmedBy: {
    select: {
      id: true,
      role: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
} satisfies Prisma.AppointmentInclude;

type AiBookingAppointment = Prisma.AppointmentGetPayload<{ include: typeof aiBookingAppointmentInclude }>;

function isManager(actor: AiReplyActor) {
  return actor.role === BusinessRole.BUSINESS_OWNER || actor.role === BusinessRole.MANAGER;
}

function safeProviderError(error: unknown) {
  if (error instanceof AppError) return error.code;
  return "AI_PROVIDER_ERROR";
}

function isComplaintDecision(decision: { intent?: string | null; complaint?: { isComplaint?: boolean } } | undefined) {
  return decision?.intent === "COMPLAINT" || decision?.complaint?.isComplaint === true;
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

function businessReadyForAi(readiness: { isAiReady: boolean; completionPercentage: number }) {
  return readiness.isAiReady || readiness.completionPercentage > 0;
}

async function markConversationNeedsHumanReview(input: {
  businessId: string;
  businessAccountId: string | null;
  conversationId: string;
  leadId: string;
  assignedStaffId: string | null;
  accountUsageId?: string;
  reason: string;
  messageId?: string | null;
  reviewType?: HumanReviewType;
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  const result = await aiHumanReviewService.requestHumanReview({
    businessId: input.businessId,
    businessAccountId: input.businessAccountId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    reviewType: input.reviewType ?? HumanReviewType.SAFETY_BLOCKED,
    reason: input.reason,
    source: input.source ?? "AI_REPLY_ENGINE",
    metadata: input.metadata,
  });
  await Promise.all([
    input.accountUsageId ? aiUsageService.trackBlocked({ accountUsageId: input.accountUsageId, humanReview: true }) : Promise.resolve(),
    invalidateConversationCaches(input.businessId, input.conversationId, input.leadId),
  ]);
  realtimeService.publish({
    type: "business.ai.reply.blocked",
    businessId: input.businessId,
    conversationId: input.conversationId,
    leadId: input.leadId,
    assignedStaffId: input.assignedStaffId,
    payload: {
      conversationId: input.conversationId,
      reason: input.reason,
      needsHumanReview: true,
      notificationsCreated: result.notifications.length,
    },
  });
  return result.notifications;
}

async function ownerActorForBusiness(input: { businessId: string; businessAccountId: string }): Promise<AiReplyActor> {
  const owner = await prisma.businessMember.findFirst({
    where: { businessId: input.businessId, role: BusinessRole.BUSINESS_OWNER, status: "ACTIVE" },
    select: { id: true, userId: true, role: true },
  });
  if (!owner) throw new AppError(422, "Business owner membership is required for AI booking requests.", "AI_BOOKING_BUSINESS_NOT_READY");
  return {
    userId: owner.userId,
    businessAccountId: input.businessAccountId,
    businessId: input.businessId,
    membershipId: owner.id,
    role: owner.role,
  };
}

function normalizeName(value?: string | null) {
  return value?.trim().toLowerCase();
}

function validDate(value?: string) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function validTime(value?: string) {
  return Boolean(value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
}

function confirmedAppointmentReply(appointment: { service?: { name: string } | null; title: string; startTime: Date; timezone: string }) {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(appointment.startTime);
  const serviceName = appointment.service?.name ?? appointment.title;
  return `Your ${serviceName} appointment is confirmed for ${when}. We’ll see you then.`;
}

function bookingIdempotencyKey(input: { businessId: string; conversationId: string; messageId: string }) {
  return `ai_booking:${input.businessId}:${input.conversationId}:${input.messageId}:CREATE_BOOKING_REQUEST`;
}

async function appointmentFromBookingLog(appointmentId: string, businessId: string) {
  return prisma.appointment.findFirst({
    where: { id: appointmentId, businessId },
    include: aiBookingAppointmentInclude,
  });
}

async function waitForExistingBookingAppointment(input: { key: string; businessId: string }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await prisma.aiInteractionLog.findUnique({
      where: { bookingIdempotencyKey: input.key },
      select: { appointmentId: true },
    });
    if (existing?.appointmentId) {
      const appointment = await appointmentFromBookingLog(existing.appointmentId, input.businessId);
      if (appointment) return appointment;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function createAiBookingRequest(input: {
  context: AiBusinessContext;
  businessAccountId: string;
  conversationId: string;
  leadId: string;
  messageId: string;
  decision: NonNullable<AiSafetyResult["decision"]>;
}): Promise<AiBookingAppointment> {
  const key = bookingIdempotencyKey({
    businessId: input.context.business.id,
    conversationId: input.conversationId,
    messageId: input.messageId,
  });
  const previous = await prisma.aiInteractionLog.findUnique({
    where: { bookingIdempotencyKey: key },
    select: { appointmentId: true },
  });
  if (previous?.appointmentId) {
    const appointment = await appointmentFromBookingLog(previous.appointmentId, input.context.business.id);
    if (appointment) return appointment;
  }
  try {
    await prisma.aiInteractionLog.create({
      data: {
        businessId: input.context.business.id,
        businessAccountId: input.businessAccountId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        provider: "OPENROUTER",
        model: env.OPENROUTER_DEFAULT_MODEL ?? "unknown",
        suggestedAction: "CREATE_BOOKING_REQUEST",
        shouldReply: false,
        requiresHumanReview: false,
        bookingRequestCreated: false,
        bookingIdempotencyKey: key,
        latencyMs: 0,
        status: "BOOKING_REQUEST_IN_PROGRESS",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const appointment = await waitForExistingBookingAppointment({ key, businessId: input.context.business.id });
      if (appointment) return appointment;
      throw new AppError(409, "AI booking request is already being processed for this message.", "AI_BOOKING_REQUEST_IN_PROGRESS");
    }
    throw error;
  }

  const intent = input.decision.appointmentIntent;
  const missing = new Set(intent?.missingFields ?? []);
  if (!intent?.serviceId && !intent?.serviceName) missing.add("service");
  if (!validDate(intent?.preferredDate)) missing.add("preferredDate");
  if (!validTime(intent?.preferredTime)) missing.add("preferredTime");
  if (missing.size) {
    throw new AppError(422, "AI booking request is missing required details.", "AI_BOOKING_MISSING_FIELDS", { missingFields: [...missing] });
  }

  const service = input.context.services.find((item) => item.id === intent?.serviceId)
    ?? input.context.services.find((item) => normalizeName(item.name) === normalizeName(intent?.serviceName));
  if (!service) throw new AppError(404, "AI booking service was not found.", "AI_BOOKING_SERVICE_NOT_FOUND");
  if (!service.isBookable) throw new AppError(422, "AI booking service is not bookable.", "AI_BOOKING_SERVICE_NOT_BOOKABLE");

  const actor = await ownerActorForBusiness({ businessId: input.context.business.id, businessAccountId: input.businessAccountId });
  const locationNote = intent?.customerLocation ? ` Customer location mentioned: ${intent.customerLocation}.` : "";
  const appointment = await appointmentInternalService.createAppointmentFromValidatedInput(actor, {
    leadId: input.leadId,
    conversationId: input.conversationId,
    serviceId: service.id,
    assignedStaffId: null,
    customerName: intent?.customerName ?? input.context.lead?.name ?? null,
    customerPhone: intent?.customerPhone ?? input.context.lead?.phone ?? null,
    customerEmail: input.context.lead?.email ?? null,
    title: `${service.name} request`,
    description: "Appointment request created from AI-detected booking intent.",
    notes: `${intent?.notes ?? input.decision.reason}${locationNote}`,
    date: intent!.preferredDate!,
    time: intent!.preferredTime!,
    timezone: intent?.timezone ?? input.context.business.timezone ?? "Africa/Accra",
    durationMinutes: service.durationMinutes ?? undefined,
    locationType: AppointmentLocationType.TO_BE_CONFIRMED,
    location: null,
    source: AppointmentSource.AI_CONVERSATION,
    aiDecision: {
      confidence: input.decision.confidence,
      intent: input.decision.intent,
      reason: input.decision.reason,
      requiresHumanReview: input.decision.requiresHumanReview,
      suggestedAction: input.decision.suggestedAction,
    },
  }, { ipAddress: undefined, userAgent: undefined });
  await prisma.aiInteractionLog.update({
    where: { bookingIdempotencyKey: key },
    data: {
      bookingRequestCreated: true,
      appointmentId: appointment.id,
      intent: input.decision.intent,
      confidence: input.decision.confidence,
      suggestedAction: input.decision.suggestedAction,
      shouldReply: input.decision.shouldReply,
      requiresHumanReview: input.decision.requiresHumanReview,
      blockedReason: null,
      status: "BOOKING_REQUEST_CREATED",
    },
  });
  return appointment;
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
  plan?: PlanCode | null;
  quotaStatus?: string | null;
  replySent?: boolean;
  whatsappSendFailed?: boolean;
  bookingRequestCreated?: boolean;
  appointmentId?: string | null;
  humanReviewNotificationCreated?: boolean;
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
      plan: input.plan ?? null,
      quotaStatus: input.quotaStatus ?? null,
      replySent: input.replySent ?? false,
      whatsappSendFailed: input.whatsappSendFailed ?? false,
      bookingRequestCreated: input.bookingRequestCreated ?? false,
      appointmentId: input.appointmentId ?? null,
      humanReviewNotificationCreated: input.humanReviewNotificationCreated ?? false,
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
        business: {
          select: {
            id: true,
            businessAccountId: true,
            deletedAt: true,
            aiRepliesEnabled: true,
            aiAutoReplyEnabled: true,
            aiHandoffOnLowConfidence: true,
            aiMinConfidence: true,
          },
        },
        lead: { select: { id: true, phone: true, assignedStaffId: true } },
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
    if (conversation.status === ConversationStatus.NEEDS_HUMAN_REVIEW || conversation.humanTakeover) {
      throw new AppError(422, "AI cannot process a conversation that needs human review.", "AI_CONVERSATION_NOT_ELIGIBLE");
    }
    if (conversation.aiEnabled === false) {
      throw new AppError(403, "AI is disabled for this conversation.", "AI_DISABLED");
    }
    if (!conversation.business.aiRepliesEnabled) {
      throw new AppError(403, "AI replies are disabled for this business.", "AI_DISABLED");
    }
    if (!conversation.business.aiAutoReplyEnabled) {
      throw new AppError(403, "AI auto-reply is disabled for this business.", "AI_AUTO_REPLY_DISABLED");
    }

    const message = await latestCustomerMessage(input.businessId, conversation.id, input.messageId);
    if (!message) throw new AppError(404, "Customer message not found.", "AI_MESSAGE_NOT_FOUND");
    if (message.senderType !== MessageSenderType.CUSTOMER || message.direction !== MessageDirection.INBOUND) {
      throw new AppError(422, "AI only processes inbound customer messages.", "AI_MESSAGE_NOT_FOUND");
    }
    if (message.messageType !== MessageType.TEXT && message.messageType !== MessageType.SYSTEM) {
      const decision = fallbackHumanReviewDecision("Customer sent media that AI image understanding does not support yet.");
      const notifications = await markConversationNeedsHumanReview({
        businessId: conversation.businessId,
        businessAccountId: conversation.business.businessAccountId,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        assignedStaffId: conversation.assignedStaffId,
        reason: decision.reason,
        messageId: message.id,
        reviewType: HumanReviewType.MEDIA_OR_IMAGE_UNSUPPORTED,
        source: "AI_MEDIA_GUARD",
      });
      await logInteraction({
        businessId: conversation.businessId,
        businessAccountId: conversation.business.businessAccountId,
        conversationId: conversation.id,
        messageId: message.id,
        safety: { allowed: false, decision, status: "BLOCKED_POLICY", blockedReason: decision.reason },
        status: "BLOCKED_UNSAFE",
        blockedReason: decision.reason,
        quotaStatus: "NOT_CHECKED",
        humanReviewNotificationCreated: notifications.length > 0,
      });
      return { status: "BLOCKED_UNSAFE", blocked: true, decision };
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

    let usage: Awaited<ReturnType<typeof aiUsageService.assertCanUseAiReplies>>;
    try {
      usage = await aiUsageService.assertCanUseAiReplies(conversation.business.businessAccountId);
    } catch (error) {
      if (error instanceof AppError && error.code === "AI_QUOTA_EXCEEDED") {
        const decision = fallbackHumanReviewDecision("AI reply limit reached for this month. Please reply manually or upgrade your plan.");
        const notifications = await markConversationNeedsHumanReview({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          leadId: conversation.leadId,
          assignedStaffId: conversation.assignedStaffId,
          reason: decision.reason,
          messageId: message.id,
          reviewType: HumanReviewType.QUOTA_EXCEEDED,
          source: "AI_QUOTA",
        });
        await logInteraction({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          messageId: message.id,
          safety: { allowed: false, decision, status: "BLOCKED_POLICY", blockedReason: decision.reason },
          status: "BLOCKED_QUOTA",
          errorCode: error.code,
          blockedReason: decision.reason,
          plan: (error.context?.currentPlan as PlanCode | undefined) ?? null,
          quotaStatus: "EXCEEDED",
          humanReviewNotificationCreated: notifications.length > 0,
        });
        return { status: "BLOCKED_QUOTA", blocked: true, decision };
      }
      throw error;
    }
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
        const notifications = await markConversationNeedsHumanReview({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          leadId: conversation.leadId,
          assignedStaffId: conversation.assignedStaffId,
          accountUsageId: usage.usage.id,
          reason: fallbackDecision.reason,
          messageId: message.id,
          reviewType: HumanReviewType.AI_PROVIDER_FAILED,
          source: "AI_PROVIDER_FALLBACK",
        });
        await Promise.all([
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
            plan: usage.subscription.plan.code,
            quotaStatus: "OK",
            humanReviewNotificationCreated: notifications.length > 0,
          }),
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
        minConfidence: conversation.business.aiMinConfidence ?? undefined,
      });
      if (!safety.allowed) {
        const reviewReason = safety.blockedReason ?? safety.decision.reason;
        const reviewType = humanReviewTypeForBlockedAi({
          status: safety.status,
          intent: safety.decision.intent,
          reason: reviewReason,
        });
        const notifications = await markConversationNeedsHumanReview({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          leadId: conversation.leadId,
          assignedStaffId: conversation.assignedStaffId,
          accountUsageId: usage.usage.id,
          reason: reviewReason,
          messageId: message.id,
          reviewType,
          source: "AI_SAFETY",
          metadata: {
            intent: safety.decision.intent,
            confidence: safety.decision.confidence,
          },
        });
        if (isComplaintDecision(safety.decision)) {
          await customerIssueService.createFromAiDecision({
            businessId: conversation.businessId,
            businessAccountId: conversation.business.businessAccountId,
            conversationId: conversation.id,
            leadId: conversation.leadId,
            customerMessageId: message.id,
            customerMessageContent: message.content,
            conversationAssignedMembershipId: conversation.assignedStaffId,
            clientOwnerMembershipId: conversation.lead.assignedStaffId,
            decision: safety.decision,
            accountUsageId: usage.usage.id,
            plan: usage.subscription.plan.code,
          }).catch((error) => console.error("Blocked complaint issue side effects failed", error));
        }
        await Promise.all([
          logInteraction({
            businessId: conversation.businessId,
            businessAccountId: conversation.business.businessAccountId,
            conversationId: conversation.id,
            messageId: message.id,
            providerResult,
            safety,
            status: safety.status,
            blockedReason: reviewReason,
            plan: usage.subscription.plan.code,
            quotaStatus: "OK",
            humanReviewNotificationCreated: notifications.length > 0,
          }),
        ]);
        return { status: safety.status, blocked: true, decision: safety.decision };
      }

      let bookingAppointment: AiBookingAppointment | null = null;
      let bookingRequestCreated = false;
      let bookingBlockedReason: string | null = null;
      let replyText = safety.decision.replyText ?? "";
      let successStatus: AiExecutionStatus = "SUCCESS_AUTO_REPLIED";
      if (safety.decision.suggestedAction === "CREATE_BOOKING_REQUEST") {
        try {
          bookingAppointment = await createAiBookingRequest({
            context,
            businessAccountId: conversation.business.businessAccountId,
            conversationId: conversation.id,
            leadId: conversation.leadId,
            messageId: message.id,
            decision: safety.decision,
          });
          bookingRequestCreated = true;
          successStatus = "SUCCESS_BOOKING_REQUEST_CREATED";
          replyText = bookingAppointment.status === AppointmentStatus.CONFIRMED
            && bookingAppointment.confirmationSource === AppointmentConfirmationSource.AI_PREMIUM_AUTO_CONFIRM
            ? confirmedAppointmentReply(bookingAppointment)
            : "Thanks. I’ve sent your appointment request to the business team for confirmation. They’ll confirm the final appointment shortly.";
          await aiUsageService.trackBookingRequest({ accountUsageId: usage.usage.id });
          realtimeService.publish({
            type: "business.ai.booking_request.created",
            businessId: conversation.businessId,
            conversationId: conversation.id,
            leadId: conversation.leadId,
            assignedStaffId: conversation.assignedStaffId,
            payload: {
              conversationId: conversation.id,
              appointmentId: bookingAppointment.id,
              appointmentStatus: bookingAppointment.status,
              sourceMessageId: message.id,
            },
          });
        } catch (error) {
          const code = error instanceof AppError ? error.code : "AI_BOOKING_REQUEST_FAILED";
          bookingBlockedReason = code;
          if (code === "AI_BOOKING_MISSING_FIELDS") {
            replyText = safety.decision.replyText
              ?? "I can help request that appointment. Please share the service, preferred date, and preferred time.";
          } else if (safety.decision.replyText && ["APPOINTMENT_SLOT_UNAVAILABLE", "APPOINTMENT_OUTSIDE_BUSINESS_HOURS", "APPOINTMENT_OVERLAPS_BREAK_TIME"].includes(code)) {
            replyText = safety.decision.replyText;
            successStatus = "BLOCKED_UNAVAILABLE_SLOT";
          } else {
            const fallbackDecision = fallbackHumanReviewDecision(code);
            const notifications = await markConversationNeedsHumanReview({
              businessId: conversation.businessId,
              businessAccountId: conversation.business.businessAccountId,
              conversationId: conversation.id,
              leadId: conversation.leadId,
              assignedStaffId: conversation.assignedStaffId,
              accountUsageId: usage.usage.id,
              reason: code,
              messageId: message.id,
              reviewType: humanReviewTypeForBlockedAi({
                status: "BLOCKED_MISSING_CONTEXT",
                intent: safety.decision.intent,
                reason: code,
                errorCode: code,
              }),
              source: "AI_BOOKING_REQUEST",
            });
            await logInteraction({
              businessId: conversation.businessId,
              businessAccountId: conversation.business.businessAccountId,
              conversationId: conversation.id,
              messageId: message.id,
              providerResult,
              safety: { allowed: false, decision: fallbackDecision, status: "BLOCKED_POLICY", blockedReason: code },
              status: "BLOCKED_MISSING_CONTEXT",
              errorCode: code,
              blockedReason: code,
              plan: usage.subscription.plan.code,
              quotaStatus: "OK",
              humanReviewNotificationCreated: notifications.length > 0,
            });
            return { status: "BLOCKED_MISSING_CONTEXT", blocked: true, decision: fallbackDecision };
          }
        }
      }
      if (!replyText.trim()) {
        const fallbackDecision = fallbackHumanReviewDecision("AI did not provide a reply to send.");
        const notifications = await markConversationNeedsHumanReview({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          leadId: conversation.leadId,
          assignedStaffId: conversation.assignedStaffId,
          accountUsageId: usage.usage.id,
          reason: fallbackDecision.reason,
          messageId: message.id,
          reviewType: HumanReviewType.SAFETY_BLOCKED,
          source: "AI_REPLY_VALIDATION",
        });
        await logInteraction({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          messageId: message.id,
          providerResult,
          safety: { allowed: false, decision: fallbackDecision, status: "BLOCKED_POLICY", blockedReason: fallbackDecision.reason },
          status: "BLOCKED_POLICY",
          blockedReason: fallbackDecision.reason,
          plan: usage.subscription.plan.code,
          quotaStatus: "OK",
          humanReviewNotificationCreated: notifications.length > 0,
        });
        return { status: "BLOCKED_POLICY", blocked: true, decision: fallbackDecision };
      }
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
              bookingRequestCreated,
              bookingBlockedReason,
              appointmentId: bookingAppointment?.id ?? null,
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
              bookingRequestCreated,
              appointmentId: bookingAppointment?.id ?? null,
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

      const customerIssueResult = isComplaintDecision(safety.decision)
        ? await customerIssueService.createFromAiDecision({
          businessId: conversation.businessId,
          businessAccountId: conversation.business.businessAccountId,
          conversationId: conversation.id,
          leadId: conversation.leadId,
          customerMessageId: message.id,
          customerMessageContent: message.content,
          conversationAssignedMembershipId: conversation.assignedStaffId,
          clientOwnerMembershipId: conversation.lead.assignedStaffId,
          decision: safety.decision,
          accountUsageId: usage.usage.id,
          plan: usage.subscription.plan.code,
        }).catch((error) => {
          console.error("Customer issue side effects failed", {
            businessId: conversation.businessId,
            conversationId: conversation.id,
            messageId: message.id,
            error,
          });
          return null;
        })
        : null;

      const finalStatus: AiExecutionStatus = deliveryStatus === MessageDeliveryStatus.FAILED ? "WHATSAPP_SEND_FAILED" : successStatus;
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
          blockedReason: bookingBlockedReason,
          plan: usage.subscription.plan.code,
          quotaStatus: "OK",
          replySent: deliveryStatus !== MessageDeliveryStatus.FAILED,
          whatsappSendFailed: deliveryStatus === MessageDeliveryStatus.FAILED,
          bookingRequestCreated,
          appointmentId: bookingAppointment?.id ?? null,
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
        type: finalStatus === "WHATSAPP_SEND_FAILED" ? "business.ai.reply.failed" : "business.ai.reply.completed",
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
          status: finalStatus,
          bookingRequestCreated,
          appointmentId: bookingAppointment?.id ?? null,
          customerIssueCreated: Boolean(customerIssueResult && "issue" in customerIssueResult),
        },
      });
      return { status: finalStatus, blocked: false, message: settledMessage, decision: safety.decision, customerIssue: customerIssueResult };
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
        plan: usage.subscription.plan.code,
        quotaStatus: errorCode === "AI_QUOTA_EXCEEDED" ? "EXCEEDED" : "OK",
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
