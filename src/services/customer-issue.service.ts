import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessRole,
  ConversationChannel,
  CustomerIssueCategory,
  CustomerIssueCreatedBy,
  CustomerIssueSeverity,
  CustomerIssueStatus,
  CustomerIssueType,
  LeadActivityAction,
  MembershipStatus,
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
import { AiReplyDecision } from "./ai-decision-parser.service";
import { aiUsageService } from "./ai-usage.service";
import { auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { createSystemMessage } from "./message.service";
import { getWhatsAppIntegration, sendWhatsAppText } from "./whatsapp-provider.service";
import { emailService } from "./email.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { subscriptionService } from "./subscription.service";
import { CustomerIssueListQuery, CustomerIssueMetricsQuery } from "../validation/customer-issue.schemas";

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

type AiComplaintInput = NonNullable<AiReplyDecision["complaint"]>;

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

function hasPlusComplaintIntelligence(plan: PlanCode) {
  return plan === PlanCode.PLUS || plan === PlanCode.PREMIUM;
}

async function assertPlusComplaintIntelligence(actor: CustomerIssueActor) {
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  if (!hasPlusComplaintIntelligence(subscription.plan.code)) {
    throw new AppError(403, "Upgrade to Plus to access complaint intelligence and dashboard metrics.", "PLAN_UPGRADE_REQUIRED", {
      currentPlan: subscription.plan.code,
      recommendedPlan: PlanCode.PLUS,
      featureKey: "complaintIntelligence",
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

function basicComplaintSummary(customerMessageContent: string) {
  const value = excerpt(customerMessageContent);
  return value ? `Customer complaint recorded: ${value}`.slice(0, 500) : "Customer complaint recorded for follow-up.";
}

function complaintCategoryForPlan(complaint: AiComplaintInput, plan: PlanCode) {
  return hasPlusComplaintIntelligence(plan) ? complaint.category ?? CustomerIssueCategory.OTHER : CustomerIssueCategory.OTHER;
}

function complaintSeverityForPlan(complaint: AiComplaintInput, plan: PlanCode) {
  return hasPlusComplaintIntelligence(plan) ? complaint.severity ?? CustomerIssueSeverity.MEDIUM : CustomerIssueSeverity.MEDIUM;
}

function complaintSummaryForPlan(input: { complaint: AiComplaintInput; plan: PlanCode; reason: string; customerMessageContent: string }) {
  if (!hasPlusComplaintIntelligence(input.plan)) return basicComplaintSummary(input.customerMessageContent);
  return input.complaint.summary ?? input.reason ?? "Customer issue detected by AI.";
}

function complaintTagsForPlan(complaint: AiComplaintInput, plan: PlanCode) {
  return hasPlusComplaintIntelligence(plan) ? complaint.suggestedStaffSpecialtyTags ?? [] : [];
}

const stopWords = new Set([
  "about", "again", "because", "been", "being", "from", "have", "into", "just", "more", "some", "that", "their", "them", "then", "there", "they", "this", "very", "were", "what", "when", "with", "your",
]);

const severityRank: Record<CustomerIssueSeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  URGENT: 4,
};

function complaintInputs(decision: AiReplyDecision): AiComplaintInput[] {
  const values = [...(decision.complaints ?? []), ...(decision.complaint ? [decision.complaint] : [])]
    .filter((complaint): complaint is AiComplaintInput => complaint.isComplaint === true);
  const seen = new Set<string>();
  return values.filter((complaint) => {
    const key = `${complaint.category ?? CustomerIssueCategory.OTHER}:${(complaint.summary ?? "").toLowerCase().replace(/\s+/g, " ").slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function wordsForMatching(...values: Array<string | null | undefined>) {
  return normalizeWords(...values)
    .filter((word) => word.length >= 4 && !stopWords.has(word))
    .slice(0, 80);
}

function issueMetadata(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

function appendUnique(values: unknown, value: string) {
  const list = Array.isArray(values) ? values.filter((item): item is string => typeof item === "string") : [];
  return Array.from(new Set([...list, value])).slice(-50);
}

function appendTimeline(values: unknown, event: Record<string, unknown>) {
  const list = Array.isArray(values) ? values.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  return [...list, event].slice(-50);
}

function strongerSeverity(current: CustomerIssueSeverity, next: CustomerIssueSeverity) {
  return severityRank[next] > severityRank[current] ? next : current;
}

function matchScore(issue: {
  category: CustomerIssueCategory;
  subcategory: string | null;
  summary: string;
  customerMessageExcerpt: string | null;
}, complaint: AiComplaintInput, customerMessageContent: string) {
  const category = complaint.category ?? CustomerIssueCategory.OTHER;
  let score = issue.category === category ? 5 : 0;
  if (issue.subcategory && complaint.subcategory && issue.subcategory.toLowerCase() === complaint.subcategory.toLowerCase()) score += 2;
  const existingWords = new Set(wordsForMatching(issue.summary, issue.customerMessageExcerpt, issue.subcategory));
  const incomingWords = wordsForMatching(complaint.summary, complaint.subcategory, customerMessageContent);
  const overlap = incomingWords.filter((word) => existingWords.has(word)).length;
  score += Math.min(overlap, 6);
  return score;
}

async function findMatchingIssue(input: {
  businessId: string;
  conversationId: string;
  customerMessageContent: string;
  complaint: AiComplaintInput;
}) {
  const existing = await prisma.customerIssueLog.findMany({
    where: {
      businessId: input.businessId,
      conversationId: input.conversationId,
      status: { in: [CustomerIssueStatus.OPEN, CustomerIssueStatus.ACKNOWLEDGED, CustomerIssueStatus.REOPENED, CustomerIssueStatus.RESOLVED] },
    },
    include: issueInclude,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 25,
  });
  const ranked = existing
    .map((issue) => ({ issue, score: matchScore(issue, input.complaint, input.customerMessageContent) }))
    .filter((entry) => entry.score >= 6 || (entry.issue.category === (input.complaint.category ?? CustomerIssueCategory.OTHER) && entry.score >= 5))
    .sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
}

async function notifyIssueUpdate(input: {
  businessId: string;
  businessAccountId: string;
  issueId: string;
  conversationId: string;
  leadId: string;
  responsibleMembershipId: string | null;
  category: CustomerIssueCategory;
  severity: CustomerIssueSeverity;
  reopened: boolean;
}) {
  const managers = await managerRecipients(input.businessId);
  const recipients = Array.from(new Set([
    input.responsibleMembershipId,
    ...managers.map((member) => member.id),
  ].filter(Boolean))) as string[];
  if (recipients.length === 0) return;
  await notificationService.createNotificationsForRecipients({
    businessId: input.businessId,
    businessAccountId: input.businessAccountId,
    recipientMembershipIds: recipients,
    type: input.reopened ? BusinessNotificationType.CUSTOMER_ISSUE_VISIBILITY : BusinessNotificationType.CUSTOMER_ISSUE_ASSIGNED,
    priority: issuePriority(input.severity),
    title: input.reopened ? "Customer issue reopened" : "Customer issue updated",
    message: input.reopened
      ? "A resolved customer issue was reopened by a new related customer message."
      : "A new customer message was matched to an existing customer issue.",
    entityType: BusinessNotificationEntityType.CUSTOMER_ISSUE,
    entityId: input.issueId,
    actions: [{ label: "View issue", action: "VIEW_CUSTOMER_ISSUE", variant: "default" }],
    metadata: {
      issueId: input.issueId,
      conversationId: input.conversationId,
      leadId: input.leadId,
      category: input.category,
      severity: input.severity,
      reopened: input.reopened,
    },
  });
}

async function sendResolutionCustomerMessage(input: {
  actor: CustomerIssueActor;
  issue: Prisma.CustomerIssueLogGetPayload<{ include: typeof issueInclude }>;
}) {
  if (!input.issue.conversationId || !input.issue.leadId) return null;
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.issue.conversationId, businessId: input.actor.businessId, deletedAt: null },
    include: { lead: { select: { phone: true } } },
  });
  if (!conversation) return null;
  const content = "Your concern has been resolved from our side. If you notice anything else or have additional concerns, please let us know. We're happy to assist.";
  let deliveryStatus: MessageDeliveryStatus = conversation.channel === ConversationChannel.WHATSAPP ? MessageDeliveryStatus.PENDING : MessageDeliveryStatus.INTERNAL;
  let provider: string | null = null;
  let providerMessageId: string | null = null;
  let sendError: string | null = null;
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        businessId: input.actor.businessId,
        conversationId: conversation.id,
        leadId: conversation.leadId,
        senderType: MessageSenderType.AI,
        content,
        messageType: MessageType.TEXT,
        direction: MessageDirection.OUTBOUND,
        deliveryStatus,
        readAt: deliveryStatus === MessageDeliveryStatus.INTERNAL ? new Date() : null,
        metadata: json({ source: "CUSTOMER_ISSUE_RESOLUTION", issueId: input.issue.id }),
      },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { lastMessagePreview: content.slice(0, 240), lastMessageAt: created.createdAt },
    });
    await tx.leadActivity.create({
      data: {
        businessId: input.actor.businessId,
        leadId: conversation.leadId,
        actorUserId: input.actor.userId,
        action: LeadActivityAction.MESSAGE_CREATED,
        metadata: { source: "CUSTOMER_ISSUE_RESOLUTION", conversationId: conversation.id, issueId: input.issue.id, messageId: created.id, senderType: MessageSenderType.AI },
      },
    });
    return created;
  });
  if (conversation.channel === ConversationChannel.WHATSAPP) {
    try {
      const integration = await getWhatsAppIntegration(input.actor.businessId);
      const result = await sendWhatsAppText(integration, {
        phoneNumberId: integration.phoneNumberId,
        to: conversation.lead.phone,
        message: content,
        businessId: input.actor.businessId,
        conversationId: conversation.id,
        messageId: message.id,
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
  const settled = await prisma.message.update({
    where: { id: message.id },
    data: {
      deliveryStatus,
      provider,
      providerMessageId,
      metadata: json({ source: "CUSTOMER_ISSUE_RESOLUTION", issueId: input.issue.id, deliveryStatus, provider, providerMessageId, ...(sendError ? { error: sendError } : {}) }),
    },
  });
  await Promise.all([
    cacheService.delByPattern(`business:${input.actor.businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${input.actor.businessId}:conversations:detail:${conversation.id}:*`),
    cacheService.delByPattern(`business:${input.actor.businessId}:conversations:stats:*`),
    cacheService.delByPattern(`business:${input.actor.businessId}:conversations:unread:*`),
  ]);
  realtimeService.publish({
    type: "message.created",
    businessId: input.actor.businessId,
    conversationId: conversation.id,
    leadId: conversation.leadId,
    messageId: settled.id,
    assignedStaffId: conversation.assignedStaffId,
    payload: { message: settled },
  });
  realtimeService.publish({
    type: "conversation.updated",
    businessId: input.actor.businessId,
    conversationId: conversation.id,
    leadId: conversation.leadId,
    assignedStaffId: conversation.assignedStaffId,
    payload: { conversationId: conversation.id, changes: { lastMessagePreview: content.slice(0, 240), lastMessageAt: settled.createdAt } },
  });
  return settled;
}

type IssueWithInclude = Prisma.CustomerIssueLogGetPayload<{ include: typeof issueInclude }>;

function resolutionDurationMs(issue: { createdAt: Date; resolvedAt: Date | null }) {
  return issue.resolvedAt ? Math.max(0, issue.resolvedAt.getTime() - issue.createdAt.getTime()) : null;
}

async function firstResponseMap(issues: Array<{ id: string; conversationId: string | null; createdAt: Date }>) {
  const responsePairs = await Promise.all(issues.map(async (issue) => {
    if (!issue.conversationId) return [issue.id, null] as const;
    const response = await prisma.message.findFirst({
      where: {
        conversationId: issue.conversationId,
        createdAt: { gte: issue.createdAt },
        direction: MessageDirection.OUTBOUND,
        senderType: { in: [MessageSenderType.STAFF, MessageSenderType.AI, MessageSenderType.SYSTEM] },
        deletedAt: null,
      },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return [issue.id, response?.createdAt ?? null] as const;
  }));
  return new Map(responsePairs);
}

async function withPlusTiming<T extends IssueWithInclude>(issues: T[]) {
  if (issues.length === 0) return issues.map((issue) => ({ issue, metrics: { firstResponseAt: null, responseDurationMs: null, resolutionDurationMs: resolutionDurationMs(issue) } }));
  const responses = await firstResponseMap(issues);
  return issues.map((issue) => {
    const firstResponseAt = responses.get(issue.id) ?? null;
    return {
      ...issue,
      firstResponseAt,
      responseDurationMs: firstResponseAt ? Math.max(0, firstResponseAt.getTime() - issue.createdAt.getTime()) : null,
      resolutionDurationMs: resolutionDurationMs(issue),
    };
  });
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
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
    const detectedComplaints = complaintInputs(input.decision);
    if (detectedComplaints.length === 0 && input.decision.intent !== "COMPLAINT") return null;
    const complaints = detectedComplaints.length > 0
      ? detectedComplaints
      : [{
        isComplaint: true,
        category: CustomerIssueCategory.OTHER,
        severity: CustomerIssueSeverity.MEDIUM,
        summary: input.decision.reason || "Customer issue detected by AI.",
        requiresInternalAction: true,
        suggestedStaffSpecialtyTags: [],
      } satisfies AiComplaintInput];
    const managers = await managerRecipients(input.businessId);
    const business = await prisma.business.findUnique({ where: { id: input.businessId }, select: { name: true } });
    const results: Array<{
      issue: Prisma.CustomerIssueLogGetPayload<{ include: typeof issueInclude }>;
      emailSent: boolean;
      matchedExisting: boolean;
      reopened: boolean;
    }> = [];
    const plusIntelligence = hasPlusComplaintIntelligence(input.plan);

    for (const complaint of complaints) {
      const category = complaintCategoryForPlan(complaint, input.plan);
      const severity = complaintSeverityForPlan(complaint, input.plan);
      const summary = complaintSummaryForPlan({
        complaint,
        plan: input.plan,
        reason: input.decision.reason,
        customerMessageContent: input.customerMessageContent,
      });
      const match = await findMatchingIssue({
        businessId: input.businessId,
        conversationId: input.conversationId,
        customerMessageContent: input.customerMessageContent,
        complaint: { ...complaint, category, severity, summary },
      });
      if (match) {
        const reopened = match.issue.status === CustomerIssueStatus.RESOLVED;
        const updated = await prisma.$transaction(async (tx) => {
          const metadata = issueMetadata(match.issue.metadata);
          const timelineEvent = {
            type: reopened ? "CUSTOMER_ISSUE_REOPENED_BY_CUSTOMER_MESSAGE" : "CUSTOMER_ISSUE_MESSAGE_MATCHED",
            messageId: input.customerMessageId,
            summary,
            category,
            severity,
            matchedAt: new Date().toISOString(),
            score: match.score,
          };
          const record = await tx.customerIssueLog.update({
            where: { id: match.issue.id },
            data: {
              customerMessageId: input.customerMessageId,
              customerMessageExcerpt: excerpt(input.customerMessageContent),
              severity: strongerSeverity(match.issue.severity, severity),
              ...(plusIntelligence ? { category, subcategory: complaint.subcategory ?? match.issue.subcategory, summary } : {}),
              ...(reopened ? {
                status: CustomerIssueStatus.REOPENED,
                resolvedAt: null,
                reopenCount: { increment: 1 },
              } : {}),
              metadata: json({
                ...metadata,
                lastMatchedMessageId: input.customerMessageId,
                lastMatchedAt: timelineEvent.matchedAt,
                relatedCustomerMessageIds: appendUnique(metadata.relatedCustomerMessageIds, input.customerMessageId),
                timeline: appendTimeline(metadata.timeline, timelineEvent),
              }),
            },
            include: issueInclude,
          });
          await createSystemMessage({
            businessId: input.businessId,
            leadId: input.leadId,
            conversationId: input.conversationId,
            content: reopened
              ? "Customer issue reopened by a new related customer message."
              : "Customer issue updated with a new related customer message.",
            metadata: json({ type: reopened ? "CUSTOMER_ISSUE_REOPENED" : "CUSTOMER_ISSUE_MESSAGE_MATCHED", issueId: record.id, category, severity, messageId: input.customerMessageId }),
          }, tx);
          return record;
        });
        await Promise.all([
          notifyIssueUpdate({
            businessId: input.businessId,
            businessAccountId: input.businessAccountId,
            issueId: updated.id,
            conversationId: input.conversationId,
            leadId: input.leadId,
            responsibleMembershipId: updated.responsibleMembershipId,
            category: updated.category,
            severity: updated.severity,
            reopened,
          }),
          auditService.log({
            action: reopened ? AuditAction.CUSTOMER_ISSUE_STATUS_UPDATED : AuditAction.AI_COMPLAINT_DETECTED,
            businessId: input.businessId,
            metadata: json({
              issueId: updated.id,
              conversationId: input.conversationId,
              leadId: input.leadId,
              messageId: input.customerMessageId,
              matchedExisting: true,
              reopened,
              previousStatus: match.issue.status,
              newStatus: updated.status,
              matchScore: match.score,
            }),
          }),
          invalidateIssueCaches(input.businessId, updated.id),
        ]);
        const staffMembershipIds = [updated.responsibleMembershipId].filter((id): id is string => Boolean(id));
        realtimeService.publish({
          type: "business.customer_issue.status_updated",
          businessId: input.businessId,
          conversationId: input.conversationId,
          leadId: input.leadId,
          staffMembershipIds,
          payload: { issue: updated, matchedExisting: true, reopened },
        });
        results.push({ issue: updated, emailSent: false, matchedExisting: true, reopened });
        continue;
      }

      const routing = await routeResponsibleStaff({
        businessId: input.businessId,
        category,
        summary,
        suggestedTags: complaintTagsForPlan(complaint, input.plan),
      });
      const now = new Date();
      const issue = await prisma.$transaction(async (tx) => {
        const created = await tx.customerIssueLog.create({
          data: {
            businessId: input.businessId,
            leadId: input.leadId,
            conversationId: input.conversationId,
            customerMessageId: input.customerMessageId,
            type: complaint.requiresInternalAction ? CustomerIssueType.REQUEST_REQUIRES_INTERNAL_ACTION : CustomerIssueType.COMPLAINT,
            category,
            subcategory: complaint.subcategory ?? null,
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
              suggestedStaffSpecialtyTags: complaintTagsForPlan(complaint, input.plan),
              intelligenceEnabled: plusIntelligence,
              relatedCustomerMessageIds: [input.customerMessageId],
              timeline: [{
                type: "CUSTOMER_ISSUE_CREATED_FROM_CUSTOMER_MESSAGE",
                messageId: input.customerMessageId,
                summary,
                category,
                severity,
                createdAt: now.toISOString(),
              }],
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
        auditService.log({ action: AuditAction.AI_COMPLAINT_DETECTED, businessId: input.businessId, metadata: json({ issueId: issue.id, category, severity, plan: input.plan, matchedExisting: false }) }),
        auditService.log({ action: AuditAction.CUSTOMER_ISSUE_LOG_CREATED, businessId: input.businessId, metadata: json({ issueId: issue.id, conversationId: input.conversationId, leadId: input.leadId, category, severity }) }),
        auditService.log({
          action: routing.member ? AuditAction.CUSTOMER_ISSUE_ROUTED_TO_STAFF : AuditAction.CUSTOMER_ISSUE_ROUTING_FALLBACK_TO_MANAGER,
          businessId: input.businessId,
          metadata: json({ issueId: issue.id, responsibleMembershipId: routing.member?.id ?? null, routingReason: routing.reason }),
        }),
        emailSent ? auditService.log({ action: AuditAction.CUSTOMER_ISSUE_EMAIL_SENT, businessId: input.businessId, metadata: json({ issueId: issue.id, responsibleMembershipId: routing.member?.id ?? null }) }) : Promise.resolve(),
        invalidateIssueCaches(input.businessId, issue.id),
      ]);
      const staffMembershipIds = [issue.responsibleMembershipId].filter((id): id is string => Boolean(id));
      realtimeService.publish({
        type: "business.customer_issue.created",
        businessId: input.businessId,
        conversationId: input.conversationId,
        leadId: input.leadId,
        staffMembershipIds,
        payload: { issue },
      });
      if (issue.responsibleMembershipId) {
        realtimeService.publish({
          type: "business.customer_issue.routed",
          businessId: input.businessId,
          conversationId: input.conversationId,
          leadId: input.leadId,
          staffMembershipIds,
          payload: { issueId: issue.id, responsibleMembershipId: issue.responsibleMembershipId },
        });
      }
      results.push({ issue, emailSent, matchedExisting: false, reopened: false });
    }

    if (results.length === 0) return null;
    return {
      issue: results[0]!.issue,
      issues: results.map((result) => result.issue),
      emailSent: results.some((result) => result.emailSent),
      matchedExisting: results.every((result) => result.matchedExisting),
      reopened: results.some((result) => result.reopened),
    };
  },

  async list(actor: CustomerIssueActor, query: CustomerIssueListQuery) {
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
    const includePlusMetrics = hasPlusComplaintIntelligence(subscription.plan.code);
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
    const result = {
      data: includePlusMetrics ? await withPlusTiming(data) : data,
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
    await cacheService.set(key, result, 60);
    return result;
  },

  async detail(actor: CustomerIssueActor, issueId: string) {
    const key = detailKey(actor, issueId);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
    const issue = await prisma.customerIssueLog.findFirst({ where: { id: issueId, ...issueAccessWhere(actor) }, include: issueInclude });
    if (!issue) throw new AppError(404, "Customer issue not found.", "CUSTOMER_ISSUE_NOT_FOUND");
    const result = { issue: hasPlusComplaintIntelligence(subscription.plan.code) ? (await withPlusTiming([issue]))[0] : issue };
    await cacheService.set(key, result, 120);
    return result;
  },

  async metrics(actor: CustomerIssueActor, query: CustomerIssueMetricsQuery) {
    await assertPlusComplaintIntelligence(actor);
    const where: Prisma.CustomerIssueLogWhereInput = {
      ...issueAccessWhere(actor),
      ...(query.createdFrom || query.createdTo ? { createdAt: { ...(query.createdFrom ? { gte: query.createdFrom } : {}), ...(query.createdTo ? { lte: query.createdTo } : {}) } } : {}),
    };
    const [issues, byStatus, byCategory, byPriority, members] = await Promise.all([
      prisma.customerIssueLog.findMany({
        where,
        select: {
          id: true,
          status: true,
          category: true,
          severity: true,
          responsibleMembershipId: true,
          createdAt: true,
          resolvedAt: true,
          reopenCount: true,
        },
      }),
      prisma.customerIssueLog.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.customerIssueLog.groupBy({ by: ["category"], where, _count: { _all: true } }),
      prisma.customerIssueLog.groupBy({ by: ["severity"], where, _count: { _all: true } }),
      prisma.businessMember.findMany({
        where: { businessId: actor.businessId },
        select: { id: true, role: true, user: { select: { firstName: true, lastName: true, email: true } } },
      }),
    ]);
    const resolved = issues.filter((issue) => issue.resolvedAt);
    const memberMap = new Map(members.map((member) => [member.id, member]));
    const staffStats = new Map<string, {
      membershipId: string;
      name: string;
      email: string;
      role: BusinessRole;
      assignedComplaints: number;
      resolvedComplaints: number;
      resolutionDurations: number[];
    }>();
    for (const issue of issues) {
      if (!issue.responsibleMembershipId) continue;
      const member = memberMap.get(issue.responsibleMembershipId);
      const name = member ? `${member.user.firstName} ${member.user.lastName}`.trim() : "Unknown staff";
      const current = staffStats.get(issue.responsibleMembershipId) ?? {
        membershipId: issue.responsibleMembershipId,
        name,
        email: member?.user.email ?? "",
        role: member?.role ?? BusinessRole.STAFF,
        assignedComplaints: 0,
        resolvedComplaints: 0,
        resolutionDurations: [],
      };
      current.assignedComplaints += 1;
      if (issue.resolvedAt) {
        current.resolvedComplaints += 1;
        current.resolutionDurations.push(resolutionDurationMs(issue) ?? 0);
      }
      staffStats.set(issue.responsibleMembershipId, current);
    }
    const openStatuses = new Set<CustomerIssueStatus>([CustomerIssueStatus.OPEN, CustomerIssueStatus.ACKNOWLEDGED, CustomerIssueStatus.REOPENED]);
    return {
      totalComplaints: issues.length,
      openComplaints: issues.filter((issue) => openStatuses.has(issue.status)).length,
      resolvedComplaints: issues.filter((issue) => issue.status === CustomerIssueStatus.RESOLVED).length,
      reopenedComplaints: issues.filter((issue) => issue.status === CustomerIssueStatus.REOPENED || issue.reopenCount > 0).length,
      byStatus: Object.fromEntries(Object.values(CustomerIssueStatus).map((status) => [status, byStatus.find((item) => item.status === status)?._count._all ?? 0])),
      byCategory: Object.fromEntries(Object.values(CustomerIssueCategory).map((category) => [category, byCategory.find((item) => item.category === category)?._count._all ?? 0])),
      byPriority: Object.fromEntries(Object.values(CustomerIssueSeverity).map((severity) => [severity, byPriority.find((item) => item.severity === severity)?._count._all ?? 0])),
      averageResolutionTimeMs: average(resolved.map((issue) => resolutionDurationMs(issue) ?? 0)),
      staffStats: Array.from(staffStats.values()).map((stat) => ({
        membershipId: stat.membershipId,
        name: stat.name,
        email: stat.email,
        role: stat.role,
        assignedComplaints: stat.assignedComplaints,
        resolvedComplaints: stat.resolvedComplaints,
        averageResolutionTimeMs: average(stat.resolutionDurations),
      })).sort((a, b) => b.assignedComplaints - a.assignedComplaints || a.name.localeCompare(b.name)),
    };
  },

  async updateIntelligence(
    actor: CustomerIssueActor,
    issueId: string,
    input: { category?: CustomerIssueCategory; severity?: CustomerIssueSeverity; summary?: string },
  ) {
    await assertPlusComplaintIntelligence(actor);
    const existing = await prisma.customerIssueLog.findFirst({ where: { id: issueId, ...issueAccessWhere(actor) } });
    if (!existing) throw new AppError(404, "Customer issue not found.", "CUSTOMER_ISSUE_NOT_FOUND");
    if (actor.role === BusinessRole.STAFF && existing.responsibleMembershipId !== actor.membershipId) {
      throw new AppError(403, "You do not have permission to update this customer issue.", "FORBIDDEN");
    }
    const updated = await prisma.customerIssueLog.update({
      where: { id: existing.id },
      data: {
        ...(input.category ? { category: input.category } : {}),
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        metadata: json({
          ...issueMetadata(existing.metadata),
          intelligenceEditedAt: new Date().toISOString(),
          intelligenceEditedByMembershipId: actor.membershipId,
        }),
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
        metadata: json({
          issueId: updated.id,
          previousCategory: existing.category,
          newCategory: updated.category,
          previousSeverity: existing.severity,
          newSeverity: updated.severity,
          summaryUpdated: Boolean(input.summary),
          source: "CUSTOMER_ISSUE_INTELLIGENCE_EDIT",
        }),
      }),
    ]);
    const staffMembershipIds = [updated.responsibleMembershipId].filter((id): id is string => Boolean(id));
    realtimeService.publish({
      type: "business.customer_issue.status_updated",
      businessId: actor.businessId,
      conversationId: updated.conversationId ?? undefined,
      leadId: updated.leadId ?? undefined,
      staffMembershipIds,
      payload: { issue: updated, previousCategory: existing.category, previousSeverity: existing.severity, intelligenceUpdated: true },
    });
    return { issue: updated };
  },

  async updateStatus(actor: CustomerIssueActor, issueId: string, status: CustomerIssueStatus) {
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
    if (status === CustomerIssueStatus.RESOLVED && existing.status !== CustomerIssueStatus.RESOLVED) {
      sendResolutionCustomerMessage({ actor, issue: updated }).catch((error) => {
        console.error("Customer issue resolution message failed", { issueId: updated.id, error });
      });
    }
    const staffMembershipIds = [updated.responsibleMembershipId].filter((id): id is string => Boolean(id));
    realtimeService.publish({
      type: "business.customer_issue.status_updated",
      businessId: actor.businessId,
      conversationId: updated.conversationId ?? undefined,
      leadId: updated.leadId ?? undefined,
      staffMembershipIds,
      payload: { issue: updated, previousStatus: existing.status, newStatus: status },
    });
    return { issue: updated };
  },
};
