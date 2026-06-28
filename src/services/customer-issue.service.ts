import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessRole,
  CustomerIssueCategory,
  CustomerIssueCreatedBy,
  CustomerIssueSeverity,
  CustomerIssueStatus,
  CustomerIssueType,
  MembershipStatus,
  PlanCode,
  Prisma,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { AiReplyDecision } from "./ai-decision-parser.service";
import { aiUsageService } from "./ai-usage.service";
import { auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { createSystemMessage } from "./message.service";
import { emailService } from "./email.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { subscriptionService } from "./subscription.service";
import { CustomerIssueListQuery } from "../validation/customer-issue.schemas";

export type CustomerIssueActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type AiIssueInput = {
  businessId: string;
  businessAccountId: string;
  conversationId: string;
  leadId: string;
  customerMessageId: string;
  customerMessageContent: string;
  conversationAssignedMembershipId: string | null;
  clientOwnerMembershipId: string | null;
  decision: AiReplyDecision;
  accountUsageId: string;
  plan: PlanCode;
};

const issueInclude = {
  lead: { select: { id: true, fullName: true, phone: true, email: true } },
  conversation: { select: { id: true, displayId: true, subject: true, assignedStaffId: true } },
  responsibleMember: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
  suggestedResponsibleMember: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
  clientOwner: { select: { id: true, role: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
} satisfies Prisma.CustomerIssueLogInclude;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isManager(role: BusinessRole) {
  return role === BusinessRole.BUSINESS_OWNER || role === BusinessRole.MANAGER;
}

function listKey(actor: CustomerIssueActor, query: CustomerIssueListQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  return `business:${actor.businessId}:customer-issues:list:${scope}:${JSON.stringify(query)}`;
}

function detailKey(actor: CustomerIssueActor, issueId: string) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  return `business:${actor.businessId}:customer-issues:detail:${issueId}:${scope}`;
}

async function invalidateIssueCaches(businessId: string, issueId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:customer-issues:list:*`),
    ...(issueId ? [
      cacheService.del(`business:${businessId}:customer-issues:detail:${issueId}`),
      cacheService.delByPattern(`business:${businessId}:customer-issues:detail:${issueId}:*`),
    ] : []),
  ]);
}

function issueAccessWhere(actor: CustomerIssueActor): Prisma.CustomerIssueLogWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF ? { OR: [{ responsibleMembershipId: actor.membershipId }, { responsibleMembershipId: null }] } : {}),
  };
}

async function assertPlusOrPremium(businessAccountId: string, businessId: string) {
  const subscription = await subscriptionService.getCurrentRecord(businessAccountId);
  if (subscription.plan.code === PlanCode.BASIC) {
    throw new AppError(403, "Upgrade to Plus to access AI customer issue intelligence.", "PLAN_UPGRADE_REQUIRED", {
      currentPlan: PlanCode.BASIC,
      recommendedPlan: PlanCode.PLUS,
      featureKey: "customerIssueIntelligence",
    });
  }
  return subscription;
}

function normalizeWords(...values: Array<string | null | undefined>) {
  return values
    .flatMap((value) => (value ?? "").toLowerCase().split(/[^a-z0-9]+/))
    .filter(Boolean);
}

const categoryKeywords: Record<CustomerIssueCategory, string[]> = {
  DELAY: ["delay", "late", "slow", "waiting", "followup", "follow", "timeline"],
  POOR_SERVICE: ["service", "support", "rude", "unhelpful", "ignored"],
  QUALITY_ISSUE: ["quality", "workmanship", "broken", "bad", "poor", "defect"],
  STAFF_BEHAVIOR: ["staff", "worker", "agent", "behavior", "attitude", "rude"],
  MISCOMMUNICATION: ["communication", "miscommunication", "wrong", "confused", "unclear"],
  PAYMENT_ISSUE: ["payment", "refund", "invoice", "charge", "paid", "money"],
  APPOINTMENT_ISSUE: ["appointment", "booking", "visit", "inspection", "schedule"],
  DELIVERY_OR_SITE_ISSUE: ["site", "delivery", "dirty", "cleanup", "clean", "workers"],
  MISSING_ITEM_OR_MISSING_WORK: ["missing", "left", "unfinished", "incomplete", "item"],
  FOLLOW_UP_REQUIRED: ["follow", "callback", "reply", "response", "update"],
  OTHER: [],
};

function scoreMember(member: {
  positionTitle: string | null;
  specialties: string[];
  serviceTags: string[];
  aiHandoffPriority: number | null;
}, category: CustomerIssueCategory, summary: string, suggestedTags: string[]) {
  const serviceTags = normalizeWords(...member.serviceTags);
  const specialties = normalizeWords(...member.specialties);
  const title = normalizeWords(member.positionTitle);
  const summaryWords = normalizeWords(summary, ...suggestedTags);
  const categoryWords = categoryKeywords[category];
  let score = 0;
  if (categoryWords.some((word) => serviceTags.includes(word))) score += 5;
  if (summaryWords.some((word) => specialties.includes(word))) score += 5;
  if (categoryWords.some((word) => title.includes(word))) score += 3;
  if (member.aiHandoffPriority !== null) score += Math.max(0, 2 - Math.min(member.aiHandoffPriority, 10) / 10);
  return score;
}

async function managerRecipients(businessId: string) {
  return prisma.businessMember.findMany({
    where: {
      businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] },
    },
    select: { id: true, user: { select: { email: true, firstName: true, lastName: true } } },
  });
}

async function routeResponsibleStaff(input: { businessId: string; category: CustomerIssueCategory; summary: string; suggestedTags: string[] }) {
  const members = await prisma.businessMember.findMany({
    where: {
      businessId: input.businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.MANAGER, BusinessRole.STAFF] },
      isAiHandoffEligible: true,
    },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  if (members.length === 0) return { member: null, reason: "No active eligible AI handoff staff found." };
  if (members.length === 1) return { member: members[0], reason: "Only one active eligible AI handoff staff member was available." };
  const ranked = members
    .map((member) => ({ member, score: scoreMember(member, input.category, input.summary, input.suggestedTags) }))
    .sort((a, b) => b.score - a.score || (a.member.aiHandoffPriority ?? 999) - (b.member.aiHandoffPriority ?? 999));
  const best = ranked[0];
  if (!best || best.score <= 0) return { member: null, reason: "No eligible staff profile matched this issue strongly enough." };
  return { member: best.member, reason: `Matched staff profile with score ${best.score.toFixed(1)}.` };
}

function issuePriority(severity: CustomerIssueSeverity) {
  if (severity === CustomerIssueSeverity.URGENT) return BusinessNotificationPriority.URGENT;
  if (severity === CustomerIssueSeverity.HIGH) return BusinessNotificationPriority.HIGH;
  return BusinessNotificationPriority.NORMAL;
}

function conversationUrl(conversationId: string) {
  return `${env.FRONTEND_URL.replace(/\/$/, "")}/conversations/${encodeURIComponent(conversationId)}`;
}

function excerpt(value: string) {
  return value.trim().slice(0, 500);
}

export const customerIssueService = {
  async handleBasicSafeHandoff(input: AiIssueInput) {
    const managers = await managerRecipients(input.businessId);
    const recipients = Array.from(new Set([input.conversationAssignedMembershipId, ...managers.map((member) => member.id)].filter(Boolean))) as string[];
    const notifications = await notificationService.createNotificationsForRecipients({
      businessId: input.businessId,
      businessAccountId: input.businessAccountId,
      recipientMembershipIds: recipients,
      type: BusinessNotificationType.AI_HUMAN_REVIEW_REQUIRED,
      priority: BusinessNotificationPriority.HIGH,
      title: "Customer conversation needs attention",
      message: "Customer needs attention in this conversation.",
      entityType: BusinessNotificationEntityType.CONVERSATION,
      entityId: input.conversationId,
      actions: [{ label: "View conversation", action: "VIEW_CONVERSATION", variant: "default" }],
      metadata: { conversationId: input.conversationId, leadId: input.leadId, messageId: input.customerMessageId, source: "AI_SAFE_HANDOFF" },
    });
    const firstRecipient = input.conversationAssignedMembershipId
      ? await prisma.businessMember.findFirst({ where: { id: input.conversationAssignedMembershipId, businessId: input.businessId }, include: { user: true, business: true } })
      : null;
    const fallbackRecipient = firstRecipient ?? await prisma.businessMember.findFirst({
      where: { businessId: input.businessId, status: MembershipStatus.ACTIVE, role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] } },
      include: { user: true, business: true },
    });
    const emailSent = fallbackRecipient
      ? await emailService.sendCustomerAttentionEmail(fallbackRecipient.user.email, {
        businessName: fallbackRecipient.business.name,
        customerName: undefined,
        messageExcerpt: excerpt(input.customerMessageContent),
        conversationUrl: conversationUrl(input.conversationId),
        receivedAt: new Date(),
      })
      : false;
    await Promise.all([
      aiUsageService.trackSafeHandoff({ accountUsageId: input.accountUsageId, emailSent }),
      auditService.log({
        action: AuditAction.AI_SAFE_HANDOFF_TRIGGERED,
        businessId: input.businessId,
        metadata: json({ conversationId: input.conversationId, leadId: input.leadId, messageId: input.customerMessageId, plan: input.plan }),
      }),
      emailSent ? auditService.log({
        action: AuditAction.AI_SAFE_HANDOFF_NOTIFICATION_SENT,
        businessId: input.businessId,
        metadata: json({ conversationId: input.conversationId, emailSent }),
      }) : Promise.resolve(),
    ]);
    realtimeService.publish({
      type: "business.ai.safe_handoff_triggered",
      businessId: input.businessId,
      conversationId: input.conversationId,
      leadId: input.leadId,
      assignedStaffId: input.conversationAssignedMembershipId,
      payload: { conversationId: input.conversationId, notificationsCreated: notifications.length },
    });
    return { notifications, emailSent };
  },

  async createFromAiDecision(input: AiIssueInput) {
    if (input.plan === PlanCode.BASIC) return this.handleBasicSafeHandoff(input);
    const complaint = input.decision.complaint;
    if (!complaint?.isComplaint && input.decision.intent !== "COMPLAINT") return null;
    const category = complaint?.category ?? CustomerIssueCategory.OTHER;
    const severity = complaint?.severity ?? CustomerIssueSeverity.MEDIUM;
    const summary = complaint?.summary ?? input.decision.reason ?? "Customer issue detected by AI.";
    const routing = await routeResponsibleStaff({
      businessId: input.businessId,
      category,
      summary,
      suggestedTags: complaint?.suggestedStaffSpecialtyTags ?? [],
    });
    const now = new Date();
    const issue = await prisma.$transaction(async (tx) => {
      const created = await tx.customerIssueLog.create({
        data: {
          businessId: input.businessId,
          leadId: input.leadId,
          conversationId: input.conversationId,
          customerMessageId: input.customerMessageId,
          type: complaint?.requiresInternalAction ? CustomerIssueType.REQUEST_REQUIRES_INTERNAL_ACTION : CustomerIssueType.COMPLAINT,
          category,
          subcategory: complaint?.subcategory ?? null,
          severity,
          summary,
          customerMessageExcerpt: excerpt(input.customerMessageContent),
          clientOwnerMembershipId: input.clientOwnerMembershipId,
          conversationAssignedMembershipId: input.conversationAssignedMembershipId,
          suggestedResponsibleMembershipId: routing.member?.id ?? null,
          responsibleMembershipId: routing.member?.id ?? null,
          routingReason: routing.reason,
          createdBy: CustomerIssueCreatedBy.AI,
          metadata: json({
            decisionIntent: input.decision.intent,
            confidence: input.decision.confidence,
            suggestedStaffSpecialtyTags: complaint?.suggestedStaffSpecialtyTags ?? [],
          }),
          createdAt: now,
          updatedAt: now,
        },
        include: issueInclude,
      });
      await createSystemMessage({
        businessId: input.businessId,
        leadId: input.leadId,
        conversationId: input.conversationId,
        content: "Customer issue logged for internal follow-up.",
        metadata: json({ type: "CUSTOMER_ISSUE_LOGGED", issueId: created.id, category, severity }),
      }, tx);
      return created;
    });
    const managers = await managerRecipients(input.businessId);
    const business = await prisma.business.findUnique({ where: { id: input.businessId }, select: { name: true } });
    let emailSent = false;
    if (routing.member) {
      emailSent = await emailService.sendCustomerIssueAssignedEmail(routing.member.user.email, {
        businessName: business?.name ?? "Business",
        category,
        severity,
        summary,
        recommendedAction: input.decision.suggestedAction,
        conversationUrl: conversationUrl(input.conversationId),
        receivedAt: now,
      });
      await notificationService.createNotification({
        businessId: input.businessId,
        businessAccountId: input.businessAccountId,
        recipientMembershipId: routing.member.id,
        type: BusinessNotificationType.CUSTOMER_ISSUE_ASSIGNED,
        priority: issuePriority(severity),
        title: "Customer issue assigned to you",
        message: "A customer issue has been assigned to you.",
        entityType: BusinessNotificationEntityType.CUSTOMER_ISSUE,
        entityId: issue.id,
        actions: [{ label: "View issue", action: "VIEW_CUSTOMER_ISSUE", variant: "default" }],
        metadata: { issueId: issue.id, conversationId: input.conversationId, leadId: input.leadId, category, severity },
      });
      await notificationService.createNotificationsForRecipients({
        businessId: input.businessId,
        businessAccountId: input.businessAccountId,
        recipientMembershipIds: managers.map((member) => member.id).filter((id) => id !== routing.member?.id),
        type: BusinessNotificationType.CUSTOMER_ISSUE_VISIBILITY,
        priority: issuePriority(severity),
        title: "Customer issue routed",
        message: `A customer issue was routed to ${routing.member.user.firstName} ${routing.member.user.lastName}.`,
        entityType: BusinessNotificationEntityType.CUSTOMER_ISSUE,
        entityId: issue.id,
        actions: [{ label: "View issue", action: "VIEW_CUSTOMER_ISSUE", variant: "default" }],
        metadata: { issueId: issue.id, responsibleMembershipId: routing.member.id, conversationId: input.conversationId },
      });
    } else {
      await notificationService.createNotificationsForRecipients({
        businessId: input.businessId,
        businessAccountId: input.businessAccountId,
        recipientMembershipIds: managers.map((member) => member.id),
        type: BusinessNotificationType.CUSTOMER_ISSUE_UNROUTED,
        priority: issuePriority(severity),
        title: "Customer issue needs assignment",
        message: "A customer issue was logged but no responsible staff was found.",
        entityType: BusinessNotificationEntityType.CUSTOMER_ISSUE,
        entityId: issue.id,
        actions: [{ label: "View issue", action: "VIEW_CUSTOMER_ISSUE", variant: "default" }],
        metadata: { issueId: issue.id, conversationId: input.conversationId, routingReason: routing.reason },
      });
    }
    await Promise.all([
      aiUsageService.trackCustomerIssue({ accountUsageId: input.accountUsageId, routed: Boolean(routing.member), emailSent }),
      auditService.log({ action: AuditAction.AI_COMPLAINT_DETECTED, businessId: input.businessId, metadata: json({ issueId: issue.id, category, severity, plan: input.plan }) }),
      auditService.log({ action: AuditAction.CUSTOMER_ISSUE_LOG_CREATED, businessId: input.businessId, metadata: json({ issueId: issue.id, conversationId: input.conversationId, leadId: input.leadId, category, severity }) }),
      auditService.log({
        action: routing.member ? AuditAction.CUSTOMER_ISSUE_ROUTED_TO_STAFF : AuditAction.CUSTOMER_ISSUE_ROUTING_FALLBACK_TO_MANAGER,
        businessId: input.businessId,
        metadata: json({ issueId: issue.id, responsibleMembershipId: routing.member?.id ?? null, routingReason: routing.reason }),
      }),
      emailSent ? auditService.log({ action: AuditAction.CUSTOMER_ISSUE_EMAIL_SENT, businessId: input.businessId, metadata: json({ issueId: issue.id, responsibleMembershipId: routing.member?.id ?? null }) }) : Promise.resolve(),
      invalidateIssueCaches(input.businessId, issue.id),
    ]);
    realtimeService.publish({
      type: "business.customer_issue.created",
      businessId: input.businessId,
      conversationId: input.conversationId,
      leadId: input.leadId,
      staffMembershipIds: [issue.responsibleMembershipId],
      payload: { issue },
    });
    if (issue.responsibleMembershipId) {
      realtimeService.publish({
        type: "business.customer_issue.routed",
        businessId: input.businessId,
        conversationId: input.conversationId,
        leadId: input.leadId,
        staffMembershipIds: [issue.responsibleMembershipId],
        payload: { issueId: issue.id, responsibleMembershipId: issue.responsibleMembershipId },
      });
    }
    return { issue, emailSent };
  },

  async list(actor: CustomerIssueActor, query: CustomerIssueListQuery) {
    await assertPlusOrPremium(actor.businessAccountId, actor.businessId);
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const where: Prisma.CustomerIssueLogWhereInput = {
      ...issueAccessWhere(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.responsibleMembershipId ? { responsibleMembershipId: query.responsibleMembershipId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.createdFrom || query.createdTo ? { createdAt: { ...(query.createdFrom ? { gte: query.createdFrom } : {}), ...(query.createdTo ? { lte: query.createdTo } : {}) } } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.customerIssueLog.findMany({
        where,
        include: issueInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.customerIssueLog.count({ where }),
    ]);
    const result = { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    await cacheService.set(key, result, 60);
    return result;
  },

  async detail(actor: CustomerIssueActor, issueId: string) {
    await assertPlusOrPremium(actor.businessAccountId, actor.businessId);
    const key = detailKey(actor, issueId);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const issue = await prisma.customerIssueLog.findFirst({ where: { id: issueId, ...issueAccessWhere(actor) }, include: issueInclude });
    if (!issue) throw new AppError(404, "Customer issue not found.", "CUSTOMER_ISSUE_NOT_FOUND");
    const result = { issue };
    await cacheService.set(key, result, 120);
    return result;
  },

  async updateStatus(actor: CustomerIssueActor, issueId: string, status: CustomerIssueStatus) {
    await assertPlusOrPremium(actor.businessAccountId, actor.businessId);
    const existing = await prisma.customerIssueLog.findFirst({ where: { id: issueId, ...issueAccessWhere(actor) } });
    if (!existing) throw new AppError(404, "Customer issue not found.", "CUSTOMER_ISSUE_NOT_FOUND");
    if (actor.role === BusinessRole.STAFF && existing.responsibleMembershipId !== actor.membershipId) {
      throw new AppError(403, "You do not have permission to update this customer issue.", "FORBIDDEN");
    }
    if (status === CustomerIssueStatus.CLOSED && !isManager(actor.role)) {
      throw new AppError(403, "Only an owner or manager can close customer issues.", "FORBIDDEN");
    }
    const updated = await prisma.customerIssueLog.update({
      where: { id: existing.id },
      data: {
        status,
        resolvedAt: status === CustomerIssueStatus.RESOLVED || status === CustomerIssueStatus.CLOSED ? new Date() : null,
      },
      include: issueInclude,
    });
    await Promise.all([
      invalidateIssueCaches(actor.businessId, updated.id),
      auditService.log({
        action: AuditAction.CUSTOMER_ISSUE_STATUS_UPDATED,
        businessId: actor.businessId,
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        metadata: json({ issueId: updated.id, previousStatus: existing.status, newStatus: status }),
      }),
    ]);
    realtimeService.publish({
      type: "business.customer_issue.status_updated",
      businessId: actor.businessId,
      conversationId: updated.conversationId ?? undefined,
      leadId: updated.leadId ?? undefined,
      staffMembershipIds: [updated.responsibleMembershipId],
      payload: { issue: updated, previousStatus: existing.status, newStatus: status },
    });
    return { issue: updated };
  },
};
