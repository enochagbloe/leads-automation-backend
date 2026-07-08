import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  BusinessStatus,
  ConversationChannel,
  ConversationStatus,
  CustomerIssueStatus,
  DayOfWeek,
  AppointmentStatus,
  FollowUpContextType,
  FollowUpJobStatus,
  FollowUpRuleType,
  FollowUpSendLogDeliveryStatus,
  FollowUpSendLogSentBy,
  LeadStatus,
  LeadActivityAction,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  MessageType,
  PlanCode,
  Prisma,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import {
  FollowUpJobListQuery,
  FollowUpJobRetryInput,
  FollowUpLogListQuery,
  FollowUpRuleCreateInput,
  FollowUpRuleListQuery,
  FollowUpRuleUpdateInput,
  FollowUpSettingsInput,
  FollowUpTestTriggerInput,
} from "../validation/follow-up.schemas";
import { auditService } from "./audit.service";
import { realtimeService } from "./realtime.service";
import { ACTIVE_SUBSCRIPTION_STATUSES, subscriptionService } from "./subscription.service";
import { getWhatsAppIntegration, sendWhatsAppText } from "./whatsapp-provider.service";

export type FollowUpActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type FollowUpDb = typeof prisma | Prisma.TransactionClient;

type FollowUpContextEvaluationResult = {
  jobId: string;
  doesReplyAddressPendingContext: boolean;
  pendingContextResolved: boolean;
  replyIntent: string;
  extractedFields: {
    email?: string;
    location?: string;
    date?: string;
    time?: string;
    service?: string;
    paymentIntent?: boolean;
    quoteAccepted?: boolean;
  };
  action: "CANCEL_FOLLOW_UP" | "KEEP_FOLLOW_UP";
  reason: string;
};

const ruleInclude = {
  createdBy: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
  updatedBy: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
} satisfies Prisma.FollowUpAutomationRuleInclude;

const jobInclude = {
  rule: { select: { id: true, type: true, name: true, enabled: true, planRequired: true } },
  lead: { select: { id: true, fullName: true, phone: true, email: true, status: true } },
  conversation: { select: { id: true, displayId: true, status: true, assignedStaffId: true, channel: true } },
  appointment: { select: { id: true, title: true, status: true, startTime: true, endTime: true, timezone: true, service: { select: { name: true } } } },
} satisfies Prisma.FollowUpJobInclude;

const sendLogInclude = {
  rule: { select: { id: true, type: true, name: true } },
  job: { select: { id: true, status: true, contextType: true, scheduledFor: true } },
  lead: { select: { id: true, fullName: true, phone: true, email: true } },
  conversation: { select: { id: true, displayId: true, status: true, assignedStaffId: true } },
  appointment: { select: { id: true, title: true, status: true, startTime: true, timezone: true } },
} satisfies Prisma.FollowUpSendLogInclude;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

function isManager(actor: FollowUpActor) {
  return actor.role === BusinessRole.BUSINESS_OWNER || actor.role === BusinessRole.MANAGER;
}

function assertCanManage(actor: FollowUpActor) {
  if (!isManager(actor)) throw new AppError(403, "You do not have permission to manage follow-up automation.", "FORBIDDEN");
}

function assertCanView(actor: FollowUpActor) {
  if (!actor.membershipId) throw new AppError(403, "Business access denied.", "BUSINESS_ACCESS_DENIED");
}

function staffScopedConversationWhere(actor: FollowUpActor): Prisma.ConversationWhereInput {
  return actor.role === BusinessRole.STAFF
    ? { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] }
    : {};
}

function jobAccessWhere(actor: FollowUpActor): Prisma.FollowUpJobWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF ? { conversation: staffScopedConversationWhere(actor) } : {}),
  };
}

function logAccessWhere(actor: FollowUpActor): Prisma.FollowUpSendLogWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF ? { conversation: staffScopedConversationWhere(actor) } : {}),
  };
}

function planRank(plan: PlanCode) {
  if (plan === PlanCode.PREMIUM) return 3;
  if (plan === PlanCode.PLUS) return 2;
  return 1;
}

function defaultMonthlyLimit(plan: PlanCode) {
  if (plan === PlanCode.PREMIUM) return 2_000;
  if (plan === PlanCode.PLUS) return 500;
  return 50;
}

function ruleTypesForPlan(plan: PlanCode): FollowUpRuleType[] {
  const basic = [FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE, FollowUpRuleType.CONTACT_EMAIL_REQUEST, FollowUpRuleType.BEFORE_APPOINTMENT];
  if (plan === PlanCode.BASIC) return basic;
  const plus = [...basic, FollowUpRuleType.AFTER_APPOINTMENT, FollowUpRuleType.STALE_LEAD];
  if (plan === PlanCode.PLUS) return plus;
  return [...plus, FollowUpRuleType.AFTER_QUOTE_SENT];
}

function requiredPlanForRuleType(type: FollowUpRuleType): PlanCode {
  if (type === FollowUpRuleType.AFTER_QUOTE_SENT) return PlanCode.PREMIUM;
  if (type === FollowUpRuleType.AFTER_APPOINTMENT || type === FollowUpRuleType.STALE_LEAD) return PlanCode.PLUS;
  return PlanCode.BASIC;
}

function basicScheduledAuditAction(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return AuditAction.BASIC_CONTACT_EMAIL_REQUEST_SCHEDULED;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return AuditAction.BASIC_APPOINTMENT_REMINDER_SCHEDULED;
  return AuditAction.BASIC_NO_RESPONSE_FOLLOW_UP_SCHEDULED;
}

function basicSentAuditAction(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return AuditAction.BASIC_CONTACT_EMAIL_REQUEST_SENT;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return AuditAction.BASIC_APPOINTMENT_REMINDER_SENT;
  return AuditAction.BASIC_NO_RESPONSE_FOLLOW_UP_SENT;
}

function basicScheduledEventType(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return "business.follow_up.basic.contact_email.scheduled" as const;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return "business.follow_up.basic.appointment_reminder.scheduled" as const;
  return "business.follow_up.basic.no_response.scheduled" as const;
}

function basicSentEventType(type: FollowUpRuleType) {
  if (type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) return "business.follow_up.basic.contact_email.sent" as const;
  if (type === FollowUpRuleType.BEFORE_APPOINTMENT) return "business.follow_up.basic.appointment_reminder.sent" as const;
  return "business.follow_up.basic.no_response.sent" as const;
}

const FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES = [FollowUpSendLogDeliveryStatus.QUEUED, FollowUpSendLogDeliveryStatus.SENT] as const;
const FOLLOW_UP_PROCESSING_STALE_MS = 10 * 60 * 1000;
const FOLLOW_UP_DELIVERED_MESSAGE_STATUSES: MessageDeliveryStatus[] = [MessageDeliveryStatus.SENT, MessageDeliveryStatus.DELIVERED, MessageDeliveryStatus.READ];

async function lockFollowUpMonthlyQuotaScope(tx: Prisma.TransactionClient, businessAccountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('follow_up_monthly_quota'), hashtext(${businessAccountId}))`;
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: hour!, minute: minute!, totalMinutes: hour! * 60 + minute! };
}

function dateInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timeInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

function offsetMs(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const asUtc = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!, 0);
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const { hour, minute } = parseTime(time);
  const localAsUtc = Date.UTC(year!, month! - 1, day!, hour, minute, 0, 0);
  let result = new Date(localAsUtc - offsetMs(new Date(localAsUtc), timezone));
  result = new Date(localAsUtc - offsetMs(result, timezone));
  return result;
}

function dayOfWeekFor(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone }).format(date).toUpperCase() as DayOfWeek;
}

function humanDate(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone) ? timezone : "Africa/Accra",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

function humanTime(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone) ? timezone : "Africa/Accra",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function extractEmail(text: string) {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

function hasLikelyLocation(text: string) {
  const value = text.toLowerCase();
  return /\d+\s+[a-z0-9\s,.-]{3,}/i.test(text)
    || ["near", "opposite", "behind", "around", "at ", "street", "road", "avenue", "junction", "estate", "mall"].some((word) => value.includes(word));
}

function extractDateTime(text: string) {
  const date = text.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i)?.[0];
  const time = text.match(/\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})\b/i)?.[0];
  return { date, time };
}

function quoteAccepted(text: string) {
  return /\b(yes|ok|okay|go ahead|proceed|accepted|approve|approved|sounds good|let'?s do it)\b/i.test(text);
}

function quoteRejected(text: string) {
  return /\b(no|not interested|cancel|reject|decline|too expensive|don't proceed|do not proceed)\b/i.test(text);
}

function meaningfulReply(text: string) {
  return text.trim().split(/\s+/).length >= 2;
}

function clearPlaceholders(value: string) {
  return value
    .replace(/\s*\{\{[^}]+}}\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function followUpJobDedupeKey(input: {
  businessId: string;
  ruleId: string;
  contextType: FollowUpContextType;
  leadId?: string | null;
  conversationId?: string | null;
  appointmentId?: string | null;
  quoteId?: string | null;
  relatedMessageId?: string | null;
}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    businessId: input.businessId,
    ruleId: input.ruleId,
    contextType: input.contextType,
    leadId: input.leadId ?? null,
    conversationId: input.conversationId ?? null,
    appointmentId: input.appointmentId ?? null,
    quoteId: input.quoteId ?? null,
    relatedMessageId: input.relatedMessageId ?? null,
  })).digest("hex");
}

async function validateRuleTargets(actor: FollowUpActor, input: {
  leadId?: string | null;
  conversationId?: string | null;
  appointmentId?: string | null;
}) {
  const [lead, conversation, appointment] = await Promise.all([
    input.leadId ? prisma.lead.findFirst({ where: { id: input.leadId, businessId: actor.businessId, deletedAt: null }, select: { id: true } }) : Promise.resolve(null),
    input.conversationId ? prisma.conversation.findFirst({ where: { id: input.conversationId, businessId: actor.businessId, deletedAt: null }, select: { id: true, leadId: true } }) : Promise.resolve(null),
    input.appointmentId ? prisma.appointment.findFirst({ where: { id: input.appointmentId, businessId: actor.businessId }, select: { id: true } }) : Promise.resolve(null),
  ]);
  if (input.leadId && !lead) throw new AppError(404, "Lead not found.", "LEAD_NOT_FOUND");
  if (input.conversationId && !conversation) throw new AppError(404, "Conversation not found.", "CONVERSATION_NOT_FOUND");
  if (input.appointmentId && !appointment) throw new AppError(404, "Appointment not found.", "APPOINTMENT_NOT_FOUND");

  //testing from enoch remove it if it is wrong
  if(input.conversationId !== lead ) throw new AppError(404, "Conversation Id must match the lead")
  if(input.appointmentId !== lead) throw new AppError(404,"appointment id should match the leadid")
  if(input.appointmentId !== input.conversationId) throw new AppError(404,"appointment must match the conversaton")
}

async function audit(actor: FollowUpActor, action: AuditAction, metadata: Record<string, unknown>) {
  await auditService.log({
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: json(metadata),
  });
}

function assertFollowUpRuleSettingsWithinPolicy(policy: Awaited<ReturnType<typeof followUpPlanPolicyService.policy>>, input: {
  useAiRewrite: boolean;
  maxSendsPerLead: number;
  maxSendsPerConversation: number;
}) {
  if (input.useAiRewrite && !policy.aiRewriteAllowed) {
    throw new AppError(403, "AI rewrite is not available on your current plan.", "PLAN_UPGRADE_REQUIRED", {
      currentPlan: policy.plan,
      requiredPlan: PlanCode.PLUS,
      feature: "follow_up_ai_rewrite",
    });
  }
  if (input.maxSendsPerLead > policy.maxSendsPerLead) {
    throw new AppError(403, "Max sends per lead exceeds your plan limit.", "PLAN_LIMIT_REACHED", {
      currentUsage: input.maxSendsPerLead,
      limit: policy.maxSendsPerLead,
      attemptedAmount: input.maxSendsPerLead,
    });
  }
  if (input.maxSendsPerConversation > policy.maxSendsPerConversation) {
    throw new AppError(403, "Max sends per conversation exceeds your plan limit.", "PLAN_LIMIT_REACHED", {
      currentUsage: input.maxSendsPerConversation,
      limit: policy.maxSendsPerConversation,
      attemptedAmount: input.maxSendsPerConversation,
    });
  }
}

function followUpCooldownScope(job: {
  leadId: string | null;
  conversationId: string | null;
}) {
  const OR: Prisma.FollowUpSendLogWhereInput[] = [];
  if (job.leadId) OR.push({ leadId: job.leadId });
  if (job.conversationId) OR.push({ conversationId: job.conversationId });
  return OR.length > 0 ? { OR } : {};
}

async function nextFollowUpAllowedAfterCooldown(tx: Prisma.TransactionClient, job: {
  businessId: string;
  ruleId: string;
  leadId: string | null;
  conversationId: string | null;
  rule: { cooldownMinutes: number | null };
}, now: Date) {
  if (!job.rule.cooldownMinutes || job.rule.cooldownMinutes <= 0) return null;
  const lastSend = await tx.followUpSendLog.findFirst({
    where: {
      businessId: job.businessId,
      ruleId: job.ruleId,
      deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
      ...followUpCooldownScope(job),
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!lastSend) return null;
  const nextAllowedAt = new Date(lastSend.createdAt.getTime() + job.rule.cooldownMinutes * 60_000);
  return nextAllowedAt > now ? nextAllowedAt : null;
}

async function cancelNoResponseFollowUpIfCustomerReplied(tx: Prisma.TransactionClient, input: {
  businessId: string;
  jobId: string;
  conversationId: string;
  relatedMessageId: string;
  messageId?: string | null;
}) {
  const relatedMessage = await tx.message.findFirst({
    where: { id: input.relatedMessageId, businessId: input.businessId, conversationId: input.conversationId, deletedAt: null },
    select: { createdAt: true },
  });
  if (!relatedMessage) return null;

  const customerReply = await tx.message.findFirst({
    where: {
      businessId: input.businessId,
      conversationId: input.conversationId,
      senderType: MessageSenderType.CUSTOMER,
      direction: MessageDirection.INBOUND,
      createdAt: { gt: relatedMessage.createdAt },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!customerReply) return null;

  const cancelled = await tx.followUpJob.updateMany({
    where: { id: input.jobId, businessId: input.businessId, status: FollowUpJobStatus.PROCESSING },
    data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "CUSTOMER_REPLIED_BEFORE_SEND", processingStartedAt: null },
  });
  if (cancelled.count !== 1) return null;

  if (input.messageId) {
    const message = await tx.message.findFirst({
      where: { id: input.messageId, businessId: input.businessId },
      select: { id: true, metadata: true },
    });
    if (message) {
      await tx.message.update({
        where: { id: message.id },
        data: {
          deliveryStatus: MessageDeliveryStatus.FAILED,
          metadata: json({
            ...jsonObject(message.metadata),
            source: "FOLLOW_UP_AUTOMATION",
            cancelledBeforeSend: true,
            cancelReason: "CUSTOMER_REPLIED_BEFORE_SEND",
            customerReplyId: customerReply.id,
          }),
        },
      });
    }
  }

  return {
    job: await tx.followUpJob.findUniqueOrThrow({ where: { id: input.jobId } }),
    sent: false as const,
    reason: "CUSTOMER_REPLIED_BEFORE_SEND",
    customerReplyId: customerReply.id,
  };
}

async function businessHoursFollowUpDecision(tx: Prisma.TransactionClient, businessId: string, from: Date) {
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: {
      timezone: true,
      availability: {
        where: { isActive: true },
        select: { dayOfWeek: true, isOpen: true, openTime: true, closeTime: true, breakStartTime: true, breakEndTime: true },
      },
    },
  });
  const timezone = business && validTimezone(business.timezone) ? business.timezone : "Africa/Accra";
  const rules = new Map((business?.availability ?? []).map((rule) => [rule.dayOfWeek, rule]));
  const currentLocalTime = timeInTimezone(from, timezone);
  const currentMinutes = parseTime(currentLocalTime).totalMinutes;

  for (let offset = 0; offset < 14; offset += 1) {
    const probe = new Date(from.getTime() + offset * 24 * 60 * 60 * 1000);
    const localDate = dateInTimezone(probe, timezone);
    const localNoon = zonedDateTimeToUtc(localDate, "12:00", timezone);
    const day = dayOfWeekFor(localNoon, timezone);
    const rule = rules.get(day);
    if (!rule?.isOpen || !rule.openTime || !rule.closeTime) continue;

    const openMinutes = parseTime(rule.openTime).totalMinutes;
    const closeMinutes = parseTime(rule.closeTime).totalMinutes;
    const candidateMinutes = offset === 0 ? currentMinutes : openMinutes;
    if (candidateMinutes < openMinutes) return { allowedNow: false, nextOpening: zonedDateTimeToUtc(localDate, rule.openTime, timezone) };
    if (candidateMinutes >= closeMinutes) continue;
    if (rule.breakStartTime && rule.breakEndTime) {
      const breakStart = parseTime(rule.breakStartTime).totalMinutes;
      const breakEnd = parseTime(rule.breakEndTime).totalMinutes;
      if (candidateMinutes >= breakStart && candidateMinutes < breakEnd) {
        return { allowedNow: false, nextOpening: zonedDateTimeToUtc(localDate, rule.breakEndTime, timezone) };
      }
    }
    if (offset === 0) return { allowedNow: true, nextOpening: null };
    return { allowedNow: false, nextOpening: zonedDateTimeToUtc(localDate, rule.openTime, timezone) };
  }
  return { allowedNow: false, nextOpening: null };
}

type BasicFollowUpScheduleInput = {
  businessId: string;
  type: FollowUpRuleType;
  contextType: FollowUpContextType;
  leadId: string | null;
  conversationId: string | null;
  appointmentId?: string | null;
  relatedMessageId?: string | null;
  scheduledFor?: Date;
  pendingQuestion: string;
  expectedResponseType: string;
  replaceScheduledNoResponse?: boolean;
};

async function scheduleBasicFollowUpJob(input: BasicFollowUpScheduleInput) {
  const result = await prisma.$transaction(async (tx) => {
    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: { id: true, businessAccountId: true, followUpAutomationEnabled: true, status: true, deletedAt: true },
    });
    if (!business || business.deletedAt || business.status !== BusinessStatus.ACTIVE) return { scheduled: false, reason: "BUSINESS_INACTIVE" as const };
    if (!business.followUpAutomationEnabled) return { scheduled: false, reason: "FOLLOW_UP_AUTOMATION_DISABLED" as const };

    const subscription = await tx.subscription.findFirst({
      where: { businessAccountId: business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });
    if (!subscription) return { scheduled: false, reason: "SUBSCRIPTION_INACTIVE" as const };
    if (!ruleTypesForPlan(subscription.plan.code).includes(input.type)) return { scheduled: false, reason: "PLAN_UPGRADE_REQUIRED" as const };

    const rule = await tx.followUpAutomationRule.findFirst({
      where: { businessId: input.businessId, type: input.type, enabled: true, deletedAt: null },
    });
    if (!rule) return { scheduled: false, reason: "FOLLOW_UP_RULE_DISABLED" as const };

    const [lead, conversation, appointment] = await Promise.all([
      input.leadId ? tx.lead.findFirst({ where: { id: input.leadId, businessId: input.businessId, deletedAt: null }, select: { id: true, status: true, email: true } }) : Promise.resolve(null),
      input.conversationId ? tx.conversation.findFirst({
        where: { id: input.conversationId, businessId: input.businessId, deletedAt: null },
        select: { id: true, leadId: true, status: true, needsHumanReview: true, humanTakeover: true, assignedStaffId: true },
      }) : Promise.resolve(null),
      input.appointmentId ? tx.appointment.findFirst({
        where: { id: input.appointmentId, businessId: input.businessId },
        select: { id: true, status: true, startTime: true, leadId: true, conversationId: true },
      }) : Promise.resolve(null),
    ]);

    if (input.leadId && !lead) return { scheduled: false, reason: "LEAD_NOT_FOUND" as const };
    if (input.conversationId && !conversation) return { scheduled: false, reason: "CONVERSATION_NOT_FOUND" as const };
    if (input.appointmentId && !appointment) return { scheduled: false, reason: "APPOINTMENT_NOT_FOUND" as const };
    if (lead && (lead.status === LeadStatus.WON || lead.status === LeadStatus.LOST)) return { scheduled: false, reason: "LEAD_CLOSED" as const };
    if (conversation && (
      conversation.status === ConversationStatus.CLOSED
      || conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED
      || conversation.needsHumanReview
      || conversation.humanTakeover
    )) return { scheduled: false, reason: "CONVERSATION_NOT_ELIGIBLE" as const };
    if (input.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE && input.conversationId) {
      const openIssue = await tx.customerIssueLog.findFirst({
        where: {
          businessId: input.businessId,
          conversationId: input.conversationId,
          status: { in: [CustomerIssueStatus.OPEN, CustomerIssueStatus.ACKNOWLEDGED, CustomerIssueStatus.REOPENED] },
        },
        select: { id: true },
      });
      if (openIssue) return { scheduled: false, reason: "UNRESOLVED_CUSTOMER_ISSUE" as const };
    }
    if (input.type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) {
      if (!lead || lead.email) return { scheduled: false, reason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE" as const };
      const existingContactRequest = await tx.followUpSendLog.findFirst({
        where: {
          businessId: input.businessId,
          ruleId: rule.id,
          deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
          OR: [
            ...(input.leadId ? [{ leadId: input.leadId }] : []),
            ...(input.conversationId ? [{ conversationId: input.conversationId }] : []),
          ],
        },
        select: { id: true },
      });
      if (existingContactRequest) return { scheduled: false, reason: "CONTACT_EMAIL_REQUEST_ALREADY_SENT" as const };
    }
    if (input.type === FollowUpRuleType.BEFORE_APPOINTMENT) {
      if (!appointment || (appointment.status !== AppointmentStatus.CONFIRMED && appointment.status !== AppointmentStatus.RESCHEDULED)) return { scheduled: false, reason: "APPOINTMENT_NOT_CONFIRMED" as const };
      if (appointment.startTime <= new Date()) return { scheduled: false, reason: "APPOINTMENT_ALREADY_STARTED" as const };
    }

    if (input.replaceScheduledNoResponse && input.conversationId) {
      await tx.followUpJob.updateMany({
        where: {
          businessId: input.businessId,
          ruleId: rule.id,
          conversationId: input.conversationId,
          contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
          status: FollowUpJobStatus.SCHEDULED,
        },
        data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "REPLACED_BY_NEW_OUTBOUND_MESSAGE" },
      });
    }

    const scheduledFor = input.scheduledFor ?? new Date(Date.now() + rule.delayMinutes * 60_000);
    const dedupeKey = followUpJobDedupeKey({
      businessId: input.businessId,
      ruleId: rule.id,
      contextType: input.contextType,
      leadId: input.leadId,
      conversationId: input.conversationId,
      appointmentId: input.appointmentId ?? null,
      relatedMessageId: input.relatedMessageId ?? null,
    });
    const duplicate = await tx.followUpJob.findFirst({
      where: { businessId: input.businessId, dedupeKey, status: FollowUpJobStatus.SCHEDULED },
      select: { id: true },
    });
    if (duplicate) return { scheduled: false, reason: "FOLLOW_UP_DUPLICATE_JOB" as const, jobId: duplicate.id };

    const job = await tx.followUpJob.create({
      data: {
        businessId: input.businessId,
        ruleId: rule.id,
        leadId: input.leadId,
        conversationId: input.conversationId,
        appointmentId: input.appointmentId ?? null,
        contextType: input.contextType,
        dedupeKey,
        pendingQuestion: input.pendingQuestion,
        expectedResponseType: input.expectedResponseType,
        relatedMessageId: input.relatedMessageId ?? null,
        scheduledFor,
      },
      include: jobInclude,
    });
    return { scheduled: true as const, job, rule };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { scheduled: false as const, reason: "FOLLOW_UP_DUPLICATE_JOB" as const };
    }
    throw error;
  });

  if (result.scheduled && result.rule && result.job) {
    await auditService.log({
      action: basicScheduledAuditAction(result.rule.type),
      businessId: input.businessId,
      metadata: json({
        ruleId: result.rule.id,
        jobId: result.job.id,
        leadId: result.job.leadId,
        conversationId: result.job.conversationId,
        appointmentId: result.job.appointmentId,
        contextType: result.job.contextType,
      }),
    });
    realtimeService.publish({
      type: basicScheduledEventType(result.rule.type),
      businessId: input.businessId,
      conversationId: result.job.conversationId ?? undefined,
      leadId: result.job.leadId ?? undefined,
      payload: { job: result.job },
      broadcastToStaff: true,
    });
  }
  return result;
}

export const followUpPlanPolicyService = {
  async policy(actor: FollowUpActor) {
    const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
    return {
      plan: subscription.plan.code,
      monthlyLimit: defaultMonthlyLimit(subscription.plan.code),
      allowedRuleTypes: ruleTypesForPlan(subscription.plan.code),
      maxSendsPerConversation: subscription.plan.code === PlanCode.BASIC ? 1 : subscription.plan.code === PlanCode.PLUS ? 3 : 5,
      maxSendsPerLead: subscription.plan.code === PlanCode.BASIC ? 2 : subscription.plan.code === PlanCode.PLUS ? 8 : 20,
      aiRewriteAllowed: subscription.plan.code !== PlanCode.BASIC,
      subscription,
    };
  },

  async assertRuleAllowed(actor: FollowUpActor, rule: { type: FollowUpRuleType }) {
    const policy = await this.policy(actor);
    const requiredPlan = requiredPlanForRuleType(rule.type);
    if (policy.subscription.status !== SubscriptionStatus.ACTIVE && policy.subscription.status !== SubscriptionStatus.TRIALING) {
      throw new AppError(403, "Subscription is inactive.", "SUBSCRIPTION_INACTIVE");
    }
    if (planRank(policy.plan) < planRank(requiredPlan) || !policy.allowedRuleTypes.includes(rule.type)) {
      throw new AppError(403, "Upgrade your plan to use this follow-up rule.", "PLAN_UPGRADE_REQUIRED", {
        currentPlan: policy.plan,
        requiredPlan,
        ruleType: rule.type,
      });
    }
    return policy;
  },
};

export const followUpTemplateRendererService = {
  render(template: string, context: {
    customerName?: string | null;
    businessName?: string | null;
    serviceName?: string | null;
    appointmentDate?: string | null;
    appointmentTime?: string | null;
    quoteTotal?: string | null;
    paymentLink?: string | null;
  }) {
    const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
      const value = context[key as keyof typeof context];
      return typeof value === "string" && value.trim() ? value.trim() : "";
    });
    const cleaned = clearPlaceholders(rendered);
    if (!cleaned) throw new AppError(422, "Follow-up template could not be rendered.", "TEMPLATE_RENDER_FAILED");
    return cleaned;
  },
};

export const followUpContextEvaluationService = {
  async evaluateInboundReplyAgainstPendingJobs(input: {
    businessId: string;
    conversationId: string;
    leadId: string;
    inboundMessageId: string;
    inboundMessageText: string;
    pendingJobs: Array<{ id: string; contextType: FollowUpContextType; pendingQuestion: string | null; expectedResponseType: string | null }>;
  }): Promise<FollowUpContextEvaluationResult[]> {
    const text = input.inboundMessageText.trim();
    const email = extractEmail(text);
    const dateTime = extractDateTime(text);
    return input.pendingJobs.map((job) => {
      if (job.contextType === FollowUpContextType.CONTACT_EMAIL_REQUEST) {
        return email
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "PROVIDED_EMAIL", extractedFields: { email }, action: "CANCEL_FOLLOW_UP", reason: "Customer provided an email address." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "NO_EMAIL_PROVIDED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply did not include an email address." };
      }
      if (job.contextType === FollowUpContextType.LOCATION_REQUEST) {
        return hasLikelyLocation(text)
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "PROVIDED_LOCATION", extractedFields: { location: text.slice(0, 240) }, action: "CANCEL_FOLLOW_UP", reason: "Customer provided a likely location." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "LOCATION_NOT_PROVIDED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply did not resolve the location request." };
      }
      if (job.contextType === FollowUpContextType.DATE_TIME_REQUEST) {
        return dateTime.date || dateTime.time
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "PROVIDED_DATE_OR_TIME", extractedFields: { date: dateTime.date, time: dateTime.time }, action: "CANCEL_FOLLOW_UP", reason: "Customer provided date or time information." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "DATE_TIME_NOT_PROVIDED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply did not include date or time information." };
      }
      if (job.contextType === FollowUpContextType.QUOTE_RESPONSE || job.contextType === FollowUpContextType.PAYMENT_RESPONSE) {
        if (quoteAccepted(text)) return { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "QUOTE_ACCEPTED", extractedFields: { quoteAccepted: true }, action: "CANCEL_FOLLOW_UP", reason: "Customer accepted or approved the follow-up context." };
        if (quoteRejected(text)) return { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "QUOTE_REJECTED", extractedFields: { quoteAccepted: false }, action: "CANCEL_FOLLOW_UP", reason: "Customer rejected the quote/payment follow-up context." };
        return { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "QUOTE_CLARIFICATION_OR_UNRELATED", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer did not clearly accept or reject." };
      }
      if (job.contextType === FollowUpContextType.GENERAL_NO_RESPONSE) {
        return meaningfulReply(text)
          ? { jobId: job.id, doesReplyAddressPendingContext: true, pendingContextResolved: true, replyIntent: "MEANINGFUL_REPLY", extractedFields: {}, action: "CANCEL_FOLLOW_UP", reason: "Customer replied meaningfully." }
          : { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "UNCLEAR_REPLY", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "Customer reply was too unclear to cancel the follow-up." };
      }
      return { jobId: job.id, doesReplyAddressPendingContext: false, pendingContextResolved: false, replyIntent: "UNCLASSIFIED_CONTEXT", extractedFields: {}, action: "KEEP_FOLLOW_UP", reason: "No deterministic resolver matched this context." };
    });
  },
};

export const followUpEligibilityService = {
  async checkJob(jobId: string) {
    const job = await prisma.followUpJob.findUnique({ where: { id: jobId }, include: { rule: true, business: true, lead: true, conversation: true, appointment: true } });
    if (!job) return { eligible: false, action: "CANCEL" as const, reason: "FOLLOW_UP_JOB_NOT_FOUND" };
    if (job.status !== FollowUpJobStatus.SCHEDULED && job.status !== FollowUpJobStatus.PROCESSING) return { eligible: false, action: "CANCEL" as const, reason: "FOLLOW_UP_JOB_NOT_SCHEDULED" };
    if (!job.rule.enabled || job.rule.deletedAt) return { eligible: false, action: "SKIP" as const, reason: "FOLLOW_UP_RULE_DISABLED" };
    if (!job.business.followUpAutomationEnabled) return { eligible: false, action: "CANCEL" as const, reason: "FOLLOW_UP_AUTOMATION_DISABLED" };
    if (job.business.status !== BusinessStatus.ACTIVE || job.business.deletedAt) return { eligible: false, action: "SKIP" as const, reason: "BUSINESS_INACTIVE" };
    if (job.rule.type === FollowUpRuleType.BEFORE_APPOINTMENT && (!job.appointment || job.appointment.startTime <= new Date())) {
      return { eligible: false, action: "CANCEL" as const, reason: "APPOINTMENT_ALREADY_STARTED" };
    }
    if (job.rule.type === FollowUpRuleType.CONTACT_EMAIL_REQUEST && job.lead?.email) {
      return { eligible: false, action: "CANCEL" as const, reason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE" };
    }
    const subscription = await prisma.subscription.findFirst({
      where: { businessAccountId: job.business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });
    if (!subscription) return { eligible: false, action: "SKIP" as const, reason: "SUBSCRIPTION_INACTIVE" };
    const requiredPlan = requiredPlanForRuleType(job.rule.type);
    if (planRank(subscription.plan.code) < planRank(requiredPlan) || !ruleTypesForPlan(subscription.plan.code).includes(job.rule.type)) {
      return { eligible: false, action: "SKIP" as const, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const monthlySends = await prisma.followUpSendLog.count({
      where: {
        business: { businessAccountId: job.business.businessAccountId },
        deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
        createdAt: { gte: subscription.currentPeriodStart, lt: subscription.currentPeriodEnd },
      },
    });
    if (monthlySends >= defaultMonthlyLimit(subscription.plan.code)) return { eligible: false, action: "SKIP" as const, reason: "FOLLOW_UP_MONTHLY_LIMIT_REACHED" };
    if (job.conversation && (
      job.conversation.status === ConversationStatus.CLOSED
      || job.conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED
      || job.conversation.needsHumanReview
      || job.conversation.humanTakeover
    )) return { eligible: false, action: "CANCEL" as const, reason: "CONVERSATION_NOT_ELIGIBLE" };
    if (job.lead && (job.lead.status === LeadStatus.WON || job.lead.status === LeadStatus.LOST)) return { eligible: false, action: "CANCEL" as const, reason: "LEAD_CLOSED" };
    if (job.appointment && (
      job.appointment.status === AppointmentStatus.CANCELLED
      || job.appointment.status === AppointmentStatus.NO_SHOW
      || job.appointment.status === AppointmentStatus.MISSED
    )) return { eligible: false, action: "CANCEL" as const, reason: "APPOINTMENT_NOT_ELIGIBLE" };
    const [leadSends, conversationSends] = await Promise.all([
      job.leadId ? prisma.followUpSendLog.count({ where: { businessId: job.businessId, ruleId: job.ruleId, leadId: job.leadId, deliveryStatus: FollowUpSendLogDeliveryStatus.SENT } }) : Promise.resolve(0),
      job.conversationId ? prisma.followUpSendLog.count({ where: { businessId: job.businessId, ruleId: job.ruleId, conversationId: job.conversationId, deliveryStatus: FollowUpSendLogDeliveryStatus.SENT } }) : Promise.resolve(0),
    ]);
    if (leadSends >= job.rule.maxSendsPerLead) return { eligible: false, action: "SKIP" as const, reason: "MAX_SENDS_PER_LEAD_REACHED" };
    if (conversationSends >= job.rule.maxSendsPerConversation) return { eligible: false, action: "SKIP" as const, reason: "MAX_SENDS_PER_CONVERSATION_REACHED" };
    return { eligible: true, action: "SEND" as const };
  },
};

export const followUpJobSchedulerService = {
  async scheduleFollowUpJob(actor: FollowUpActor, input: FollowUpTestTriggerInput) {
    await validateRuleTargets(actor, input);
    const rule = await prisma.followUpAutomationRule.findFirst({ where: { id: input.ruleId, businessId: actor.businessId, deletedAt: null } });
    if (!rule) throw new AppError(404, "Follow-up rule not found.", "FOLLOW_UP_RULE_NOT_FOUND");
    const business = await prisma.business.findUnique({ where: { id: actor.businessId }, select: { followUpAutomationEnabled: true } });
    if (!business?.followUpAutomationEnabled) throw new AppError(403, "Follow-up automation is disabled.", "FOLLOW_UP_AUTOMATION_DISABLED");
    if (!rule.enabled) throw new AppError(422, "Follow-up rule is disabled.", "FOLLOW_UP_RULE_DISABLED");
    await followUpPlanPolicyService.assertRuleAllowed(actor, { type: rule.type });
    const scheduledFor = input.scheduledFor ?? new Date(Date.now() + rule.delayMinutes * 60_000);
    const dedupeKey = followUpJobDedupeKey({
      businessId: actor.businessId,
      ruleId: rule.id,
      contextType: input.contextType,
      leadId: input.leadId ?? null,
      conversationId: input.conversationId ?? null,
      appointmentId: input.appointmentId ?? null,
      quoteId: input.quoteId ?? null,
      relatedMessageId: input.relatedMessageId ?? null,
    });
    const created = await prisma.$transaction(async (tx) => {
      const duplicate = await tx.followUpJob.findFirst({
        where: {
          businessId: actor.businessId,
          dedupeKey,
          status: FollowUpJobStatus.SCHEDULED,
        },
      });
      if (duplicate) throw new AppError(409, "A matching follow-up job is already scheduled.", "FOLLOW_UP_DUPLICATE_JOB", { jobId: duplicate.id });
      return tx.followUpJob.create({
        data: {
          businessId: actor.businessId,
          ruleId: rule.id,
          leadId: input.leadId ?? null,
          conversationId: input.conversationId ?? null,
          appointmentId: input.appointmentId ?? null,
          quoteId: input.quoteId ?? null,
          contextType: input.contextType,
          dedupeKey,
          pendingQuestion: input.pendingQuestion ?? null,
          expectedResponseType: input.expectedResponseType ?? null,
          relatedMessageId: input.relatedMessageId ?? null,
          scheduledFor,
        },
        include: jobInclude,
      });
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "A matching follow-up job is already scheduled.", "FOLLOW_UP_DUPLICATE_JOB");
      }
      throw error;
    });
    await audit(actor, AuditAction.FOLLOW_UP_JOB_SCHEDULED, { ruleId: rule.id, jobId: created.id, contextType: created.contextType, leadId: created.leadId, conversationId: created.conversationId });
    realtimeService.publish({ type: "business.follow_up.job.scheduled", businessId: actor.businessId, conversationId: created.conversationId ?? undefined, leadId: created.leadId ?? undefined, payload: { job: created }, broadcastToStaff: true });
    return created;
  },
};

export const followUpCancellationService = {
  async cancelJob(actor: FollowUpActor, jobId: string, reason: string) {
    const job = await prisma.followUpJob.findFirst({ where: { id: jobId, ...jobAccessWhere(actor) }, include: jobInclude });
    if (!job) throw new AppError(404, "Follow-up job not found.", "FOLLOW_UP_JOB_NOT_FOUND");
    if (job.status !== FollowUpJobStatus.SCHEDULED) return job;
    const changed = await prisma.followUpJob.updateMany({
      where: { id: job.id, businessId: actor.businessId, status: FollowUpJobStatus.SCHEDULED },
      data: { status: FollowUpJobStatus.CANCELLED, cancelReason: reason },
    });
    if (changed.count !== 1) {
      throw new AppError(409, "Follow-up job changed. Refresh and try again.", "FOLLOW_UP_JOB_STATE_CHANGED");
    }
    const updated = await prisma.followUpJob.findUniqueOrThrow({ where: { id: job.id }, include: jobInclude });
    await audit(actor, AuditAction.FOLLOW_UP_JOB_CANCELLED, { jobId: updated.id, ruleId: updated.ruleId, reason });
    realtimeService.publish({ type: "business.follow_up.job.cancelled", businessId: actor.businessId, conversationId: updated.conversationId ?? undefined, leadId: updated.leadId ?? undefined, payload: { job: updated, reason }, broadcastToStaff: true });
    return updated;
  },

  async evaluateInboundReply(input: {
    businessId: string;
    conversationId: string;
    leadId: string;
    inboundMessageId: string;
    inboundMessageText: string;
  }) {
    const pendingJobs = await prisma.followUpJob.findMany({
      where: { businessId: input.businessId, conversationId: input.conversationId, status: FollowUpJobStatus.SCHEDULED },
      select: { id: true, contextType: true, pendingQuestion: true, expectedResponseType: true },
    });
    if (pendingJobs.length === 0) return [];
    const results = await followUpContextEvaluationService.evaluateInboundReplyAgainstPendingJobs({ ...input, pendingJobs });
    for (const result of results) {
      if (result.action === "CANCEL_FOLLOW_UP") {
        await prisma.followUpJob.updateMany({
          where: { id: result.jobId, businessId: input.businessId, status: FollowUpJobStatus.SCHEDULED },
          data: { status: FollowUpJobStatus.CANCELLED, cancelReason: result.reason },
        });
      }
      await auditService.log({
        action: AuditAction.FOLLOW_UP_CONTEXT_EVALUATED,
        businessId: input.businessId,
        metadata: json({ ...result, conversationId: input.conversationId, leadId: input.leadId, inboundMessageId: input.inboundMessageId }),
      });
      realtimeService.publish({
        type: "business.follow_up.context.evaluated",
        businessId: input.businessId,
        conversationId: input.conversationId,
        leadId: input.leadId,
        payload: result,
        broadcastToStaff: true,
      });
    }
    const emailResult = results.find((result) => result.extractedFields.email);
    if (emailResult?.extractedFields.email) {
      await prisma.lead.updateMany({
        where: { id: input.leadId, businessId: input.businessId, email: null },
        data: { email: emailResult.extractedFields.email },
      });
    }
    return results;
  },
};

export const followUpService = {
  async ensureDefaultRulesForBusiness(actor: FollowUpActor) {
    if (!isManager(actor)) return;
    const count = await prisma.followUpAutomationRule.count({ where: { businessId: actor.businessId } });
    if (count === 0) await this.seedDefaultRulesForBusiness(actor.businessId, actor.membershipId);
  },

  async seedDefaultRulesForBusiness(businessId: string, createdByMembershipId: string, db: FollowUpDb = prisma) {
    const defaults: Array<Pick<FollowUpRuleCreateInput, "type" | "name" | "delayMinutes" | "messageTemplate">> = [
      { type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE, name: "No response follow-up", delayMinutes: 1440, messageTemplate: "Hi {{customerName}}, just checking if you’d still like help with this." },
      { type: FollowUpRuleType.CONTACT_EMAIL_REQUEST, name: "Ask for customer email", delayMinutes: 0, messageTemplate: "You can also share your email if you’d like us to send the details there. We can still continue here on WhatsApp." },
      { type: FollowUpRuleType.BEFORE_APPOINTMENT, name: "Appointment reminder", delayMinutes: 1440, messageTemplate: "Reminder: your appointment is scheduled for {{appointmentDate}} at {{appointmentTime}}." },
    ];
    await Promise.all(defaults.map((rule) => db.followUpAutomationRule.upsert({
      where: { businessId_type: { businessId, type: rule.type } },
      create: {
        businessId,
        createdByMembershipId,
        type: rule.type,
        name: rule.name,
        enabled: false,
        delayMinutes: rule.delayMinutes,
        messageTemplate: rule.messageTemplate,
        useAiRewrite: false,
        maxSendsPerLead: 1,
        maxSendsPerConversation: 1,
        onlyDuringBusinessHours: true,
        planRequired: requiredPlanForRuleType(rule.type),
      },
      update: {},
    })));
  },

  async getSettings(actor: FollowUpActor) {
    assertCanView(actor);
    await this.ensureDefaultRulesForBusiness(actor);
    const business = await prisma.business.findFirst({
      where: { id: actor.businessId, deletedAt: null },
      select: { id: true, followUpAutomationEnabled: true },
    });
    if (!business) throw new AppError(404, "Business not found.", "BUSINESS_NOT_FOUND");
    return business;
  },

  async updateSettings(actor: FollowUpActor, input: FollowUpSettingsInput) {
    assertCanManage(actor);
    const existing = await prisma.business.findUnique({ where: { id: actor.businessId }, select: { followUpAutomationEnabled: true } });
    let cancelledJobCount = 0;
    const updated = await prisma.business.update({
      where: { id: actor.businessId },
      data: { followUpAutomationEnabled: input.followUpAutomationEnabled },
      select: { id: true, followUpAutomationEnabled: true },
    });
    if (existing?.followUpAutomationEnabled && !updated.followUpAutomationEnabled) {
      const cancelled = await prisma.followUpJob.updateMany({
        where: { businessId: actor.businessId, status: FollowUpJobStatus.SCHEDULED },
        data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "FOLLOW_UP_AUTOMATION_DISABLED" },
      });
      cancelledJobCount = cancelled.count;
      realtimeService.publish({
        type: "business.follow_up.jobs.cancelled_bulk",
        businessId: actor.businessId,
        payload: { reason: "FOLLOW_UP_AUTOMATION_DISABLED", cancelledJobCount },
        broadcastToStaff: true,
      });
    }
    await audit(actor, updated.followUpAutomationEnabled ? AuditAction.FOLLOW_UP_AUTOMATION_ENABLED : AuditAction.FOLLOW_UP_AUTOMATION_DISABLED, { followUpAutomationEnabled: updated.followUpAutomationEnabled, cancelledJobCount });
    const settings = { ...updated, cancelledJobCount };
    realtimeService.publish({ type: "business.follow_up.rule.updated", businessId: actor.businessId, payload: { settings }, broadcastToStaff: true });
    return settings;
  },

  async listRules(actor: FollowUpActor, query: FollowUpRuleListQuery) {
    assertCanView(actor);
    await this.ensureDefaultRulesForBusiness(actor);
    const where: Prisma.FollowUpAutomationRuleWhereInput = {
      businessId: actor.businessId,
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.type ? { type: query.type } : {}),
      ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.followUpAutomationRule.findMany({ where, include: ruleInclude, orderBy: [{ createdAt: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.followUpAutomationRule.count({ where }),
    ]);
    return { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  },

  async getRule(actor: FollowUpActor, ruleId: string) {
    assertCanView(actor);
    const rule = await prisma.followUpAutomationRule.findFirst({ where: { id: ruleId, businessId: actor.businessId, deletedAt: null }, include: ruleInclude });
    if (!rule) throw new AppError(404, "Follow-up rule not found.", "FOLLOW_UP_RULE_NOT_FOUND");
    return rule;
  },

  async createRule(actor: FollowUpActor, input: FollowUpRuleCreateInput) {
    assertCanManage(actor);
    const policy = await followUpPlanPolicyService.assertRuleAllowed(actor, { type: input.type });
    assertFollowUpRuleSettingsWithinPolicy(policy, {
      useAiRewrite: input.useAiRewrite,
      maxSendsPerLead: input.maxSendsPerLead,
      maxSendsPerConversation: input.maxSendsPerConversation,
    });
    const existingRule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: actor.businessId, type: input.type },
      select: { id: true, deletedAt: true },
    });
    if (existingRule) {
      throw new AppError(409, "A follow-up rule for this type already exists.", "FOLLOW_UP_RULE_ALREADY_EXISTS", {
        ruleId: existingRule.id,
        type: input.type,
        deleted: Boolean(existingRule.deletedAt),
      });
    }
    const rule = await prisma.followUpAutomationRule.create({
      data: { ...input, planRequired: requiredPlanForRuleType(input.type), businessId: actor.businessId, createdByMembershipId: actor.membershipId },
      include: ruleInclude,
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "A follow-up rule for this type already exists.", "FOLLOW_UP_RULE_ALREADY_EXISTS", { type: input.type });
      }
      throw error;
    });
    await audit(actor, AuditAction.FOLLOW_UP_RULE_CREATED, { ruleId: rule.id, type: rule.type });
    realtimeService.publish({ type: "business.follow_up.rule.created", businessId: actor.businessId, payload: { rule }, broadcastToStaff: true });
    return rule;
  },

  async updateRule(actor: FollowUpActor, ruleId: string, input: FollowUpRuleUpdateInput) {
    assertCanManage(actor);
    const existing = await this.getRule(actor, ruleId);
    const type = input.type ?? existing.type;
    const policy = await followUpPlanPolicyService.assertRuleAllowed(actor, { type });
    assertFollowUpRuleSettingsWithinPolicy(policy, {
      useAiRewrite: input.useAiRewrite ?? existing.useAiRewrite,
      maxSendsPerLead: input.maxSendsPerLead ?? existing.maxSendsPerLead,
      maxSendsPerConversation: input.maxSendsPerConversation ?? existing.maxSendsPerConversation,
    });
    const rule = await prisma.followUpAutomationRule.update({
      where: { id: existing.id },
      data: { ...input, planRequired: requiredPlanForRuleType(type), updatedByMembershipId: actor.membershipId },
      include: ruleInclude,
    });
    await audit(actor, AuditAction.FOLLOW_UP_RULE_UPDATED, { ruleId: rule.id, changes: Object.keys(input) });
    realtimeService.publish({ type: "business.follow_up.rule.updated", businessId: actor.businessId, payload: { rule }, broadcastToStaff: true });
    return rule;
  },

  async deleteRule(actor: FollowUpActor, ruleId: string) {
    assertCanManage(actor);
    const existing = await this.getRule(actor, ruleId);
    const rule = await prisma.followUpAutomationRule.update({
      where: { id: existing.id },
      data: { enabled: false, deletedAt: new Date(), updatedByMembershipId: actor.membershipId },
      include: ruleInclude,
    });
    await prisma.followUpJob.updateMany({ where: { businessId: actor.businessId, ruleId, status: FollowUpJobStatus.SCHEDULED }, data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "FOLLOW_UP_RULE_DELETED" } });
    await audit(actor, AuditAction.FOLLOW_UP_RULE_DELETED, { ruleId });
    realtimeService.publish({ type: "business.follow_up.rule.updated", businessId: actor.businessId, payload: { rule, deleted: true }, broadcastToStaff: true });
    return { message: "Follow-up rule disabled successfully.", rule };
  },

  async listJobs(actor: FollowUpActor, query: FollowUpJobListQuery) {
    assertCanView(actor);
    const where: Prisma.FollowUpJobWhereInput = {
      ...jobAccessWhere(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      ...(query.quoteId ? { quoteId: query.quoteId } : {}),
      ...(query.contextType ? { contextType: query.contextType } : {}),
      ...(query.from || query.to ? { scheduledFor: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.followUpJob.findMany({ where, include: jobInclude, orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.followUpJob.count({ where }),
    ]);
    return { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  },

	  async getJob(actor: FollowUpActor, jobId: string) {
	    assertCanView(actor);
	    const job = await prisma.followUpJob.findFirst({ where: { id: jobId, ...jobAccessWhere(actor) }, include: jobInclude });
	    if (!job) throw new AppError(404, "Follow-up job not found.", "FOLLOW_UP_JOB_NOT_FOUND");
	    return job;
	  },

	  async retryJob(actor: FollowUpActor, jobId: string, input: FollowUpJobRetryInput) {
	    assertCanManage(actor);
	    const job = await prisma.followUpJob.findFirst({ where: { id: jobId, businessId: actor.businessId }, include: jobInclude });
	    if (!job) throw new AppError(404, "Follow-up job not found.", "FOLLOW_UP_JOB_NOT_FOUND");
	    if (job.status !== FollowUpJobStatus.FAILED) {
	      throw new AppError(409, "Only failed follow-up jobs can be retried.", "FOLLOW_UP_JOB_NOT_RETRYABLE", { status: job.status });
	    }
	    if (job.failureReason === "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION" || job.failureReason === "FOLLOW_UP_STALE_PROCESSING_PENDING_MESSAGE") {
	      throw new AppError(409, "This follow-up has an ambiguous pending delivery and cannot be retried safely yet.", "FOLLOW_UP_DELIVERY_RECONCILIATION_REQUIRED");
	    }
	    const existingMessage = await prisma.message.findFirst({
	      where: { businessId: actor.businessId, deletedAt: null, metadata: { path: ["jobId"], equals: job.id } },
	      orderBy: { createdAt: "desc" },
	    });
	    if (existingMessage?.deliveryStatus === MessageDeliveryStatus.PENDING && typeof jsonObject(existingMessage.metadata).deliveryAttemptStartedAt === "string") {
	      throw new AppError(409, "This follow-up has an ambiguous pending delivery and cannot be retried safely yet.", "FOLLOW_UP_DELIVERY_RECONCILIATION_REQUIRED", { messageId: existingMessage.id });
	    }
	    const scheduledFor = input.scheduledFor ?? new Date();
	    const updated = await prisma.followUpJob.update({
	      where: { id: job.id },
	      data: {
	        status: FollowUpJobStatus.SCHEDULED,
	        scheduledFor,
	        failureReason: null,
	        processingStartedAt: null,
	        sentAt: null,
	      },
	      include: jobInclude,
	    }).catch((error: unknown) => {
	      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
	        throw new AppError(409, "A matching follow-up job is already scheduled.", "FOLLOW_UP_DUPLICATE_JOB");
	      }
	      throw error;
	    });
	    await audit(actor, AuditAction.FOLLOW_UP_JOB_RESCHEDULED, { jobId: updated.id, ruleId: updated.ruleId, reason: "MANUAL_RETRY", scheduledFor });
	    realtimeService.publish({
	      type: "business.follow_up.job.rescheduled",
	      businessId: actor.businessId,
	      conversationId: updated.conversationId ?? undefined,
	      leadId: updated.leadId ?? undefined,
	      payload: { job: updated, reason: "MANUAL_RETRY", retried: true },
	      broadcastToStaff: true,
	    });
	    return updated;
	  },

	  async listLogs(actor: FollowUpActor, query: FollowUpLogListQuery) {
    assertCanView(actor);
    const where: Prisma.FollowUpSendLogWhereInput = {
      ...logAccessWhere(actor),
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      ...(query.quoteId ? { quoteId: query.quoteId } : {}),
      ...(query.deliveryStatus ? { deliveryStatus: query.deliveryStatus } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.followUpSendLog.findMany({ where, include: sendLogInclude, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.followUpSendLog.count({ where }),
    ]);
    return { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
  },

  async getLog(actor: FollowUpActor, logId: string) {
    assertCanView(actor);
    const log = await prisma.followUpSendLog.findFirst({ where: { id: logId, ...logAccessWhere(actor) }, include: sendLogInclude });
    if (!log) throw new AppError(404, "Follow-up log not found.", "FOLLOW_UP_LOG_NOT_FOUND");
    return log;
  },

  async scheduleNoResponseAfterOutboundMessage(input: {
    businessId: string;
    leadId: string;
    conversationId: string;
    messageId: string;
    messageCreatedAt: Date;
    deliveryStatus: MessageDeliveryStatus;
  }) {
    if (input.deliveryStatus === MessageDeliveryStatus.FAILED || input.deliveryStatus === MessageDeliveryStatus.INTERNAL) {
      return { scheduled: false, reason: "MESSAGE_NOT_CUSTOMER_FACING" as const };
    }
    const rule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: input.businessId, type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE, enabled: true, deletedAt: null },
      select: { delayMinutes: true },
    });
    return scheduleBasicFollowUpJob({
      businessId: input.businessId,
      type: FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE,
      contextType: FollowUpContextType.GENERAL_NO_RESPONSE,
      leadId: input.leadId,
      conversationId: input.conversationId,
      relatedMessageId: input.messageId,
      scheduledFor: new Date(input.messageCreatedAt.getTime() + (rule?.delayMinutes ?? 1440) * 60_000),
      pendingQuestion: "Customer has not responded to the last message.",
      expectedResponseType: "CUSTOMER_REPLY",
      replaceScheduledNoResponse: true,
    });
  },

  async scheduleContactEmailRequestForAppointment(appointment: {
    businessId: string;
    leadId: string | null;
    conversationId: string | null;
  }) {
    if (!appointment.leadId) return { scheduled: false, reason: "LEAD_NOT_FOUND" as const };
    const rule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: appointment.businessId, type: FollowUpRuleType.CONTACT_EMAIL_REQUEST, enabled: true, deletedAt: null },
      select: { delayMinutes: true },
    });
    return scheduleBasicFollowUpJob({
      businessId: appointment.businessId,
      type: FollowUpRuleType.CONTACT_EMAIL_REQUEST,
      contextType: FollowUpContextType.CONTACT_EMAIL_REQUEST,
      leadId: appointment.leadId,
      conversationId: appointment.conversationId,
      scheduledFor: new Date(Date.now() + (rule?.delayMinutes ?? 0) * 60_000),
      pendingQuestion: "Customer may share email for booking details or formal documents.",
      expectedResponseType: "EMAIL",
    });
  },

  async scheduleAppointmentReminder(appointment: {
    businessId: string;
    id: string;
    leadId: string | null;
    conversationId: string | null;
    status: AppointmentStatus;
    startTime: Date;
  }) {
    if ((appointment.status !== AppointmentStatus.CONFIRMED && appointment.status !== AppointmentStatus.RESCHEDULED) || !appointment.leadId) return { scheduled: false, reason: "APPOINTMENT_NOT_CONFIRMED" as const };
    const rule = await prisma.followUpAutomationRule.findFirst({
      where: { businessId: appointment.businessId, type: FollowUpRuleType.BEFORE_APPOINTMENT, enabled: true, deletedAt: null },
      select: { delayMinutes: true },
    });
    const now = new Date();
    const primary = new Date(appointment.startTime.getTime() - (rule?.delayMinutes ?? 1440) * 60_000);
    const fallback = new Date(appointment.startTime.getTime() - 2 * 60 * 60 * 1000);
    const scheduledFor = primary > now ? primary : fallback > now ? fallback : null;
    if (!scheduledFor) {
      await auditService.log({
        action: AuditAction.FOLLOW_UP_JOB_SKIPPED,
        businessId: appointment.businessId,
        metadata: json({ appointmentId: appointment.id, reason: "APPOINTMENT_TOO_SOON_FOR_REMINDER" }),
      });
      return { scheduled: false, reason: "APPOINTMENT_TOO_SOON_FOR_REMINDER" as const };
    }
    return scheduleBasicFollowUpJob({
      businessId: appointment.businessId,
      type: FollowUpRuleType.BEFORE_APPOINTMENT,
      contextType: FollowUpContextType.APPOINTMENT_CONFIRMATION,
      leadId: appointment.leadId,
      conversationId: appointment.conversationId,
      appointmentId: appointment.id,
      scheduledFor,
      pendingQuestion: "Customer should be reminded of upcoming appointment.",
      expectedResponseType: "APPOINTMENT_ACKNOWLEDGEMENT",
    });
  },

  async cancelAppointmentReminderJobs(input: { businessId: string; appointmentId: string; reason: string }) {
    const cancelled = await prisma.followUpJob.updateMany({
      where: {
        businessId: input.businessId,
        appointmentId: input.appointmentId,
        contextType: FollowUpContextType.APPOINTMENT_CONFIRMATION,
        status: FollowUpJobStatus.SCHEDULED,
      },
      data: { status: FollowUpJobStatus.CANCELLED, cancelReason: input.reason },
    });
    if (cancelled.count > 0) {
      await auditService.log({
        action: AuditAction.FOLLOW_UP_JOB_CANCELLED,
        businessId: input.businessId,
        metadata: json({ appointmentId: input.appointmentId, reason: input.reason, cancelledJobCount: cancelled.count }),
      });
    }
    return cancelled;
  },

  async testTrigger(actor: FollowUpActor, input: FollowUpTestTriggerInput) {
    assertCanManage(actor);
    if (process.env.NODE_ENV === "production") throw new AppError(404, "Follow-up test trigger is not available.", "NOT_FOUND");
    return followUpJobSchedulerService.scheduleFollowUpJob(actor, input);
  },
};

async function recoverStaleProcessingJobs(businessId: string, now = new Date()) {
  const staleBefore = new Date(now.getTime() - FOLLOW_UP_PROCESSING_STALE_MS);
  const staleJobs = await prisma.followUpJob.findMany({
    where: {
      businessId,
      status: FollowUpJobStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    orderBy: { processingStartedAt: "asc" },
    take: 100,
  });
  for (const job of staleJobs) {
    const sendLog = await prisma.followUpSendLog.findFirst({
      where: { businessId, jobId: job.id },
      orderBy: { createdAt: "desc" },
    });
    if (sendLog?.deliveryStatus === FollowUpSendLogDeliveryStatus.SENT) {
      const changed = await prisma.followUpJob.updateMany({
        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
        data: { status: FollowUpJobStatus.SENT, sentAt: sendLog.createdAt, processingStartedAt: null, failureReason: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_SENT, businessId, metadata: json({ jobId: job.id, recoveredFromStaleProcessing: true, sendLogId: sendLog.id }) });
      }
      continue;
    }
    if (sendLog?.deliveryStatus === FollowUpSendLogDeliveryStatus.FAILED) {
      const changed = await prisma.followUpJob.updateMany({
        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
        data: { status: FollowUpJobStatus.FAILED, failureReason: sendLog.failureReason ?? "FOLLOW_UP_SEND_FAILED", processingStartedAt: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, recoveredFromStaleProcessing: true, sendLogId: sendLog.id, reason: sendLog.failureReason ?? "FOLLOW_UP_SEND_FAILED" }) });
      }
      continue;
    }

    const message = await prisma.message.findFirst({
      where: {
        businessId,
        deletedAt: null,
        metadata: { path: ["jobId"], equals: job.id },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!message) {
      const changed = await prisma.followUpJob.updateMany({
        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
        data: { status: FollowUpJobStatus.SCHEDULED, processingStartedAt: null, failureReason: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_RESCHEDULED, businessId, metadata: json({ jobId: job.id, reason: "STALE_PROCESSING_RECOVERED", processingStartedAt: job.processingStartedAt }) });
      }
      continue;
    }

	    if (FOLLOW_UP_DELIVERED_MESSAGE_STATUSES.includes(message.deliveryStatus)) {
	      const changed = await prisma.followUpJob.updateMany({
	        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
	        data: { status: FollowUpJobStatus.SENT, sentAt: message.createdAt, processingStartedAt: null, failureReason: null },
      });
      if (changed.count === 1) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_SENT, businessId, metadata: json({ jobId: job.id, recoveredFromStaleProcessing: true, messageId: message.id, deliveryStatus: message.deliveryStatus }) });
	      }
	      continue;
	    }

	    const messageMetadata = jsonObject(message.metadata);
	    if (message.deliveryStatus === MessageDeliveryStatus.PENDING && typeof messageMetadata.deliveryAttemptStartedAt !== "string") {
	      const changed = await prisma.followUpJob.updateMany({
	        where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
	        data: { status: FollowUpJobStatus.SCHEDULED, processingStartedAt: null, failureReason: null },
	      });
	      if (changed.count === 1) {
	        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_RESCHEDULED, businessId, metadata: json({ jobId: job.id, reason: "STALE_PROCESSING_RECOVERED_BEFORE_DELIVERY_ATTEMPT", processingStartedAt: job.processingStartedAt, messageId: message.id }) });
	      }
	      continue;
	    }

	    const reason = message.deliveryStatus === MessageDeliveryStatus.FAILED
	      ? "FOLLOW_UP_MESSAGE_FAILED"
      : "FOLLOW_UP_STALE_PROCESSING_PENDING_MESSAGE";
    const changed = await prisma.followUpJob.updateMany({
      where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING, processingStartedAt: job.processingStartedAt },
      data: { status: FollowUpJobStatus.FAILED, failureReason: reason, processingStartedAt: null },
    });
    if (changed.count === 1) {
      await auditService.log({
        action: AuditAction.FOLLOW_UP_JOB_FAILED,
        businessId,
        metadata: json({
          jobId: job.id,
          recoveredFromStaleProcessing: true,
          messageId: message.id,
          deliveryStatus: message.deliveryStatus,
          reason,
        }),
      });
    }
  }
}

export const followUpJobProcessorService = {
  async processDueJobs(businessId: string, limit = 25) {
    const now = new Date();
    await recoverStaleProcessingJobs(businessId, now);
    const jobs = await prisma.followUpJob.findMany({
      where: { businessId, status: FollowUpJobStatus.SCHEDULED, scheduledFor: { lte: now } },
      orderBy: { scheduledFor: "asc" },
      take: limit,
      include: {
        rule: true,
        lead: true,
        conversation: true,
        appointment: { include: { service: { select: { name: true } } } },
        business: true,
      },
    });
    const results = [];
    for (const job of jobs) {
      const claimedAt = new Date();
      const claimed = await prisma.followUpJob.updateMany({
        where: {
          id: job.id,
          businessId,
          status: FollowUpJobStatus.SCHEDULED,
          scheduledFor: { lte: claimedAt },
        },
        data: {
          status: FollowUpJobStatus.PROCESSING,
          processingStartedAt: claimedAt,
        },
      });
      if (claimed.count !== 1) continue;

      if (job.rule.onlyDuringBusinessHours) {
        const businessHoursOutcome = await prisma.$transaction(async (tx) => {
          const decision = await businessHoursFollowUpDecision(tx, businessId, claimedAt);
          if (decision.allowedNow) return null;
          if (decision.nextOpening) {
            const rescheduled = await tx.followUpJob.updateMany({
              where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
              data: { status: FollowUpJobStatus.SCHEDULED, scheduledFor: decision.nextOpening, processingStartedAt: null },
            });
            if (rescheduled.count !== 1) return null;
            return {
              job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
              reason: "FOLLOW_UP_OUTSIDE_BUSINESS_HOURS",
              rescheduledFor: decision.nextOpening,
            };
          }
          const skipped = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.SKIPPED, skipReason: "BUSINESS_HOURS_UNAVAILABLE", processingStartedAt: null },
          });
          if (skipped.count !== 1) return null;
          return {
            job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
            reason: "BUSINESS_HOURS_UNAVAILABLE",
            rescheduledFor: null,
          };
        });
        if (businessHoursOutcome) {
          await auditService.log({
            action: businessHoursOutcome.rescheduledFor ? AuditAction.FOLLOW_UP_JOB_RESCHEDULED : AuditAction.FOLLOW_UP_JOB_SKIPPED,
            businessId,
            metadata: json({ jobId: job.id, reason: businessHoursOutcome.reason, rescheduledFor: businessHoursOutcome.rescheduledFor }),
          });
          results.push(businessHoursOutcome.job);
          continue;
        }
      }

      const cooldownOutcome = await prisma.$transaction(async (tx) => {
        const nextAllowedAt = await nextFollowUpAllowedAfterCooldown(tx, job, new Date());
        if (!nextAllowedAt) return null;
        const rescheduled = await tx.followUpJob.updateMany({
          where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
          data: { status: FollowUpJobStatus.SCHEDULED, scheduledFor: nextAllowedAt, processingStartedAt: null },
        });
        if (rescheduled.count !== 1) return null;
        return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), reason: "FOLLOW_UP_COOLDOWN_ACTIVE", rescheduledFor: nextAllowedAt };
      });
      if (cooldownOutcome) {
        await auditService.log({
          action: AuditAction.FOLLOW_UP_JOB_RESCHEDULED,
          businessId,
          metadata: json({ jobId: job.id, reason: cooldownOutcome.reason, rescheduledFor: cooldownOutcome.rescheduledFor }),
        });
        results.push(cooldownOutcome.job);
        continue;
      }

      const eligibility = await followUpEligibilityService.checkJob(job.id);
      if (!eligibility.eligible) {
        const status = eligibility.action === "CANCEL" ? FollowUpJobStatus.CANCELLED : FollowUpJobStatus.SKIPPED;
        const updated = await prisma.followUpJob.updateMany({
          where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
          data: {
            status,
            processingStartedAt: null,
            ...(status === FollowUpJobStatus.CANCELLED ? { cancelReason: eligibility.reason } : { skipReason: eligibility.reason }),
          },
        });
        if (updated.count !== 1) continue;
        const record = await prisma.followUpJob.findUniqueOrThrow({ where: { id: job.id } });
        await auditService.log({ action: status === FollowUpJobStatus.CANCELLED ? AuditAction.FOLLOW_UP_JOB_CANCELLED : AuditAction.FOLLOW_UP_JOB_SKIPPED, businessId, metadata: json({ jobId: job.id, reason: eligibility.reason }) });
        results.push(record);
        continue;
      }
      const messageText = followUpTemplateRendererService.render(job.rule.messageTemplate, {
        customerName: job.lead?.fullName,
        businessName: job.business.name,
        serviceName: job.appointment?.service?.name,
        appointmentDate: job.appointment ? humanDate(job.appointment.startTime, job.appointment.timezone) : null,
        appointmentTime: job.appointment ? humanTime(job.appointment.startTime, job.appointment.timezone) : null,
      });
      if (!job.conversationId || !job.leadId || !job.lead?.phone || job.conversation?.channel !== ConversationChannel.WHATSAPP) {
        const failed = await prisma.$transaction(async (tx) => {
          const markedFailed = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.FAILED, failureReason: "WHATSAPP_NOT_CONNECTED", processingStartedAt: null },
          });
          if (markedFailed.count !== 1) return null;
          await tx.followUpSendLog.create({
            data: {
              businessId,
              ruleId: job.ruleId,
              jobId: job.id,
              leadId: job.leadId,
              conversationId: job.conversationId,
              appointmentId: job.appointmentId,
              quoteId: job.quoteId,
              messageText,
              sentBy: job.rule.useAiRewrite ? FollowUpSendLogSentBy.AI : FollowUpSendLogSentBy.SYSTEM,
              deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED,
              failureReason: "WHATSAPP_NOT_CONNECTED",
            },
          });
          return tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } });
        });
        if (!failed) continue;
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, reason: "WHATSAPP_NOT_CONNECTED" }) });
        realtimeService.publish({ type: "business.follow_up.job.failed", businessId, conversationId: job.conversationId ?? undefined, leadId: job.leadId ?? undefined, payload: { job: failed, reason: "WHATSAPP_NOT_CONNECTED" }, broadcastToStaff: true });
        results.push(failed);
        continue;
      }
      const conversationId = job.conversationId;
      const leadId = job.leadId;
      const destinationPhone = job.lead.phone;

      let integration;
      try {
        integration = await getWhatsAppIntegration(businessId);
      } catch {
        const failed = await prisma.$transaction(async (tx) => {
          const markedFailed = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.FAILED, failureReason: "WHATSAPP_NOT_CONNECTED", processingStartedAt: null },
          });
          if (markedFailed.count !== 1) return null;
          await tx.followUpSendLog.create({
            data: {
              businessId,
              ruleId: job.ruleId,
              jobId: job.id,
              leadId: job.leadId,
              conversationId: job.conversationId,
              appointmentId: job.appointmentId,
              quoteId: job.quoteId,
              messageText,
              sentBy: job.rule.useAiRewrite ? FollowUpSendLogSentBy.AI : FollowUpSendLogSentBy.SYSTEM,
              deliveryStatus: FollowUpSendLogDeliveryStatus.FAILED,
              failureReason: "WHATSAPP_NOT_CONNECTED",
            },
          });
          return tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } });
        });
        if (!failed) continue;
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, reason: "WHATSAPP_NOT_CONNECTED" }) });
        realtimeService.publish({ type: "business.follow_up.job.failed", businessId, conversationId: job.conversationId, leadId: job.leadId, payload: { job: failed, reason: "WHATSAPP_NOT_CONNECTED" }, broadcastToStaff: true });
        results.push(failed);
        continue;
      }

      const prepared = await prisma.$transaction(async (tx) => {
        await lockFollowUpMonthlyQuotaScope(tx, job.business.businessAccountId);
        const subscription = await tx.subscription.findFirst({
          where: { businessAccountId: job.business.businessAccountId, status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
          include: { plan: true },
          orderBy: { createdAt: "desc" },
        });
        if (!subscription) {
          const skipped = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.SKIPPED, skipReason: "SUBSCRIPTION_INACTIVE", processingStartedAt: null },
          });
          if (skipped.count !== 1) return null;
          return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), sent: false, reason: "SUBSCRIPTION_INACTIVE" };
        }
        const monthlySends = await tx.followUpSendLog.count({
          where: {
            business: { businessAccountId: job.business.businessAccountId },
            deliveryStatus: { in: [...FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES] },
            createdAt: { gte: subscription.currentPeriodStart, lt: subscription.currentPeriodEnd },
          },
        });
        if (monthlySends >= defaultMonthlyLimit(subscription.plan.code)) {
          const skipped = await tx.followUpJob.updateMany({
            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
            data: { status: FollowUpJobStatus.SKIPPED, skipReason: "FOLLOW_UP_MONTHLY_LIMIT_REACHED", processingStartedAt: null },
          });
          if (skipped.count !== 1) return null;
          return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), sent: false, reason: "FOLLOW_UP_MONTHLY_LIMIT_REACHED" };
	        }
	        const nextAllowedAt = await nextFollowUpAllowedAfterCooldown(tx, job, new Date());
	        if (nextAllowedAt) {
	          const rescheduled = await tx.followUpJob.updateMany({
	            where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
	            data: { status: FollowUpJobStatus.SCHEDULED, scheduledFor: nextAllowedAt, processingStartedAt: null },
	          });
	          if (rescheduled.count !== 1) return null;
	          return { job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }), sent: false, reason: "FOLLOW_UP_COOLDOWN_ACTIVE", rescheduledFor: nextAllowedAt };
	        }
	        if (job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE && job.relatedMessageId) {
	          const cancelled = await cancelNoResponseFollowUpIfCustomerReplied(tx, {
	            businessId,
	            jobId: job.id,
	            conversationId,
	            relatedMessageId: job.relatedMessageId,
	          });
	          if (cancelled) return cancelled;
	        }
	        if (job.rule.type === FollowUpRuleType.BEFORE_APPOINTMENT) {
	          const appointment = job.appointmentId
	            ? await tx.appointment.findFirst({
	              where: { id: job.appointmentId, businessId },
	              select: { id: true, startTime: true },
	            })
	            : null;
	          if (!appointment || appointment.startTime <= new Date()) {
	            const cancelled = await tx.followUpJob.updateMany({
	              where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
	              data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "APPOINTMENT_ALREADY_STARTED", processingStartedAt: null },
	            });
	            if (cancelled.count !== 1) return null;
	            return {
	              job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
	              sent: false,
	              reason: "APPOINTMENT_ALREADY_STARTED",
	            };
	          }
	        }
	        if (job.rule.type === FollowUpRuleType.CONTACT_EMAIL_REQUEST) {
	          const lead = await tx.lead.findFirst({
	            where: { id: leadId, businessId, deletedAt: null },
	            select: { email: true },
	          });
	          if (lead?.email) {
	            const cancelled = await tx.followUpJob.updateMany({
	              where: { id: job.id, businessId, status: FollowUpJobStatus.PROCESSING },
	              data: { status: FollowUpJobStatus.CANCELLED, cancelReason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE", processingStartedAt: null },
	            });
	            if (cancelled.count !== 1) return null;
	            return {
	              job: await tx.followUpJob.findUniqueOrThrow({ where: { id: job.id } }),
	              sent: false,
	              reason: "CUSTOMER_EMAIL_ALREADY_AVAILABLE",
	            };
	          }
	        }
	        const existingMessage = await tx.message.findFirst({
          where: {
            businessId,
            deletedAt: null,
            metadata: { path: ["jobId"], equals: job.id },
          },
          orderBy: { createdAt: "desc" },
        });
        if (existingMessage) {
          if (FOLLOW_UP_DELIVERED_MESSAGE_STATUSES.includes(existingMessage.deliveryStatus)) {
            const updatedJob = await tx.followUpJob.update({
              where: { id: job.id },
              data: { status: FollowUpJobStatus.SENT, sentAt: existingMessage.createdAt, processingStartedAt: null, failureReason: null },
            });
            return { job: updatedJob, message: existingMessage, sent: false, reason: "FOLLOW_UP_ALREADY_DELIVERED" };
          }
          const existingMetadata = jsonObject(existingMessage.metadata);
          if (existingMessage.deliveryStatus === MessageDeliveryStatus.PENDING && typeof existingMetadata.deliveryAttemptStartedAt === "string") {
            const updatedJob = await tx.followUpJob.update({
              where: { id: job.id },
              data: { status: FollowUpJobStatus.FAILED, failureReason: "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION", processingStartedAt: null },
            });
            return { job: updatedJob, message: existingMessage, sent: false, reason: "FOLLOW_UP_DELIVERY_PENDING_RECONCILIATION" };
          }
          const message = await tx.message.update({
            where: { id: existingMessage.id },
            data: {
              deliveryStatus: MessageDeliveryStatus.PENDING,
              provider: null,
              providerMessageId: null,
              metadata: json({
                ...existingMetadata,
                source: "FOLLOW_UP_AUTOMATION",
                jobId: job.id,
                ruleId: job.ruleId,
                contextType: job.contextType,
                retryingExistingFollowUpMessage: true,
                retryStartedAt: new Date().toISOString(),
              }),
            },
          });
          return { message, sent: true as const, reusedMessage: true as const };
        }
        const message = await tx.message.create({
          data: {
            businessId,
            leadId,
            conversationId,
            senderType: MessageSenderType.SYSTEM,
            messageType: MessageType.TEXT,
            direction: MessageDirection.OUTBOUND,
            deliveryStatus: MessageDeliveryStatus.PENDING,
            content: messageText,
            metadata: json({ source: "FOLLOW_UP_AUTOMATION", jobId: job.id, ruleId: job.ruleId, contextType: job.contextType }),
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessagePreview: messageText.slice(0, 240), lastMessageAt: message.createdAt },
        });
        await tx.leadActivity.create({
          data: {
            businessId,
            leadId,
            action: LeadActivityAction.MESSAGE_CREATED,
            metadata: json({ conversationId, messageId: message.id, senderType: MessageSenderType.SYSTEM, source: "FOLLOW_UP_AUTOMATION", jobId: job.id }),
          },
        });
        return { message, sent: true as const, reusedMessage: false as const };
      });
	      if (!prepared) continue;
	      if (!prepared.sent) {
	        const action = prepared.job.status === FollowUpJobStatus.CANCELLED
	          ? AuditAction.FOLLOW_UP_JOB_CANCELLED
	          : prepared.job.status === FollowUpJobStatus.FAILED
	            ? AuditAction.FOLLOW_UP_JOB_FAILED
	            : prepared.job.status === FollowUpJobStatus.SENT
	              ? AuditAction.FOLLOW_UP_JOB_SENT
		              : "rescheduledFor" in prepared && prepared.rescheduledFor
		                ? AuditAction.FOLLOW_UP_JOB_RESCHEDULED
		                : AuditAction.FOLLOW_UP_JOB_SKIPPED;
	        await auditService.log({
	          action,
	          businessId,
	          metadata: json({
	            jobId: job.id,
	            reason: prepared.reason,
	            rescheduledFor: "rescheduledFor" in prepared ? prepared.rescheduledFor : null,
	            messageId: "message" in prepared ? prepared.message?.id ?? null : null,
	            customerReplyId: "customerReplyId" in prepared ? prepared.customerReplyId : null,
	          }),
	        });
	        results.push(prepared.job);
	        continue;
	      }
	      const followUpMessage = prepared.message;
	      if (!followUpMessage) continue;

	      if (job.rule.type === FollowUpRuleType.NO_RESPONSE_AFTER_MESSAGE && job.relatedMessageId) {
	        const relatedMessageId = job.relatedMessageId;
	        const cancelledBeforeSend = await prisma.$transaction((tx) => cancelNoResponseFollowUpIfCustomerReplied(tx, {
	          businessId,
	          jobId: job.id,
	          conversationId,
	          relatedMessageId,
	          messageId: followUpMessage.id,
	        }));
	        if (cancelledBeforeSend) {
	          await auditService.log({
	            action: AuditAction.FOLLOW_UP_JOB_CANCELLED,
	            businessId,
	            metadata: json({
	              jobId: job.id,
	              reason: cancelledBeforeSend.reason,
	              messageId: followUpMessage.id,
	              customerReplyId: cancelledBeforeSend.customerReplyId,
	            }),
	          });
	          results.push(cancelledBeforeSend.job);
	          continue;
	        }
	      }

	      if (!prepared.reusedMessage) {
	        realtimeService.publish({
	          type: "message.created",
	          businessId,
	          conversationId,
	          leadId,
	          messageId: followUpMessage.id,
	          assignedStaffId: job.conversation?.assignedStaffId,
	          payload: { message: followUpMessage },
	        });
	      }

	      const deliveryAttemptStartedAt = new Date().toISOString();
	      await prisma.message.update({
	        where: { id: followUpMessage.id },
	        data: {
	          metadata: json({
	            ...jsonObject(followUpMessage.metadata),
	            source: "FOLLOW_UP_AUTOMATION",
	            jobId: job.id,
	            ruleId: job.ruleId,
	            contextType: job.contextType,
	            deliveryAttemptStartedAt,
	          }),
	        },
	      });

	      const providerResult = await sendWhatsAppText(integration, {
	        phoneNumberId: integration.phoneNumberId,
	        to: destinationPhone,
	        message: messageText,
	        businessId,
	        conversationId,
	        messageId: followUpMessage.id,
	      });
      const deliveryStatus = providerResult.success ? MessageDeliveryStatus.SENT : MessageDeliveryStatus.FAILED;
      const followUpDeliveryStatus = providerResult.success ? FollowUpSendLogDeliveryStatus.SENT : FollowUpSendLogDeliveryStatus.FAILED;
      const completed = await prisma.$transaction(async (tx) => {
        const updatedMessage = await tx.message.update({
	          where: { id: followUpMessage.id },
          data: {
            deliveryStatus,
            provider: providerResult.provider,
            providerMessageId: providerResult.providerMessageId,
            metadata: json({
              source: "FOLLOW_UP_AUTOMATION",
              jobId: job.id,
              ruleId: job.ruleId,
	              contextType: job.contextType,
	              deliveryAttemptStartedAt,
	              provider: providerResult.provider,
              providerMessageId: providerResult.providerMessageId ?? null,
              deliveryStatus,
              ...(providerResult.success ? {} : { error: providerResult.error ?? "WhatsApp follow-up send failed" }),
            }),
          },
        });
        const updatedJob = await tx.followUpJob.update({
          where: { id: job.id },
          data: {
            status: providerResult.success ? FollowUpJobStatus.SENT : FollowUpJobStatus.FAILED,
            sentAt: providerResult.success ? new Date() : null,
            failureReason: providerResult.success ? null : providerResult.error ?? "WHATSAPP_SEND_FAILED",
            processingStartedAt: null,
          },
        });
        await tx.followUpSendLog.create({
          data: {
            businessId,
            ruleId: job.ruleId,
            jobId: job.id,
	            leadId,
	            conversationId,
            appointmentId: job.appointmentId,
            quoteId: job.quoteId,
            messageText,
            sentBy: job.rule.useAiRewrite ? FollowUpSendLogSentBy.AI : FollowUpSendLogSentBy.SYSTEM,
            deliveryStatus: followUpDeliveryStatus,
            whatsappMessageId: providerResult.providerMessageId,
            failureReason: providerResult.success ? null : providerResult.error ?? "WHATSAPP_SEND_FAILED",
          },
        });
        await tx.leadActivity.create({
	          data: {
	            businessId,
	            leadId,
	            action: providerResult.success ? LeadActivityAction.MESSAGE_SENT : LeadActivityAction.MESSAGE_SEND_FAILED,
	            metadata: json({ conversationId, messageId: followUpMessage.id, jobId: job.id, provider: providerResult.provider, providerMessageId: providerResult.providerMessageId ?? null }),
          },
        });
        return { job: updatedJob, message: updatedMessage };
      });
      realtimeService.publish({
	        type: "message.status.updated",
	        businessId,
	        conversationId,
	        leadId,
	        messageId: followUpMessage.id,
	        assignedStaffId: job.conversation?.assignedStaffId,
	        payload: { messageId: followUpMessage.id, conversationId, previousStatus: MessageDeliveryStatus.PENDING, newStatus: deliveryStatus, updatedAt: completed.message.updatedAt },
      });
      if (!providerResult.success) {
        await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_FAILED, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, reason: providerResult.error ?? "WHATSAPP_SEND_FAILED" }) });
	        realtimeService.publish({ type: "business.follow_up.job.failed", businessId, conversationId, leadId, payload: { job: completed.job, reason: providerResult.error ?? "WHATSAPP_SEND_FAILED" }, broadcastToStaff: true });
        results.push(completed.job);
        continue;
      }
	      await auditService.log({ action: AuditAction.FOLLOW_UP_JOB_SENT, businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, messageId: followUpMessage.id }) });
	      await auditService.log({ action: basicSentAuditAction(job.rule.type), businessId, metadata: json({ jobId: job.id, ruleId: job.ruleId, messageId: followUpMessage.id, conversationId, leadId, appointmentId: job.appointmentId }) });
	      realtimeService.publish({ type: "business.follow_up.job.sent", businessId, conversationId, leadId, payload: { job: completed.job }, broadcastToStaff: true });
	      realtimeService.publish({ type: basicSentEventType(job.rule.type), businessId, conversationId, leadId, payload: { job: completed.job, message: completed.message }, broadcastToStaff: true });
      results.push(completed.job);
    }
    return results;
  },
};
