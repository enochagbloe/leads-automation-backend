import {
  AiPromptScope,
  AppointmentRescheduleRequestStatus,
  AppointmentStatus,
  AuditAction,
  BusinessStatus,
  ConversationStatus,
  CustomerIssueStatus,
  FollowUpJobStatus,
  FollowUpContextType,
  FollowUpRuleType,
  FollowUpSendLogDeliveryStatus,
  LeadActivityAction,
  LeadStatus,
  MessageDirection,
  MessageSenderType,
  PlanCode,
  PremiumFollowUpSequenceStage,
  SubscriptionStatus,
  WhatsAppIntegrationStatus,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { aiPromptCapabilityService } from "../ai-prompt/capability/ai-prompt-capability.service";
import { FollowUpPromptCompiled } from "../ai-prompt/core/ai-prompt.types";
import { sanitizeCompiledPromptForRuntime } from "../ai-prompt/resolution/ai-prompt-runtime-sanitizer.service";
import { auditService } from "../audit.service";
import {
  PremiumFollowUpDecisionContextResult,
  PremiumFollowUpPromptVersions,
  followUpPremiumDecisionContextService,
} from "./follow-up-premium-decision-context.service";
import {
  PremiumFollowUpLifecycleFacts,
  PremiumFollowUpScheduleValidation,
  PremiumFollowUpValidationStatus,
  validatePremiumFollowUpLifecycle,
} from "./follow-up-premium-lifecycle-policy";
import { defaultMonthlyLimit } from "./follow-up-policy.service";
import {
  businessHoursFollowUpDecision,
  FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES,
  followUpActivityBaseline,
  json,
} from "./follow-up.shared";

const ACTIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
];
const CONNECTED_WHATSAPP_STATUSES: WhatsAppIntegrationStatus[] = [
  WhatsAppIntegrationStatus.CONNECTED,
  WhatsAppIntegrationStatus.MOCK_CONNECTED,
];
const ACTIVE_COMPLAINT_STATUSES: CustomerIssueStatus[] = [
  CustomerIssueStatus.OPEN,
  CustomerIssueStatus.ACKNOWLEDGED,
  CustomerIssueStatus.REOPENED,
];
const ELIGIBLE_JOB_STATUSES: FollowUpJobStatus[] = [
  FollowUpJobStatus.SCHEDULED,
  FollowUpJobStatus.PROCESSING,
];
const SUPPORTED_PREMIUM_TYPES: FollowUpRuleType[] = [
  FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE,
  FollowUpRuleType.BEFORE_APPOINTMENT,
  FollowUpRuleType.AFTER_APPOINTMENT,
  FollowUpRuleType.STALE_LEAD,
  FollowUpRuleType.CONTACT_EMAIL_REQUEST,
];
const MAX_PREMIUM_ATTEMPTS = 3;
const MIN_FOLLOW_UP_DELAY_MS = 5 * 60_000;
const MAX_FOLLOW_UP_DELAY_MS = 30 * 24 * 60 * 60_000;

export type PremiumFollowUpLatestEntityVersions = {
  evaluatedAt: string;
  jobUpdatedAt: string | null;
  ruleUpdatedAt: string | null;
  conversationUpdatedAt: string | null;
  leadUpdatedAt: string | null;
  appointmentUpdatedAt: string | null;
  appointmentStartTime: string | null;
  complaintUpdatedAt: string | null;
  lastCustomerActivityAt: string | null;
  lastStaffActivityAt: string | null;
  promptActivatedAt: string | null;
};

export type PremiumFollowUpLifecycleValidationResult = {
  originalRecommendation: {
    decision: PremiumFollowUpDecisionContextResult["decision"];
    reason: string;
  };
  finalDecision: PremiumFollowUpDecisionContextResult["decision"];
  validationStatus: PremiumFollowUpValidationStatus;
  validationReason: string;
  businessId: string | null;
  conversationId: string | null;
  customerId: string | null;
  followUpJobId: string;
  followUpRuleId: string | null;
  contextType: FollowUpContextType | null;
  appointmentId: string | null;
  complaintId: string | null;
  complaintStatus: CustomerIssueStatus | null;
  customerGoal: string | null;
  customerObjection: string | null;
  customerTiming: string | null;
  unresolvedRequest: string | null;
  leadStatus: LeadStatus | null;
  appointmentStatus: AppointmentStatus | null;
  assignedStaffId: string | null;
  promptVersions: PremiumFollowUpPromptVersions;
  memoryVersion: string | null;
  sequenceStage: PremiumFollowUpSequenceStage;
  successfulAttemptCount: number;
  effectiveAttemptLimit: number;
  proposedFollowUpAt: string | null;
  validatedFollowUpAt: string | null;
  adjustedSchedule: boolean;
  staleDecision: boolean;
  executionBlocked: boolean;
  blockReason: string | null;
  cancelSequenceRequired: boolean;
  supersedeRequired: boolean;
  escalationRequired: boolean;
  promptConflict: boolean;
  promptConflictReason: string | null;
  hardRulesApplied: string[];
  latestEntityVersions: PremiumFollowUpLatestEntityVersions;
  fallbacksUsed: string[];
};

function validDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function followUpConfig(value: unknown): FollowUpPromptCompiled | null {
  const compiled = objectValue(value);
  const followUp = objectValue(compiled.followUp);
  return Object.keys(followUp).length ? followUp as FollowUpPromptCompiled : null;
}

function validWhatsAppContact(phone: string | null | undefined) {
  if (!phone) return false;
  return /^\+?[1-9]\d{7,14}$/.test(phone.trim().replace(/[\s().-]/g, ""));
}

function promptAttemptsHardRuleOverride(text: string) {
  return [
    /\b(?:continue|keep)\s+(?:messaging|following up).{0,80}\b(?:opt(?:ed)? out|unsubscribe|stop request)\b/i,
    /\b(?:continue|keep)\s+(?:messaging|following up).{0,80}\b(?:human|staff|takeover|handoff)\b/i,
    /\b(?:continue|keep)\s+(?:messaging|following up).{0,80}\bcomplaint\b/i,
  ].some((pattern) => pattern.test(text));
}

function promptRequestsEscalation(config: FollowUpPromptCompiled | null) {
  return objectValue(config).escalateToStaff === true;
}

function promptProhibitsFollowUp(config: FollowUpPromptCompiled | null) {
  return objectValue(config).disableAutomatedFollowUps === true;
}

function sequenceStageValid(stage: PremiumFollowUpSequenceStage) {
  return [
    PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
    PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION,
    PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP,
  ].includes(stage);
}

function safeAttemptLimit(...values: Array<number | null | undefined>) {
  const valid = values.filter((value): value is number => (
    typeof value === "number" && Number.isInteger(value) && value >= 0
  ));
  return Math.max(0, Math.min(MAX_PREMIUM_ATTEMPTS, ...valid));
}

function samePromptVersions(
  expected: PremiumFollowUpPromptVersions,
  current: PremiumFollowUpPromptVersions,
) {
  return expected.global?.versionId === current.global?.versionId
    && expected.followUp?.versionId === current.followUp?.versionId;
}

function emptyVersions(evaluatedAt: string): PremiumFollowUpLatestEntityVersions {
  return {
    evaluatedAt,
    jobUpdatedAt: null,
    ruleUpdatedAt: null,
    conversationUpdatedAt: null,
    leadUpdatedAt: null,
    appointmentUpdatedAt: null,
    appointmentStartTime: null,
    complaintUpdatedAt: null,
    lastCustomerActivityAt: null,
    lastStaffActivityAt: null,
    promptActivatedAt: null,
  };
}

function failedResult(
  input: PremiumFollowUpDecisionContextResult,
  reason: string,
): PremiumFollowUpLifecycleValidationResult {
  return {
    originalRecommendation: { decision: input.decision, reason: input.reason },
    finalDecision: "STOP",
    validationStatus: "REJECTED",
    validationReason: reason,
    businessId: input.businessId,
    conversationId: input.conversationId,
    customerId: input.customerId,
    followUpJobId: input.followUpJobId,
    followUpRuleId: input.followUpRuleId,
    contextType: null,
    appointmentId: input.appointmentId,
    complaintId: input.complaintId,
    complaintStatus: null,
    customerGoal: input.customerGoal,
    customerObjection: input.customerObjection,
    customerTiming: input.customerTiming,
    unresolvedRequest: input.unresolvedRequest,
    leadStatus: null,
    appointmentStatus: null,
    assignedStaffId: input.assignedStaffId,
    promptVersions: input.promptVersions,
    memoryVersion: null,
    sequenceStage: input.sequenceStage,
    successfulAttemptCount: 0,
    effectiveAttemptLimit: 0,
    proposedFollowUpAt: input.proposedFollowUpAt,
    validatedFollowUpAt: null,
    adjustedSchedule: false,
    staleDecision: false,
    executionBlocked: false,
    blockReason: null,
    cancelSequenceRequired: true,
    supersedeRequired: false,
    escalationRequired: false,
    promptConflict: false,
    promptConflictReason: null,
    hardRulesApplied: ["VALIDATION_FAILURE_CHECK"],
    latestEntityVersions: emptyVersions(input.evaluatedAt),
    fallbacksUsed: [...input.fallbacksUsed],
  };
}

async function recordValidationEvent(
  input: PremiumFollowUpDecisionContextResult,
  eventType: "SECURITY_BUSINESS_SCOPE_MISMATCH" | "PREMIUM_FOLLOW_UP_VALIDATION_FAILED",
  detail?: string,
  authoritativeBusinessId?: string | null,
) {
  await auditService.log({
    action: AuditAction.FOLLOW_UP_CONTEXT_EVALUATED,
    businessId: authoritativeBusinessId ?? input.businessId,
    metadata: json({
      securityEvent: eventType === "SECURITY_BUSINESS_SCOPE_MISMATCH",
      eventType,
      followUpJobId: input.followUpJobId,
      claimedBusinessId: input.businessId,
      detail: detail?.slice(0, 300),
    }),
  });
}

async function validateSchedule(input: {
  originalDecision: PremiumFollowUpDecisionContextResult["decision"];
  proposedFollowUpAt: string | null;
  businessId: string;
  onlyDuringBusinessHours: boolean;
  cooldownUntil: Date | null;
  appointmentStartTime: Date | null;
  ruleType: FollowUpRuleType;
  now: Date;
}) {
  if (input.originalDecision !== "SCHEDULE_LATER" && input.originalDecision !== "SEND_NOW") {
    return { status: "NOT_REQUIRED", validatedAt: null } satisfies PremiumFollowUpScheduleValidation;
  }
  const proposed = input.originalDecision === "SEND_NOW"
    ? input.now
    : validDate(input.proposedFollowUpAt);
  if (!proposed || (input.originalDecision === "SCHEDULE_LATER" && proposed <= input.now)) {
    return {
      status: input.originalDecision === "SCHEDULE_LATER" ? "EXPIRED" : "INVALID",
      validatedAt: null,
    } satisfies PremiumFollowUpScheduleValidation;
  }
  if (proposed.getTime() - input.now.getTime() > MAX_FOLLOW_UP_DELAY_MS) {
    return { status: "INVALID", validatedAt: null } satisfies PremiumFollowUpScheduleValidation;
  }
  const minimum = input.originalDecision === "SCHEDULE_LATER"
    ? new Date(input.now.getTime() + MIN_FOLLOW_UP_DELAY_MS)
    : input.now;
  const candidate = [proposed, minimum, input.cooldownUntil]
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0]!;
  if (
    input.ruleType === FollowUpRuleType.BEFORE_APPOINTMENT
    && input.appointmentStartTime
    && candidate >= input.appointmentStartTime
  ) {
    return { status: "INVALID", validatedAt: null } satisfies PremiumFollowUpScheduleValidation;
  }
  const adjustedBeforeHours = candidate.getTime() !== proposed.getTime();
  if (!input.onlyDuringBusinessHours) {
    if (input.originalDecision === "SEND_NOW" && !adjustedBeforeHours) {
      return { status: "NOT_REQUIRED", validatedAt: null } satisfies PremiumFollowUpScheduleValidation;
    }
    return {
      status: adjustedBeforeHours ? "ADJUSTED" : "VALID",
      validatedAt: candidate,
    } satisfies PremiumFollowUpScheduleValidation;
  }
  const hours = await prisma.$transaction((tx) => (
    businessHoursFollowUpDecision(tx, input.businessId, candidate)
  ));
  if (hours.allowedNow) {
    if (input.originalDecision === "SEND_NOW" && !adjustedBeforeHours) {
      return { status: "NOT_REQUIRED", validatedAt: null } satisfies PremiumFollowUpScheduleValidation;
    }
    return {
      status: adjustedBeforeHours ? "ADJUSTED" : "VALID",
      validatedAt: candidate,
    } satisfies PremiumFollowUpScheduleValidation;
  }
  if (
    !hours.nextOpening
    || hours.nextOpening <= input.now
    || hours.nextOpening.getTime() - input.now.getTime() > MAX_FOLLOW_UP_DELAY_MS
    || (
      input.ruleType === FollowUpRuleType.BEFORE_APPOINTMENT
      && input.appointmentStartTime
      && hours.nextOpening >= input.appointmentStartTime
    )
  ) {
    return { status: "INVALID", validatedAt: null } satisfies PremiumFollowUpScheduleValidation;
  }
  return { status: "ADJUSTED", validatedAt: hours.nextOpening } satisfies PremiumFollowUpScheduleValidation;
}

export const followUpPremiumLifecycleValidatorService = {
  async evaluate(
    jobId: string,
    now = new Date(),
  ): Promise<PremiumFollowUpLifecycleValidationResult> {
    try {
      const recommendation = await followUpPremiumDecisionContextService.evaluate(jobId, now);
      return this.validate(recommendation, now);
    } catch (error) {
      const recommendation: PremiumFollowUpDecisionContextResult = {
        decision: "STOP",
        reason: "Required follow-up context is unavailable",
        businessId: null,
        conversationId: null,
        customerId: null,
        followUpJobId: jobId,
        followUpRuleId: null,
        appointmentId: null,
        complaintId: null,
        assignedStaffId: null,
        jobScheduledFor: null,
        evaluatedAt: now.toISOString(),
        sequenceStage: PremiumFollowUpSequenceStage.INITIAL_CHECK_IN,
        attemptCount: 0,
        customerGoal: null,
        customerObjection: null,
        customerTiming: null,
        unresolvedRequest: null,
        leadStatus: null,
        appointmentStatus: null,
        complaintStatus: null,
        humanTakeoverActive: false,
        lastCustomerActivityAt: null,
        lastStaffActivityAt: null,
        promptVersions: { global: null, followUp: null },
        proposedFollowUpAt: null,
        fallbacksUsed: ["ROUND_ONE_EVALUATION_FAILED"],
      };
      await recordValidationEvent(
        recommendation,
        "PREMIUM_FOLLOW_UP_VALIDATION_FAILED",
        error instanceof Error ? error.message : "Round 1 evaluation failed",
      );
      return failedResult(recommendation, "VALIDATION_FAILED");
    }
  },

  async validate(
    input: PremiumFollowUpDecisionContextResult,
    now = new Date(),
  ): Promise<PremiumFollowUpLifecycleValidationResult> {
    try {
      const evaluatedAt = validDate(input.evaluatedAt);
      if (!evaluatedAt) return failedResult(input, "VALIDATION_FAILED");

      const job = await prisma.followUpJob.findUnique({
        where: { id: input.followUpJobId },
        include: {
          business: {
            select: {
              id: true,
              businessAccountId: true,
              followUpAutomationEnabled: true,
              status: true,
              deletedAt: true,
              timezone: true,
              updatedAt: true,
            },
          },
          rule: true,
          lead: {
            select: {
              id: true,
              businessId: true,
              phone: true,
              status: true,
              assignedStaffId: true,
              whatsAppOptedOut: true,
              whatsAppConsentUpdatedAt: true,
              updatedAt: true,
              deletedAt: true,
            },
          },
          conversation: {
            select: {
              id: true,
              businessId: true,
              leadId: true,
              assignedStaffId: true,
              status: true,
              humanTakeover: true,
              needsHumanReview: true,
              humanReviewType: true,
              updatedAt: true,
              deletedAt: true,
            },
          },
          appointment: {
            select: {
              id: true,
              businessId: true,
              leadId: true,
              conversationId: true,
              assignedStaffId: true,
              status: true,
              startTime: true,
              updatedAt: true,
              lastRescheduledAt: true,
            },
          },
        },
      });
      if (!job) return failedResult(input, "FOLLOW_UP_JOB_NOT_ELIGIBLE");
      const activityBaseline = followUpActivityBaseline(job, now);

      const promptVersionIds = [
        input.promptVersions.global?.versionId,
        input.promptVersions.followUp?.versionId,
      ].filter((value): value is string => Boolean(value));
      const assignedMembershipIds = [
        job.lead?.assignedStaffId,
        job.conversation?.assignedStaffId,
        job.appointment?.assignedStaffId,
      ].filter((value): value is string => Boolean(value));

      const [
        subscription,
        successfulAttemptCount,
        lastSuccessfulSend,
        latestCustomerMessage,
        latestStaffMessage,
        complaint,
        claimedComplaint,
        claimedAppointment,
        pendingReschedule,
        whatsApp,
        memoryProfile,
        promptConfigurations,
        claimedPromptVersions,
        assignedMembers,
        latestLeadActivity,
        latestAppointmentActivity,
        duplicateJobs,
      ] = await Promise.all([
        prisma.subscription.findFirst({
          where: {
            businessAccountId: job.business.businessAccountId,
            status: { in: ACTIVE_SUBSCRIPTION_STATUSES },
            currentPeriodStart: { lte: now },
            currentPeriodEnd: { gt: now },
          },
          orderBy: { createdAt: "desc" },
          include: { plan: { select: { code: true } } },
        }),
        prisma.followUpSendLog.count({
          where: {
            businessId: job.businessId,
            ruleId: job.ruleId,
            conversationId: job.conversationId,
            deliveryStatus: FollowUpSendLogDeliveryStatus.SENT,
          },
        }),
        prisma.followUpSendLog.findFirst({
          where: {
            businessId: job.businessId,
            ruleId: job.ruleId,
            deliveryStatus: FollowUpSendLogDeliveryStatus.SENT,
            OR: [
              ...(job.leadId ? [{ leadId: job.leadId }] : []),
              ...(job.conversationId ? [{ conversationId: job.conversationId }] : []),
            ],
          },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        job.conversationId
          ? prisma.message.findFirst({
            where: {
              businessId: job.businessId,
              conversationId: job.conversationId,
              senderType: MessageSenderType.CUSTOMER,
              direction: MessageDirection.INBOUND,
              deletedAt: null,
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, content: true, createdAt: true },
          })
          : Promise.resolve(null),
        job.conversationId
          ? prisma.message.findFirst({
            where: {
              businessId: job.businessId,
              conversationId: job.conversationId,
              senderType: MessageSenderType.STAFF,
              direction: MessageDirection.OUTBOUND,
              deletedAt: null,
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, createdAt: true },
          })
          : Promise.resolve(null),
        prisma.customerIssueLog.findFirst({
          where: {
            businessId: job.businessId,
            OR: [
              ...(job.conversationId ? [{ conversationId: job.conversationId }] : []),
              ...(job.leadId ? [{ leadId: job.leadId }] : []),
            ],
            status: { in: ACTIVE_COMPLAINT_STATUSES },
          },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            businessId: true,
            leadId: true,
            conversationId: true,
            status: true,
            responsibleMembershipId: true,
            updatedAt: true,
          },
        }),
        input.complaintId
          ? prisma.customerIssueLog.findUnique({
            where: { id: input.complaintId },
            select: { id: true, businessId: true, leadId: true, conversationId: true, status: true },
          })
          : Promise.resolve(null),
        input.appointmentId && input.appointmentId !== job.appointmentId
          ? prisma.appointment.findUnique({
            where: { id: input.appointmentId },
            select: {
              id: true,
              businessId: true,
              leadId: true,
              conversationId: true,
              assignedStaffId: true,
              status: true,
              startTime: true,
              updatedAt: true,
              lastRescheduledAt: true,
            },
          })
          : Promise.resolve(null),
        input.appointmentId || job.appointmentId || job.conversationId
          ? prisma.appointmentRescheduleRequest.findFirst({
            where: {
              businessId: job.businessId,
              status: AppointmentRescheduleRequestStatus.PENDING,
              OR: [
                ...(input.appointmentId || job.appointmentId
                  ? [{ appointmentId: input.appointmentId ?? job.appointmentId! }]
                  : []),
                ...(job.conversationId ? [{ conversationId: job.conversationId }] : []),
              ],
            },
            orderBy: { updatedAt: "desc" },
            select: { id: true, businessId: true, appointmentId: true, updatedAt: true },
          })
          : Promise.resolve(null),
        prisma.whatsAppIntegration.findFirst({
          where: { businessId: job.businessId },
          orderBy: { updatedAt: "desc" },
          select: { id: true, businessId: true, status: true, automationEnabled: true, updatedAt: true },
        }),
        job.leadId
          ? prisma.customerMemoryProfile.findUnique({
            where: { businessId_leadId: { businessId: job.businessId, leadId: job.leadId } },
            select: { id: true, businessId: true, leadId: true, memoryRevision: true, updatedAt: true },
          })
          : Promise.resolve(null),
        prisma.aiPromptConfiguration.findMany({
          where: {
            businessId: job.businessId,
            scope: { in: [AiPromptScope.GLOBAL, AiPromptScope.FOLLOW_UP] },
            archivedAt: null,
          },
          select: {
            businessId: true,
            scope: true,
            activeVersion: {
              select: {
                id: true,
                businessId: true,
                versionNumber: true,
                promptText: true,
                compiled: true,
                activatedAt: true,
                updatedAt: true,
              },
            },
          },
        }),
        promptVersionIds.length
          ? prisma.aiPromptVersion.findMany({
            where: { id: { in: promptVersionIds } },
            select: { id: true, businessId: true, scope: true },
          })
          : Promise.resolve([]),
        assignedMembershipIds.length
          ? prisma.businessMember.findMany({
            where: { id: { in: assignedMembershipIds } },
            select: { id: true, businessId: true },
          })
          : Promise.resolve([]),
        job.leadId
          ? prisma.leadActivity.findFirst({
            where: {
              businessId: job.businessId,
              leadId: job.leadId,
              action: {
                in: [
                  LeadActivityAction.LEAD_STATUS_CHANGED,
                  LeadActivityAction.LEAD_ASSIGNED,
                  LeadActivityAction.LEAD_DELETED,
                ],
              },
              createdAt: { gt: evaluatedAt },
            },
            orderBy: { createdAt: "desc" },
            select: { action: true, createdAt: true },
          })
          : Promise.resolve(null),
        input.appointmentId || job.appointmentId
          ? prisma.appointmentActivity.findFirst({
            where: {
              businessId: job.businessId,
              appointmentId: input.appointmentId ?? job.appointmentId!,
              createdAt: { gt: evaluatedAt },
            },
            orderBy: { createdAt: "desc" },
            select: { type: true, createdAt: true },
          })
          : Promise.resolve(null),
        prisma.followUpJob.findMany({
          where: {
            id: { not: job.id },
            businessId: job.businessId,
            ruleId: job.ruleId,
            contextType: job.contextType,
            leadId: job.leadId,
            conversationId: job.conversationId,
            appointmentId: job.appointmentId,
            quoteId: job.quoteId,
            relatedMessageId: job.relatedMessageId,
            status: { in: [FollowUpJobStatus.SCHEDULED, FollowUpJobStatus.PROCESSING, FollowUpJobStatus.SENT] },
          },
          select: {
            id: true,
            status: true,
            createdAt: true,
            sendLogs: {
              where: { deliveryStatus: FollowUpSendLogDeliveryStatus.SENT },
              select: { id: true },
              take: 1,
            },
            premiumInsights: {
              orderBy: { createdAt: "desc" },
              select: { sequenceStage: true },
              take: 1,
            },
          },
          take: 20,
        }),
      ]);

      const monthlySends = subscription
        ? await prisma.followUpSendLog.count({
          where: {
            business: { businessAccountId: job.business.businessAccountId },
            deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
            createdAt: {
              gte: subscription.currentPeriodStart,
              lt: subscription.currentPeriodEnd,
            },
          },
        })
        : 0;

      const currentGlobal = promptConfigurations.find((item) => item.scope === AiPromptScope.GLOBAL)?.activeVersion ?? null;
      const currentFollowUp = promptConfigurations.find((item) => item.scope === AiPromptScope.FOLLOW_UP)?.activeVersion ?? null;
      const appointment = job.appointment ?? claimedAppointment;
      const appointmentAssignedMember = appointment?.assignedStaffId
        && !assignedMembershipIds.includes(appointment.assignedStaffId)
        ? await prisma.businessMember.findUnique({
          where: { id: appointment.assignedStaffId },
          select: { id: true, businessId: true },
        })
        : null;
      const currentPromptVersions: PremiumFollowUpPromptVersions = {
        global: currentGlobal
          ? { versionId: currentGlobal.id, versionNumber: currentGlobal.versionNumber }
          : null,
        followUp: currentFollowUp
          ? { versionId: currentFollowUp.id, versionNumber: currentFollowUp.versionNumber }
          : null,
      };
      const capabilities = aiPromptCapabilityService.forPlan(PlanCode.PREMIUM, AiPromptScope.FOLLOW_UP);
      const sanitizedFollowUp = currentFollowUp
        ? sanitizeCompiledPromptForRuntime(currentFollowUp.compiled, capabilities).compiled
        : null;
      const promptConfig = followUpConfig(sanitizedFollowUp);
      const activePromptTexts = [currentGlobal?.promptText, currentFollowUp?.promptText]
        .filter((value): value is string => Boolean(value));
      const promptConflict = activePromptTexts.some(promptAttemptsHardRuleOverride);
      const promptConflictReason = promptConflict
        ? "Active business prompt attempted to override a mandatory backend stop"
        : null;

      const businessScopeValid = Boolean(
        input.businessId
        && input.businessId === job.businessId
        && input.followUpRuleId === job.ruleId
        && input.conversationId === job.conversationId
        && input.customerId === job.leadId
        && (!input.appointmentId || appointment?.id === input.appointmentId)
        && (!input.complaintId || Boolean(claimedComplaint))
        && job.rule.businessId === job.businessId
        && (!job.lead || job.lead.businessId === job.businessId)
        && (!job.conversation || (
          job.conversation.businessId === job.businessId
          && job.conversation.leadId === job.leadId
        ))
        && (!appointment || (
          appointment.businessId === job.businessId
          && (!appointment.leadId || appointment.leadId === job.leadId)
          && (!appointment.conversationId || appointment.conversationId === job.conversationId)
        ))
        && (!claimedComplaint || (
          claimedComplaint.businessId === job.businessId
          && (!claimedComplaint.leadId || claimedComplaint.leadId === job.leadId)
          && (!claimedComplaint.conversationId || claimedComplaint.conversationId === job.conversationId)
        ))
        && (!memoryProfile || memoryProfile.businessId === job.businessId)
        && claimedPromptVersions.length === promptVersionIds.length
        && claimedPromptVersions.every((version) => version.businessId === job.businessId)
        && assignedMembers.length === new Set(assignedMembershipIds).size
        && assignedMembers.every((member) => member.businessId === job.businessId)
        && (!appointment?.assignedStaffId || (
          assignedMembershipIds.includes(appointment.assignedStaffId)
          || appointmentAssignedMember?.businessId === job.businessId
        ))
        && (!whatsApp || whatsApp.businessId === job.businessId)
      );
      if (!businessScopeValid) {
        await recordValidationEvent(
          input,
          "SECURITY_BUSINESS_SCOPE_MISMATCH",
          undefined,
          job.businessId,
        );
      }

      let staleChangeCode: string | null = null;
      let staleChangeReason: string | null = null;
      const expectedCustomerAt = validDate(input.lastCustomerActivityAt);
      const expectedStaffAt = validDate(input.lastStaffActivityAt);
      if (
        latestCustomerMessage
        && latestCustomerMessage.createdAt > activityBaseline
        && (
          !expectedCustomerAt
          || latestCustomerMessage.createdAt > expectedCustomerAt
          || input.decision === "SEND_NOW"
        )
      ) {
        staleChangeCode = "CUSTOMER_REPLIED_AFTER_EVALUATION";
        staleChangeReason = "CUSTOMER_ACTIVITY_CHECK";
      } else if (
        latestStaffMessage
        && latestStaffMessage.createdAt > activityBaseline
        && (
          !expectedStaffAt
          || latestStaffMessage.createdAt > expectedStaffAt
          || input.decision === "SEND_NOW"
        )
      ) {
        staleChangeCode = "STAFF_REPLIED_AFTER_JOB_SCHEDULED";
        staleChangeReason = "STAFF_ACTIVITY_CHECK";
      } else if (
        appointment
        && (
          latestAppointmentActivity
          || appointment.status !== input.appointmentStatus
          || appointment.updatedAt > evaluatedAt
        )
      ) {
        staleChangeCode = "APPOINTMENT_CHANGED";
        staleChangeReason = "APPOINTMENT_ACTIVITY_CHECK";
      } else if (
        latestLeadActivity
        || job.lead?.status !== input.leadStatus
        || (job.conversation?.assignedStaffId ?? job.lead?.assignedStaffId ?? null) !== input.assignedStaffId
      ) {
        staleChangeCode = latestLeadActivity?.action === LeadActivityAction.LEAD_ASSIGNED
          ? "STAFF_ASSIGNMENT_CHANGED"
          : "LEAD_STATUS_CHANGED";
        staleChangeReason = "LEAD_ACTIVITY_CHECK";
      } else if (
        (complaint?.status ?? null) !== input.complaintStatus
        || complaint?.id !== input.complaintId
        || Boolean(complaint?.updatedAt && complaint.updatedAt > evaluatedAt)
      ) {
        staleChangeCode = "COMPLAINT_STATUS_CHANGED";
        staleChangeReason = "COMPLAINT_ACTIVITY_CHECK";
      } else if (!samePromptVersions(input.promptVersions, currentPromptVersions)) {
        staleChangeCode = "PROMPT_VERSION_CHANGED";
        staleChangeReason = "PROMPT_VERSION_CHECK";
      } else if (job.rule.updatedAt > evaluatedAt) {
        staleChangeCode = "FOLLOW_UP_RULE_CHANGED";
        staleChangeReason = "FOLLOW_UP_RULE_VERSION_CHECK";
      } else if (
        input.jobScheduledFor
        && validDate(input.jobScheduledFor)?.getTime() !== job.scheduledFor.getTime()
      ) {
        staleChangeCode = "FOLLOW_UP_JOB_SCHEDULE_CHANGED";
        staleChangeReason = "FOLLOW_UP_JOB_VERSION_CHECK";
      }

      const cooldownUntil = job.rule.cooldownMinutes && lastSuccessfulSend
        ? new Date(lastSuccessfulSend.createdAt.getTime() + job.rule.cooldownMinutes * 60_000)
        : null;
      const schedule = await validateSchedule({
        originalDecision: input.decision,
        proposedFollowUpAt: input.proposedFollowUpAt,
        businessId: job.businessId,
        onlyDuringBusinessHours: job.rule.onlyDuringBusinessHours,
        cooldownUntil: cooldownUntil && cooldownUntil > now ? cooldownUntil : null,
        appointmentStartTime: appointment?.startTime ?? null,
        ruleType: job.rule.type,
        now,
      });
      const duplicateSuccessfulSend = duplicateJobs.some((duplicate) => (
        duplicate.sendLogs.length > 0
        && (
          duplicate.premiumInsights[0]?.sequenceStage === input.sequenceStage
          || !duplicate.premiumInsights.length
        )
      ));
      const duplicateActiveJob = duplicateJobs.some((duplicate) => (
        (duplicate.status === FollowUpJobStatus.SCHEDULED || duplicate.status === FollowUpJobStatus.PROCESSING)
        && (
          duplicate.premiumInsights[0]?.sequenceStage === input.sequenceStage
          || !duplicate.premiumInsights.length
        )
      ));
      const effectiveAttemptLimit = safeAttemptLimit(
        MAX_PREMIUM_ATTEMPTS,
        promptConfig?.maximumAttempts ?? MAX_PREMIUM_ATTEMPTS,
        job.rule.maxSendsPerLead,
        job.rule.maxSendsPerConversation,
      );
      const appointmentType = job.rule.type === FollowUpRuleType.BEFORE_APPOINTMENT
        || job.rule.type === FollowUpRuleType.AFTER_APPOINTMENT;
      const appointmentRescheduled = Boolean(
        appointment
        && appointment.lastRescheduledAt
        && appointment.lastRescheduledAt > activityBaseline,
      );
      const facts: PremiumFollowUpLifecycleFacts = {
        originalDecision: input.decision,
        originalReason: input.reason,
        businessScopeValid,
        customerOptedOut: Boolean(job.lead?.whatsAppOptedOut),
        humanTakeoverActive: Boolean(
          job.conversation?.humanTakeover
          || job.conversation?.status === ConversationStatus.HUMAN_HANDLING,
        ),
        humanReviewActive: Boolean(
          job.conversation?.needsHumanReview
          || job.conversation?.status === ConversationStatus.NEEDS_HUMAN_REVIEW,
        ),
        activeComplaint: Boolean(complaint),
        complaintWorkflowHandling: Boolean(
          complaint?.status === CustomerIssueStatus.ACKNOWLEDGED
          && complaint.responsibleMembershipId,
        ),
        conversationEligible: Boolean(
          job.conversation
          && !job.conversation.deletedAt
          && job.conversation.status !== ConversationStatus.CLOSED
          && job.conversation.status !== ConversationStatus.PLAN_LIMIT_BLOCKED,
        ),
        conversationCanReopen: Boolean(
          job.conversation
          && !job.conversation.deletedAt
          && job.conversation.status === ConversationStatus.CLOSED,
        ),
        leadLifecycleStop: Boolean(
          !job.lead
          || job.lead.deletedAt
          || job.lead.status === LeadStatus.WON
          || job.lead.status === LeadStatus.LOST,
        ),
        leadLifecycleAllowsWorkflow: Boolean(
          appointmentType
          && appointment
          && (
            job.rule.type === FollowUpRuleType.BEFORE_APPOINTMENT
            || (
              job.rule.type === FollowUpRuleType.AFTER_APPOINTMENT
              && appointment.status === AppointmentStatus.COMPLETED
            )
          ),
        ),
        appointmentCancelled: Boolean(
          appointmentType && appointment?.status === AppointmentStatus.CANCELLED,
        ),
        appointmentRescheduled: appointmentType && appointmentRescheduled,
        appointmentReschedulePending: Boolean(appointmentType && pendingReschedule),
        appointmentCompletedReminder: Boolean(
          job.rule.type === FollowUpRuleType.BEFORE_APPOINTMENT
          && appointment?.status === AppointmentStatus.COMPLETED,
        ),
        appointmentMissedOrNoShow: Boolean(
          appointmentType
          && (
            appointment?.status === AppointmentStatus.NO_SHOW
            || appointment?.status === AppointmentStatus.MISSED
          ),
        ),
        missedAppointmentWorkflowAvailable: false,
        staleChangeCode,
        staleChangeReason,
        premiumCapabilityActive: Boolean(
          subscription
          && subscription.plan.code === PlanCode.PREMIUM
          && job.business.status === BusinessStatus.ACTIVE
          && !job.business.deletedAt,
        ),
        monthlyLimitReached: Boolean(
          subscription && monthlySends >= defaultMonthlyLimit(subscription.plan.code),
        ),
        successfulAttemptCount,
        effectiveAttemptLimit,
        sequenceStage: input.sequenceStage,
        sequenceStageValid: sequenceStageValid(input.sequenceStage),
        ruleExists: Boolean(job.rule),
        ruleEnabled: job.rule.enabled && !job.rule.deletedAt,
        automationEnabled: job.business.followUpAutomationEnabled,
        contextSupported: SUPPORTED_PREMIUM_TYPES.includes(job.rule.type),
        jobEligible: ELIGIBLE_JOB_STATUSES.includes(job.status),
        ruleChanged: job.rule.updatedAt > evaluatedAt,
        duplicateSuccessfulSend,
        duplicateActiveJob,
        duplicateShouldSupersede: duplicateActiveJob,
        schedule,
        customerContactAvailable: validWhatsAppContact(job.lead?.phone),
        whatsAppConnected: Boolean(
          whatsApp
          && CONNECTED_WHATSAPP_STATUSES.includes(whatsApp.status)
          && whatsApp.automationEnabled,
        ),
        promptConflict,
        promptConflictReason,
        promptRequestsEscalation: promptRequestsEscalation(promptConfig),
        promptProhibitsFollowUp: promptProhibitsFollowUp(promptConfig),
        ruleType: job.rule.type,
      };
      const decision = validatePremiumFollowUpLifecycle(facts);
      const promptActivatedAt = [currentGlobal?.activatedAt, currentFollowUp?.activatedAt]
        .filter((value): value is Date => Boolean(value))
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

      return {
        originalRecommendation: { decision: input.decision, reason: input.reason },
        finalDecision: decision.finalDecision,
        validationStatus: decision.validationStatus,
        validationReason: decision.validationReason,
        businessId: job.businessId,
        conversationId: job.conversationId,
        customerId: job.leadId,
        followUpJobId: job.id,
        followUpRuleId: job.ruleId,
        contextType: job.contextType,
        appointmentId: appointment?.id ?? null,
        complaintId: complaint?.id ?? null,
        complaintStatus: complaint?.status ?? null,
        customerGoal: input.customerGoal,
        customerObjection: input.customerObjection,
        customerTiming: input.customerTiming,
        unresolvedRequest: input.unresolvedRequest,
        leadStatus: job.lead?.status ?? null,
        appointmentStatus: appointment?.status ?? null,
        assignedStaffId: job.conversation?.assignedStaffId ?? job.lead?.assignedStaffId ?? appointment?.assignedStaffId ?? null,
        promptVersions: currentPromptVersions,
        memoryVersion: memoryProfile ? String(memoryProfile.memoryRevision) : null,
        sequenceStage: input.sequenceStage,
        successfulAttemptCount,
        effectiveAttemptLimit,
        proposedFollowUpAt: input.proposedFollowUpAt,
        validatedFollowUpAt: decision.validatedFollowUpAt?.toISOString() ?? null,
        adjustedSchedule: decision.adjustedSchedule,
        staleDecision: decision.staleDecision,
        executionBlocked: decision.executionBlocked,
        blockReason: decision.blockReason,
        cancelSequenceRequired: decision.cancelSequenceRequired,
        supersedeRequired: decision.supersedeRequired,
        escalationRequired: decision.escalationRequired,
        promptConflict: decision.promptConflict,
        promptConflictReason: decision.promptConflictReason,
        hardRulesApplied: decision.hardRulesApplied,
        latestEntityVersions: {
          evaluatedAt: evaluatedAt.toISOString(),
          jobUpdatedAt: job.updatedAt.toISOString(),
          ruleUpdatedAt: job.rule.updatedAt.toISOString(),
          conversationUpdatedAt: job.conversation?.updatedAt.toISOString() ?? null,
          leadUpdatedAt: job.lead?.updatedAt.toISOString() ?? null,
          appointmentUpdatedAt: appointment?.updatedAt.toISOString() ?? null,
          appointmentStartTime: appointment?.startTime.toISOString() ?? null,
          complaintUpdatedAt: complaint?.updatedAt.toISOString() ?? null,
          lastCustomerActivityAt: latestCustomerMessage?.createdAt.toISOString() ?? null,
          lastStaffActivityAt: latestStaffMessage?.createdAt.toISOString() ?? null,
          promptActivatedAt: promptActivatedAt?.toISOString() ?? null,
        },
        fallbacksUsed: [
          ...input.fallbacksUsed,
          ...(!currentFollowUp ? ["ACTIVE_FOLLOW_UP_PROMPT_UNAVAILABLE"] : []),
        ],
      };
    } catch (error) {
      await recordValidationEvent(
        input,
        "PREMIUM_FOLLOW_UP_VALIDATION_FAILED",
        error instanceof Error ? error.message : "Unknown validation failure",
      );
      return failedResult(input, "VALIDATION_FAILED");
    }
  },
};
