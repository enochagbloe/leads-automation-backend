import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  DayOfWeek,
  FollowUpContextType,
  FollowUpJobStatus,
  FollowUpSendLogDeliveryStatus,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSenderType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { auditService } from "../audit.service";
import { FollowUpActor } from "./follow-up.types";

export const ruleInclude = {
  createdBy: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
  updatedBy: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
} satisfies Prisma.FollowUpAutomationRuleInclude;

export const jobInclude = {
  rule: { select: { id: true, type: true, name: true, enabled: true, planRequired: true } },
  lead: { select: { id: true, fullName: true, phone: true, email: true, status: true, assignedStaffId: true } },
  conversation: { select: { id: true, displayId: true, status: true, assignedStaffId: true, channel: true } },
  appointment: { select: { id: true, title: true, status: true, startTime: true, endTime: true, timezone: true, assignedStaffId: true, service: { select: { name: true } } } },
} satisfies Prisma.FollowUpJobInclude;

export const sendLogInclude = {
  rule: { select: { id: true, type: true, name: true } },
  job: { select: { id: true, status: true, contextType: true, scheduledFor: true } },
  lead: { select: { id: true, fullName: true, phone: true, email: true, assignedStaffId: true } },
  conversation: { select: { id: true, displayId: true, status: true, assignedStaffId: true } },
  appointment: { select: { id: true, title: true, status: true, startTime: true, timezone: true, assignedStaffId: true } },
} satisfies Prisma.FollowUpSendLogInclude;

export const FOLLOW_UP_MONTHLY_LIMIT_DELIVERY_STATUSES = [FollowUpSendLogDeliveryStatus.QUEUED, FollowUpSendLogDeliveryStatus.SENT] as const;
// QUEUED reserves monthly quota but does not advance a customer-facing
// sequence. Only provider-accepted sends count as completed attempts.
export const FOLLOW_UP_SUCCESSFUL_ATTEMPT_DELIVERY_STATUSES = [FollowUpSendLogDeliveryStatus.SENT] as const;
export const FOLLOW_UP_PROCESSING_STALE_MS = 10 * 60 * 1000;
export const FOLLOW_UP_DELIVERED_MESSAGE_STATUSES: MessageDeliveryStatus[] = [MessageDeliveryStatus.SENT, MessageDeliveryStatus.DELIVERED, MessageDeliveryStatus.READ];

export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

export function followUpActivityBaseline(input: {
  createdAt: Date;
  metadata: Prisma.JsonValue | null;
}, now = new Date()) {
  const value = jsonObject(input.metadata).premiumRecalculationBaselineAt;
  if (typeof value !== "string") return input.createdAt;
  const baseline = new Date(value);
  if (
    !Number.isFinite(baseline.getTime())
    || baseline < input.createdAt
    || baseline > now
  ) {
    return input.createdAt;
  }
  return baseline;
}

export function isManager(actor: FollowUpActor) {
  return actor.role === BusinessRole.BUSINESS_OWNER || actor.role === BusinessRole.MANAGER;
}

export function assertCanManage(actor: FollowUpActor) {
  if (!isManager(actor)) throw new AppError(403, "You do not have permission to manage follow-up automation.", "FORBIDDEN");
}

export function assertCanView(actor: FollowUpActor) {
  if (!actor.membershipId) throw new AppError(403, "Business access denied.", "BUSINESS_ACCESS_DENIED");
}

export function staffScopedConversationWhere(actor: FollowUpActor): Prisma.ConversationWhereInput {
  return actor.role === BusinessRole.STAFF
    ? { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] }
    : {};
}

export function jobAccessWhere(actor: FollowUpActor): Prisma.FollowUpJobWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF
      ? {
        OR: [
          { conversation: staffScopedConversationWhere(actor) },
          { conversationId: null, lead: { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] } },
          { conversationId: null, leadId: null, appointment: { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] } },
        ],
      }
      : {}),
  };
}

export function logAccessWhere(actor: FollowUpActor): Prisma.FollowUpSendLogWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF
      ? {
        OR: [
          { conversation: staffScopedConversationWhere(actor) },
          { conversationId: null, lead: { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] } },
          { conversationId: null, leadId: null, appointment: { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] } },
        ],
      }
      : {}),
  };
}

export async function audit(actor: FollowUpActor, action: AuditAction, metadata: Record<string, unknown>) {
  await auditService.log({
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: json(metadata),
  });
}

export async function lockFollowUpMonthlyQuotaScope(tx: Prisma.TransactionClient, businessAccountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('follow_up_monthly_quota'), hashtext(${businessAccountId}))`;
}

export function validTimezone(value: string) {
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

export function dateInTimezone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function timeInTimezone(date: Date, timezone: string) {
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

export function zonedDateTimeToUtc(date: string, time: string, timezone: string) {
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

export function humanDate(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone) ? timezone : "Africa/Accra",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function humanTime(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone) ? timezone : "Africa/Accra",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function extractEmail(text: string) {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

export function hasLikelyLocation(text: string) {
  const value = text.toLowerCase();
  return /\d+\s+[a-z0-9\s,.-]{3,}/i.test(text)
    || ["near", "opposite", "behind", "around", "at ", "street", "road", "avenue", "junction", "estate", "mall"].some((word) => value.includes(word));
}

export function extractDateTime(text: string) {
  const date = text.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i)?.[0];
  const time = text.match(/\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})\b/i)?.[0];
  return { date, time };
}

export function quoteAccepted(text: string) {
  return /\b(yes|ok|okay|go ahead|proceed|accepted|approve|approved|sounds good|let'?s do it)\b/i.test(text);
}

export function quoteRejected(text: string) {
  return /\b(no|not interested|cancel|reject|decline|too expensive|don't proceed|do not proceed)\b/i.test(text);
}

export function meaningfulReply(text: string) {
  return text.trim().split(/\s+/).length >= 2;
}

export function clearPlaceholders(value: string) {
  return value
    .replace(/\s*\{\{[^}]+}}\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

export function followUpJobDedupeKey(input: {
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

export async function validateRuleTargets(actor: FollowUpActor, input: {
  leadId?: string | null;
  conversationId?: string | null;
  appointmentId?: string | null;
}) {
  const [lead, conversation, appointment] = await Promise.all([
    input.leadId ? prisma.lead.findFirst({ where: { id: input.leadId, businessId: actor.businessId, deletedAt: null }, select: { id: true } }) : Promise.resolve(null),
    input.conversationId ? prisma.conversation.findFirst({ where: { id: input.conversationId, businessId: actor.businessId, deletedAt: null }, select: { id: true, leadId: true } }) : Promise.resolve(null),
    input.appointmentId ? prisma.appointment.findFirst({ where: { id: input.appointmentId, businessId: actor.businessId }, select: { id: true, leadId: true, conversationId: true } }) : Promise.resolve(null),
  ]);

  if (input.leadId && !lead) throw new AppError(404, "Lead not found.", "LEAD_NOT_FOUND");
  if (input.conversationId && !conversation) throw new AppError(404, "Conversation not found.", "CONVERSATION_NOT_FOUND");
  if (input.appointmentId && !appointment) throw new AppError(404, "Appointment not found.", "APPOINTMENT_NOT_FOUND");
  if (input.leadId && conversation && conversation.leadId !== input.leadId) {
    throw new AppError(422, "Conversation must belong to the selected lead.", "FOLLOW_UP_TARGET_MISMATCH");
  }
  if (input.leadId && appointment?.leadId && appointment.leadId !== input.leadId) {
    throw new AppError(422, "Appointment must belong to the selected lead.", "FOLLOW_UP_TARGET_MISMATCH");
  }
  if (input.conversationId && appointment?.conversationId && appointment.conversationId !== input.conversationId) {
    throw new AppError(422, "Appointment must belong to the selected conversation.", "FOLLOW_UP_TARGET_MISMATCH");
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

export async function nextFollowUpAllowedAfterCooldown(tx: Prisma.TransactionClient, job: {
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

export async function cancelNoResponseFollowUpIfCustomerReplied(tx: Prisma.TransactionClient, input: {
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

export async function businessHoursFollowUpDecision(tx: Prisma.TransactionClient, businessId: string, from: Date) {
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
