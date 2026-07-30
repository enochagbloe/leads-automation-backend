import {
  AiPromptScope,
  AppointmentRescheduleRequestStatus,
  AppointmentStatus,
  ConversationStatus,
  CustomerIssueStatus,
  FollowUpJobStatus,
  FollowUpRuleType,
  LeadActivityAction,
  LeadStatus,
  MessageDirection,
  MessageSenderType,
  PlanCode,
  PremiumFollowUpDecision,
  PremiumFollowUpSequenceStage,
  SubscriptionStatus,
  WhatsAppIntegrationStatus,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { aiPromptResolverService } from "../ai-prompt/resolution/ai-prompt-resolver.service";
import { CustomerMemoryRuntimeContext } from "../customer-memory/customer-memory.types";
import { customerMemoryResolverService } from "../customer-memory/customer-memory-resolver.service";
import { FollowUpPromptCompiled } from "../ai-prompt/core/ai-prompt.types";
import {
  FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES,
  dateInTimezone,
  followUpActivityBaseline,
  timeInTimezone,
  validTimezone,
  zonedDateTimeToUtc,
} from "./follow-up.shared";

export type PremiumFollowUpContextDecision =
  | "SEND_NOW"
  | "SCHEDULE_LATER"
  | "STOP"
  | "RECALCULATE"
  | "ESCALATE_TO_STAFF";

export type PremiumFollowUpPromptVersions = {
  global: { versionId: string; versionNumber: number } | null;
  followUp: { versionId: string; versionNumber: number } | null;
};

export type PremiumFollowUpDecisionContextResult = {
  decision: PremiumFollowUpContextDecision;
  reason: string;
  businessId: string | null;
  conversationId: string | null;
  customerId: string | null;
  followUpJobId: string;
  followUpRuleId: string | null;
  appointmentId: string | null;
  complaintId: string | null;
  assignedStaffId: string | null;
  jobScheduledFor: string | null;
  evaluatedAt: string;
  sequenceStage: PremiumFollowUpSequenceStage;
  attemptCount: number;
  customerGoal: string | null;
  customerObjection: string | null;
  customerTiming: string | null;
  unresolvedRequest: string | null;
  leadStatus: string | null;
  appointmentStatus: string | null;
  complaintStatus: string | null;
  humanTakeoverActive: boolean;
  lastCustomerActivityAt: string | null;
  lastStaffActivityAt: string | null;
  promptVersions: PremiumFollowUpPromptVersions;
  proposedFollowUpAt: string | null;
  fallbacksUsed: string[];
};

export type PremiumFollowUpRecommendationInput = {
  now: Date;
  requiredContextAvailable: boolean;
  premiumCapabilityActive: boolean;
  subscriptionActive: boolean;
  businessAutomationEnabled: boolean;
  ruleEnabled: boolean;
  whatsAppConnected: boolean;
  jobPending: boolean;
  supportedJobType: boolean;
  conversationClosed: boolean;
  jobDue: boolean;
  scheduledFor: Date;
  pendingRequestResolved: boolean;
  leadClosed: boolean;
  appointmentCancelled: boolean;
  humanTakeoverActive: boolean;
  maximumAttemptsReached: boolean;
  customerOptedOut: boolean;
  customerNoLongerInterested: boolean;
  storedStopSignal: boolean;
  customerRequestedHuman: boolean;
  customPricingOrExceptionRequested: boolean;
  humanReviewRequired: boolean;
  activeComplaint: boolean;
  futureTiming: { at: Date; statement: string } | null;
  changedContext: string[];
};

export type PremiumFollowUpRecommendation = {
  decision: PremiumFollowUpContextDecision;
  reason: string;
  proposedFollowUpAt: Date | null;
};

const ACTIVE_SUBSCRIPTION_STATUSES = [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING];
const CONNECTED_WHATSAPP_STATUSES = [WhatsAppIntegrationStatus.CONNECTED, WhatsAppIntegrationStatus.MOCK_CONNECTED];
const ACTIVE_COMPLAINT_STATUSES = [
  CustomerIssueStatus.OPEN,
  CustomerIssueStatus.ACKNOWLEDGED,
  CustomerIssueStatus.REOPENED,
];
const CANCELLED_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.MISSED,
];
const CURRENT_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
  AppointmentStatus.RESCHEDULE_REQUESTED,
  AppointmentStatus.RESCHEDULED,
  AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION,
];
const DEFAULT_PROMPT_VERSIONS: PremiumFollowUpPromptVersions = { global: null, followUp: null };
const MAX_CUSTOMER_TIMING_DAYS = 180;

export function safePremiumPromptDefaults() {
  return {
    maximumAttempts: 3,
    versions: DEFAULT_PROMPT_VERSIONS,
    lastChangedAt: null,
    source: "DEFAULTS" as const,
  };
}

function sequenceStageForAttempt(attemptNumber: number) {
  if (attemptNumber <= 1) return PremiumFollowUpSequenceStage.INITIAL_CHECK_IN;
  if (attemptNumber === 2) return PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION;
  return PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP;
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

function cleanText(value: string | null | undefined, max = 500) {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function latestDate(...values: Array<Date | null | undefined>) {
  return values.reduce<Date | null>((latest, value) => {
    if (!value) return latest;
    return !latest || value > latest ? value : latest;
  }, null);
}

function safeFutureDate(value: Date | null | undefined, now: Date) {
  if (!value || !Number.isFinite(value.getTime()) || value <= now) return null;
  const maximum = new Date(now.getTime() + MAX_CUSTOMER_TIMING_DAYS * 86_400_000);
  return value <= maximum ? value : null;
}

function interpretedTiming(memory: CustomerMemoryRuntimeContext | null, now: Date) {
  for (const timing of memory?.timingStatements ?? []) {
    if (!timing.interpretedAt) continue;
    const at = safeFutureDate(new Date(timing.interpretedAt), now);
    if (at) return { at, statement: timing.value };
  }
  return null;
}

function parseLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

function localDateFromUtcCalendar(date: Date) {
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function addLocalCalendarDays(localDate: string, days: number) {
  const { year, month, day } = parseLocalDate(localDate);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  calendarDate.setUTCDate(calendarDate.getUTCDate() + days);
  return localDateFromUtcCalendar(calendarDate);
}

function addLocalCalendarMonths(localDate: string, months: number) {
  const { year, month, day } = parseLocalDate(localDate);
  const targetMonth = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(
    targetMonth.getUTCFullYear(),
    targetMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  targetMonth.setUTCDate(Math.min(day, lastDay));
  return localDateFromUtcCalendar(targetMonth);
}

function localWeekday(localDate: string) {
  const { year, month, day } = parseLocalDate(localDate);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextWeekday(localDate: string, weekday: number) {
  let days = (weekday - localWeekday(localDate) + 7) % 7;
  if (days === 0) days = 7;
  return addLocalCalendarDays(localDate, days);
}

export function parseCustomerTimingStatement(
  text: string | null,
  now: Date,
  timezone = "Africa/Accra",
) {
  if (!text) return null;
  const safeTimezone = validTimezone(timezone) ? timezone : "Africa/Accra";
  const localDate = dateInTimezone(now, safeTimezone);
  const localTime = timeInTimezone(now, safeTimezone);
  const normalized = text.replace(/\s+/g, " ").trim();
  const inDuration = normalized.match(/\bin\s+(\d{1,3})\s+(hour|hours|day|days|week|weeks)\b/i);
  if (inDuration?.[1] && inDuration[2]) {
    const amount = Number.parseInt(inDuration[1], 10);
    const unit = inDuration[2].toLowerCase();
    const at = unit.startsWith("hour")
      ? new Date(now.getTime() + amount * 3_600_000)
      : zonedDateTimeToUtc(
        addLocalCalendarDays(localDate, amount * (unit.startsWith("week") ? 7 : 1)),
        localTime,
        safeTimezone,
      );
    const safeAt = safeFutureDate(at, now);
    return safeAt ? { at: safeAt, statement: normalized } : null;
  }
  const weekdayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const weekday = weekdayNames.findIndex((name) => new RegExp(`\\bnext\\s+${name}\\b`, "i").test(normalized));
  if (weekday >= 0) {
    return {
      at: zonedDateTimeToUtc(nextWeekday(localDate, weekday), "09:00", safeTimezone),
      statement: normalized,
    };
  }
  if (/\bnext\s+week\b/i.test(normalized)) {
    return {
      at: zonedDateTimeToUtc(addLocalCalendarDays(localDate, 7), "09:00", safeTimezone),
      statement: normalized,
    };
  }
  if (/\bnext\s+month\b/i.test(normalized)) {
    return {
      at: zonedDateTimeToUtc(addLocalCalendarMonths(localDate, 1), "09:00", safeTimezone),
      statement: normalized,
    };
  }
  if (/\btomorrow\b/i.test(normalized)) {
    return {
      at: zonedDateTimeToUtc(addLocalCalendarDays(localDate, 1), "09:00", safeTimezone),
      statement: normalized,
    };
  }
  if (/\btonight\b/i.test(normalized)) {
    let at = zonedDateTimeToUtc(localDate, "19:00", safeTimezone);
    if (at <= now) {
      at = zonedDateTimeToUtc(addLocalCalendarDays(localDate, 1), "19:00", safeTimezone);
    }
    return { at, statement: normalized };
  }
  return null;
}

function customerOptedOut(text: string | null) {
  return Boolean(text && [
    /\bstop\s+(?:messaging|contacting|texting|calling|following up)\b/i,
    /\bdo not\s+(?:message|contact|text|call|follow up)\b/i,
    /\bdon't\s+(?:message|contact|text|call|follow up)\b/i,
    /\bno more (?:messages|texts|follow[- ]?ups)\b/i,
    /\bunsubscribe\b/i,
    /\bremove me\b/i,
  ].some((pattern) => pattern.test(text)));
}

function customerRequestedHuman(text: string | null) {
  return Boolean(text && [
    /\b(?:speak|talk|chat)\s+(?:to|with)\s+(?:a\s+)?(?:human|person|manager|staff|agent|owner)\b/i,
    /\b(?:human|manager|staff|agent)\s+(?:please|required|needed)\b/i,
    /\bget me (?:a|the) manager\b/i,
  ].some((pattern) => pattern.test(text)));
}

function customPricingOrExceptionRequested(text: string | null) {
  return Boolean(text && [
    /\bcustom (?:price|pricing|quote|discount)\b/i,
    /\bspecial (?:price|pricing|discount|exception|arrangement)\b/i,
    /\bmake an exception\b/i,
    /\boverride (?:the )?(?:price|policy|rule)\b/i,
  ].some((pattern) => pattern.test(text)));
}

function customerNoLongerInterested(text: string | null) {
  return Boolean(text && [
    /\bnot interested\b/i,
    /\bno longer interested\b/i,
    /\bi (?:do not|don't) want (?:it|this|that|the service)\b/i,
    /\bdecided not to (?:continue|proceed|buy|book)\b/i,
  ].some((pattern) => pattern.test(text)));
}

export function recommendPremiumFollowUpDecision(
  input: PremiumFollowUpRecommendationInput,
): PremiumFollowUpRecommendation {
  if (!input.requiredContextAvailable) {
    return { decision: "STOP", reason: "Required follow-up context is unavailable", proposedFollowUpAt: null };
  }
  if (!input.subscriptionActive || !input.premiumCapabilityActive) {
    return { decision: "STOP", reason: "Premium follow-up capability is not active", proposedFollowUpAt: null };
  }
  if (!input.businessAutomationEnabled || !input.ruleEnabled) {
    return { decision: "STOP", reason: "Follow-up automation or its rule is disabled", proposedFollowUpAt: null };
  }
  if (!input.jobPending || !input.supportedJobType) {
    return { decision: "STOP", reason: "Follow-up job is no longer pending or supported", proposedFollowUpAt: null };
  }
  if (input.conversationClosed) {
    return { decision: "STOP", reason: "Conversation is closed or blocked", proposedFollowUpAt: null };
  }
  // Provider availability is an execution concern. Round 2 preserves this
  // business decision and marks it execution-blocked when WhatsApp is offline.
  if (input.customerOptedOut) {
    return { decision: "STOP", reason: "Customer requested that automated messaging stop", proposedFollowUpAt: null };
  }
  if (input.customerNoLongerInterested) {
    return { decision: "STOP", reason: "Customer is no longer interested", proposedFollowUpAt: null };
  }
  if (input.storedStopSignal) {
    return { decision: "STOP", reason: "Stored Premium intelligence indicates automation should stop", proposedFollowUpAt: null };
  }
  if (input.leadClosed) {
    return { decision: "STOP", reason: "Lead is already won or lost", proposedFollowUpAt: null };
  }
  if (input.appointmentCancelled) {
    return { decision: "STOP", reason: "The related appointment is no longer eligible", proposedFollowUpAt: null };
  }
  if (input.humanTakeoverActive) {
    return { decision: "STOP", reason: "Human takeover is active", proposedFollowUpAt: null };
  }
  if (input.maximumAttemptsReached) {
    return { decision: "STOP", reason: "Maximum Premium follow-up attempts reached", proposedFollowUpAt: null };
  }
  if (input.pendingRequestResolved) {
    return { decision: "STOP", reason: "The pending follow-up request has been resolved", proposedFollowUpAt: null };
  }
  if (input.activeComplaint) {
    return { decision: "ESCALATE_TO_STAFF", reason: "An active customer complaint requires staff attention", proposedFollowUpAt: null };
  }
  if (input.customerRequestedHuman) {
    return { decision: "ESCALATE_TO_STAFF", reason: "Customer requested a human or manager", proposedFollowUpAt: null };
  }
  if (input.customPricingOrExceptionRequested) {
    return { decision: "ESCALATE_TO_STAFF", reason: "Customer requested custom pricing or an exception", proposedFollowUpAt: null };
  }
  if (input.humanReviewRequired) {
    return { decision: "ESCALATE_TO_STAFF", reason: "Conversation requires human review", proposedFollowUpAt: null };
  }
  if (input.changedContext.length) {
    return {
      decision: "RECALCULATE",
      reason: input.changedContext.join("; "),
      proposedFollowUpAt: null,
    };
  }
  if (input.futureTiming) {
    return {
      decision: "SCHEDULE_LATER",
      reason: `Customer requested a later follow-up: ${input.futureTiming.statement}`,
      proposedFollowUpAt: input.futureTiming.at,
    };
  }
  if (!input.jobDue) {
    return {
      decision: "SCHEDULE_LATER",
      reason: "The follow-up job is not due yet",
      proposedFollowUpAt: input.scheduledFor,
    };
  }
  return { decision: "SEND_NOW", reason: "Follow-up is due and the pending request remains unresolved", proposedFollowUpAt: null };
}

async function resolvePrompts(input: { businessId: string; businessAccountId: string }) {
  try {
    const resolved = await aiPromptResolverService.resolve({
      businessId: input.businessId,
      businessAccountId: input.businessAccountId,
      scope: AiPromptScope.FOLLOW_UP,
      auditWarnings: false,
    });
    const config = followUpConfig(resolved.modulePrompt?.compiled);
    const versionIds = [
      resolved.globalPrompt?.versionId,
      resolved.modulePrompt?.versionId,
    ].filter((value): value is string => Boolean(value));
    const versionDates = versionIds.length
      ? await prisma.aiPromptVersion.findMany({
          where: { businessId: input.businessId, id: { in: versionIds } },
          select: { activatedAt: true, updatedAt: true },
        })
      : [];
    return {
      maximumAttempts: Math.max(
        0,
        Math.min(3, config?.maximumAttempts ?? resolved.capabilities.maxFollowUpAttempts ?? 3),
      ),
      versions: {
        global: resolved.globalPrompt
          ? { versionId: resolved.globalPrompt.versionId, versionNumber: resolved.globalPrompt.versionNumber }
          : null,
        followUp: resolved.modulePrompt
          ? { versionId: resolved.modulePrompt.versionId, versionNumber: resolved.modulePrompt.versionNumber }
          : null,
      } satisfies PremiumFollowUpPromptVersions,
      lastChangedAt: latestDate(...versionDates.flatMap((version) => [version.activatedAt, version.updatedAt])),
      source: "ACTIVE" as const,
    };
  } catch {
    return safePremiumPromptDefaults();
  }
}

function baseResult(jobId: string): PremiumFollowUpDecisionContextResult {
  return {
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
    evaluatedAt: new Date().toISOString(),
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
    promptVersions: DEFAULT_PROMPT_VERSIONS,
    proposedFollowUpAt: null,
    fallbacksUsed: [],
  };
}

export const followUpPremiumDecisionContextService = {
  async evaluate(jobId: string, now = new Date()): Promise<PremiumFollowUpDecisionContextResult> {
    const job = await prisma.followUpJob.findUnique({
      where: { id: jobId },
      include: {
        business: {
          select: {
            id: true,
            businessAccountId: true,
            followUpAutomationEnabled: true,
            timezone: true,
            deletedAt: true,
          },
        },
        rule: {
          select: {
            id: true,
            type: true,
            enabled: true,
            deletedAt: true,
          },
        },
        lead: {
          select: {
            id: true,
            status: true,
            email: true,
            assignedStaffId: true,
            lastContactedAt: true,
            whatsAppOptedOut: true,
            whatsAppConsentUpdatedAt: true,
            updatedAt: true,
            deletedAt: true,
          },
        },
        conversation: {
          select: {
            id: true,
            status: true,
            aiEnabled: true,
            humanTakeover: true,
            needsHumanReview: true,
            humanReviewType: true,
            assignedStaffId: true,
            lastMessageAt: true,
            updatedAt: true,
            deletedAt: true,
          },
        },
        appointment: {
          select: {
            id: true,
            status: true,
            startTime: true,
            endTime: true,
            updatedAt: true,
            lastRescheduledAt: true,
          },
        },
      },
    });
    if (!job) return baseResult(jobId);

    const initial = {
      ...baseResult(jobId),
      businessId: job.businessId,
      conversationId: job.conversationId,
      customerId: job.leadId,
      followUpRuleId: job.ruleId,
      appointmentId: job.appointmentId,
      assignedStaffId: job.conversation?.assignedStaffId ?? job.lead?.assignedStaffId ?? null,
      jobScheduledFor: job.scheduledFor.toISOString(),
      evaluatedAt: now.toISOString(),
      leadStatus: job.lead?.status ?? null,
      appointmentStatus: job.appointment?.status ?? null,
      humanTakeoverActive: job.conversation?.humanTakeover ?? false,
    };
    const requiredContextAvailable = Boolean(
      job.business
      && !job.business.deletedAt
      && job.rule
      && job.lead
      && !job.lead.deletedAt
      && job.conversation
      && !job.conversation.deletedAt
      && job.leadId
      && job.conversationId,
    );
    if (!requiredContextAvailable || !job.lead || !job.conversation || !job.leadId || !job.conversationId) {
      return initial;
    }
    const activityBaseline = followUpActivityBaseline(job, now);

    const memoryFallback = {
      leadStatus: job.lead.status,
      assignedStaffId: job.lead.assignedStaffId,
      lastMeaningfulActivityAt: job.lead.lastContactedAt?.toISOString() ?? job.lead.updatedAt.toISOString(),
      conversation: {
        id: job.conversation.id,
        status: job.conversation.status,
        aiEnabled: job.conversation.aiEnabled,
        humanTakeover: job.conversation.humanTakeover,
        needsHumanReview: job.conversation.needsHumanReview,
      },
    };
    const memoryPromise = customerMemoryResolverService.resolve({
      businessId: job.businessId,
      leadId: job.leadId,
      conversationId: job.conversationId,
      mode: "RUNTIME_READ_ONLY",
      runtimeState: memoryFallback,
    }).then((memory) => ({ memory, failed: false as const }))
      .catch(() => ({ memory: null, failed: true as const }));
    const promptsPromise = resolvePrompts({
      businessId: job.businessId,
      businessAccountId: job.business.businessAccountId,
    }).then((prompts) => ({ prompts, failed: false as const }))
      .catch(() => ({
        prompts: {
          maximumAttempts: 3,
          versions: DEFAULT_PROMPT_VERSIONS,
          lastChangedAt: null,
          source: "DEFAULTS" as const,
        },
        failed: true as const,
      }));

    const [
      subscription,
      attempts,
      latestCustomerMessage,
      latestStaffMessage,
      complaint,
      rescheduleRequest,
      whatsApp,
      snapshot,
      memoryResult,
      promptResult,
      memoryProfile,
      appointmentCandidates,
      leadStatusActivity,
    ] = await Promise.all([
      prisma.subscription.findFirst({
        where: {
          businessAccountId: job.business.businessAccountId,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES },
          currentPeriodStart: { lte: now },
          currentPeriodEnd: { gt: now },
        },
        orderBy: { createdAt: "desc" },
        select: { status: true, plan: { select: { code: true } } },
      }),
      prisma.followUpSendLog.count({
        where: {
          businessId: job.businessId,
          ruleId: job.ruleId,
          conversationId: job.conversationId,
          deliveryStatus: { in: [...FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES] },
        },
      }),
      prisma.message.findFirst({
        where: {
          businessId: job.businessId,
          conversationId: job.conversationId,
          senderType: MessageSenderType.CUSTOMER,
          direction: MessageDirection.INBOUND,
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, content: true, createdAt: true },
      }),
      prisma.message.findFirst({
        where: {
          businessId: job.businessId,
          conversationId: job.conversationId,
          senderType: MessageSenderType.STAFF,
          direction: MessageDirection.OUTBOUND,
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, content: true, createdAt: true },
      }),
      prisma.customerIssueLog.findFirst({
        where: {
          businessId: job.businessId,
          OR: [{ conversationId: job.conversationId }, { leadId: job.leadId }],
          status: { in: ACTIVE_COMPLAINT_STATUSES },
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, status: true, updatedAt: true },
      }),
      prisma.appointmentRescheduleRequest.findFirst({
        where: {
          businessId: job.businessId,
          status: AppointmentRescheduleRequestStatus.PENDING,
          OR: [
            ...(job.appointmentId ? [{ appointmentId: job.appointmentId }] : []),
            { conversationId: job.conversationId },
          ],
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, status: true, updatedAt: true },
      }),
      prisma.whatsAppIntegration.findFirst({
        where: {
          businessId: job.businessId,
          status: { in: CONNECTED_WHATSAPP_STATUSES },
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, status: true, automationEnabled: true },
      }),
      prisma.premiumFollowUpIntelligenceSnapshot.findFirst({
        where: { businessId: job.businessId, jobId: job.id },
        orderBy: { createdAt: "desc" },
      }),
      memoryPromise,
      promptsPromise,
      prisma.customerMemoryProfile.findUnique({
        where: { businessId_leadId: { businessId: job.businessId, leadId: job.leadId } },
        select: { conversationSummary: true, memoryRevision: true, updatedAt: true },
      }),
      job.appointment
        ? Promise.resolve([])
        : prisma.appointment.findMany({
            where: {
              businessId: job.businessId,
              OR: [{ leadId: job.leadId }, { conversationId: job.conversationId }],
            },
            orderBy: { updatedAt: "desc" },
            take: 20,
            select: {
              id: true,
              status: true,
              startTime: true,
              endTime: true,
              updatedAt: true,
              lastRescheduledAt: true,
            },
          }),
      prisma.leadActivity.findFirst({
        where: {
          businessId: job.businessId,
          leadId: job.leadId,
          action: LeadActivityAction.LEAD_STATUS_CHANGED,
          createdAt: { gt: activityBaseline },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true },
      }),
    ]);

    const fallbacksUsed: string[] = [];
    if (memoryResult.failed) fallbacksUsed.push("CUSTOMER_MEMORY_UNAVAILABLE");
    if (promptResult.failed || promptResult.prompts.source === "DEFAULTS") {
      fallbacksUsed.push("SAFE_PREMIUM_PROMPT_DEFAULTS");
    }
    if (!snapshot) fallbacksUsed.push("PREMIUM_INTELLIGENCE_UNAVAILABLE");

    const activeAppointment = appointmentCandidates
      .filter((appointment) => CURRENT_APPOINTMENT_STATUSES.includes(appointment.status) && appointment.endTime >= now)
      .sort((left, right) => left.startTime.getTime() - right.startTime.getTime())[0];
    const completedAppointment = appointmentCandidates
      .filter((appointment) => appointment.status === AppointmentStatus.COMPLETED)
      .sort((left, right) => right.endTime.getTime() - left.endTime.getTime())[0];
    const appointment = job.appointment ?? activeAppointment ?? completedAppointment ?? appointmentCandidates[0] ?? null;
    const memory = memoryResult.memory;
    const customerGoal = memory?.activeGoal ?? snapshot?.customerGoal ?? null;
    const customerObjection = memory?.objections[0]?.value ?? snapshot?.customerObjection ?? null;
    const unresolvedRequest = memory?.unresolvedRequests[0]?.value
      ?? memory?.missingDetails[0]?.value
      ?? cleanText(job.pendingQuestion)
      ?? null;
    const memoryTiming = interpretedTiming(memory, now);
    const snapshotTiming = snapshot?.preferredFollowUpAt
      ? safeFutureDate(snapshot.preferredFollowUpAt, now)
      : null;
    const textTiming = parseCustomerTimingStatement(
      latestCustomerMessage?.content ?? null,
      now,
      job.business.timezone,
    );
    const futureTiming = textTiming
      ?? memoryTiming
      ?? (snapshotTiming
        ? { at: snapshotTiming, statement: snapshot?.preferredFollowUpText ?? "Stored Premium timing preference" }
        : null);
    const maximumAttempts = promptResult.prompts.maximumAttempts;
    // Persisted snapshots describe earlier evaluations, not accepted delivery.
    // Successful send logs are the only authority for sequence progression.
    const attemptCount = attempts;
    const sequenceStage = sequenceStageForAttempt(attemptCount + 1);
    const pendingRequestResolved = (
      job.rule.type === FollowUpRuleType.CONTACT_EMAIL_REQUEST && Boolean(job.lead.email)
    ) || (
      job.contextType === "MISSING_CUSTOMER_DETAIL"
      && !memory?.missingDetails.length
      && !memory?.unresolvedRequests.length
    );

    const changedContext: string[] = [];
    if (latestStaffMessage && latestStaffMessage.createdAt > activityBaseline) {
      changedContext.push("Staff replied after the follow-up evaluation baseline");
    }
    if (
      latestCustomerMessage
      && latestCustomerMessage.createdAt > activityBaseline
      && !futureTiming
      && !customerOptedOut(latestCustomerMessage.content)
      && !customerRequestedHuman(latestCustomerMessage.content)
    ) {
      changedContext.push("Customer sent a newer message after the follow-up evaluation baseline");
    }
    const appointmentChangedAt = appointment
      ? latestDate(appointment.updatedAt, appointment.lastRescheduledAt)
      : null;
    if (appointmentChangedAt && appointmentChangedAt > activityBaseline) {
      changedContext.push("Appointment state changed after the follow-up evaluation baseline");
    }
    if (rescheduleRequest) {
      changedContext.push("An appointment reschedule request is pending");
    }
    if (leadStatusActivity) {
      changedContext.push("Lead state changed after the follow-up job was created");
    }
    if (snapshot?.customerGoal && customerGoal && snapshot.customerGoal !== customerGoal) {
      changedContext.push("Customer goal changed after Premium intelligence was stored");
    }
    if (memoryProfile?.updatedAt && memoryProfile.updatedAt > activityBaseline && !snapshot) {
      changedContext.push("Customer memory changed after the follow-up evaluation baseline");
    }
    if (promptResult.prompts.lastChangedAt && promptResult.prompts.lastChangedAt > activityBaseline) {
      changedContext.push("Business follow-up prompt changed after the follow-up evaluation baseline");
    }

    const recommendation = recommendPremiumFollowUpDecision({
      now,
      requiredContextAvailable,
      premiumCapabilityActive: subscription?.plan.code === PlanCode.PREMIUM,
      subscriptionActive: Boolean(subscription),
      businessAutomationEnabled: job.business.followUpAutomationEnabled,
      ruleEnabled: job.rule.enabled && !job.rule.deletedAt,
      whatsAppConnected: Boolean(whatsApp),
      jobPending: job.status === FollowUpJobStatus.SCHEDULED || job.status === FollowUpJobStatus.PROCESSING,
      supportedJobType: job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE,
      conversationClosed: job.conversation.status === ConversationStatus.CLOSED
        || job.conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED,
      jobDue: job.scheduledFor <= now,
      scheduledFor: job.scheduledFor,
      pendingRequestResolved,
      leadClosed: job.lead.status === LeadStatus.WON || job.lead.status === LeadStatus.LOST,
      appointmentCancelled: Boolean(appointment && CANCELLED_APPOINTMENT_STATUSES.includes(appointment.status)),
      humanTakeoverActive: job.conversation.humanTakeover
        || job.conversation.status === ConversationStatus.HUMAN_HANDLING,
      maximumAttemptsReached: attemptCount >= maximumAttempts,
      customerOptedOut: job.lead.whatsAppOptedOut,
      customerNoLongerInterested: customerNoLongerInterested(latestCustomerMessage?.content ?? null),
      storedStopSignal: Boolean(
        snapshot?.shouldStopAutomation
        || snapshot?.decision === PremiumFollowUpDecision.STOP
        || snapshot?.decision === PremiumFollowUpDecision.CANCEL,
      ),
      customerRequestedHuman: customerRequestedHuman(latestCustomerMessage?.content ?? null),
      customPricingOrExceptionRequested: customPricingOrExceptionRequested(latestCustomerMessage?.content ?? null),
      humanReviewRequired: job.conversation.needsHumanReview
        || job.conversation.status === ConversationStatus.NEEDS_HUMAN_REVIEW,
      activeComplaint: Boolean(complaint),
      futureTiming,
      changedContext,
    });

    return {
      decision: recommendation.decision,
      reason: recommendation.reason.slice(0, 500),
      businessId: job.businessId,
      conversationId: job.conversationId,
      customerId: job.leadId,
      followUpJobId: job.id,
      followUpRuleId: job.ruleId,
      appointmentId: appointment?.id ?? null,
      complaintId: complaint?.id ?? null,
      assignedStaffId: job.conversation.assignedStaffId ?? job.lead.assignedStaffId,
      jobScheduledFor: job.scheduledFor.toISOString(),
      evaluatedAt: now.toISOString(),
      sequenceStage,
      attemptCount,
      customerGoal,
      customerObjection,
      customerTiming: futureTiming?.statement ?? null,
      unresolvedRequest: memoryResult.failed
        ? cleanText(memoryProfile?.conversationSummary) ?? unresolvedRequest
        : unresolvedRequest,
      leadStatus: job.lead.status,
      appointmentStatus: appointment?.status ?? null,
      complaintStatus: complaint?.status ?? null,
      humanTakeoverActive: job.conversation.humanTakeover,
      lastCustomerActivityAt: latestCustomerMessage?.createdAt.toISOString() ?? null,
      lastStaffActivityAt: latestStaffMessage?.createdAt.toISOString() ?? null,
      promptVersions: promptResult.prompts.versions,
      proposedFollowUpAt: recommendation.proposedFollowUpAt?.toISOString() ?? null,
      fallbacksUsed,
    };
  },
};
