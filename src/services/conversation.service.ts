import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  ConversationChannel,
  ConversationPriority,
  ConversationStatus,
  LeadActivityAction,
  MembershipStatus,
  MessageSenderType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { ConversationDetailQuery, ConversationListQuery, CreateConversationInput } from "../validation/conversation.schemas";
import { AuditInput, auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { ConversationActor, createSystemMessage } from "./message.service";
import { subscriptionService } from "./subscription.service";
import { realtimeService } from "./realtime.service";
import { invalidateAiBusinessContext } from "./ai-context-builder.service";

const conversationInclude = {
  lead: { select: { id: true, fullName: true, phone: true, email: true, status: true } },
  assignedStaff: {
    select: {
      id: true,
      role: true,
      status: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
} satisfies Prisma.ConversationInclude;

function accessWhere(actor: ConversationActor): Prisma.ConversationWhereInput {
  return {
    businessId: actor.businessId,
    deletedAt: null,
    ...(actor.role === BusinessRole.STAFF ? { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] } : {}),
  };
}

function listKey(actor: ConversationActor, query: ConversationListQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  const hash = crypto.createHash("sha256").update(JSON.stringify({ ...query, scope })).digest("hex");
  return `business:${actor.businessId}:conversations:list:${hash}`;
}

function detailKey(actor: ConversationActor, conversationId: string, query: ConversationDetailQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  const page = crypto.createHash("sha256").update(JSON.stringify({ ...query, scope })).digest("hex").slice(0, 16);
  return `business:${actor.businessId}:conversations:detail:${conversationId}:${page}`;
}

function statsKey(actor: ConversationActor) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  return `business:${actor.businessId}:conversations:stats:${scope}`;
}

function unreadKey(actor: ConversationActor) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  return `business:${actor.businessId}:conversations:unread:${scope}`;
}

export async function invalidateConversationCache(businessId: string, conversationId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:stats:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:unread:*`),
    ...(conversationId ? [cacheService.delByPattern(`business:${businessId}:conversations:detail:${conversationId}:*`)] : []),
    invalidateAiBusinessContext(businessId, conversationId),
  ]);
}

async function validateAssignee(businessId: string, assignedStaffId: string | null | undefined) {
  if (!assignedStaffId) return null;
  const member = await prisma.businessMember.findFirst({
    where: {
      id: assignedStaffId,
      businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER, BusinessRole.STAFF] },
    },
    include: { user: { select: { firstName: true, lastName: true } } },
  });
  if (!member) throw new AppError(422, "This team member cannot receive assigned work.", "INVALID_ASSIGNMENT_TARGET");
  return member;
}

async function logAudit(actor: ConversationActor, action: AuditAction, conversationId: string, leadId: string, context: Omit<AuditInput, "action">, metadata?: Record<string, unknown>) {
  await auditService.log({
    ...context,
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: { conversationId, leadId, ...metadata } as Prisma.InputJsonValue,
  });
}

export const conversationService = {
  async create(actor: ConversationActor, input: CreateConversationInput, context: Omit<AuditInput, "action">) {
    const lead = await prisma.lead.findFirst({ where: { id: input.leadId, businessId: actor.businessId, deletedAt: null } });
    if (!lead) throw new AppError(404, "Lead not found", "LEAD_NOT_FOUND");
    if (actor.role === BusinessRole.STAFF && lead.assignedStaffId !== actor.membershipId) {
      throw new AppError(403, "Staff can only create conversations for assigned leads", "FORBIDDEN");
    }
    const assignedStaffId = actor.role === BusinessRole.STAFF ? actor.membershipId : input.assignedStaffId;
    await validateAssignee(actor.businessId, assignedStaffId);
    const existing = await prisma.conversation.findFirst({
      where: { businessId: actor.businessId, leadId: input.leadId, channel: input.channel, status: { not: ConversationStatus.CLOSED }, deletedAt: null },
    });
    if (existing) throw new AppError(409, "An active conversation already exists for this lead and channel", "CONVERSATION_ALREADY_EXISTS", { conversationId: existing.id });

    const conversation = await prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          businessId: actor.businessId,
          leadId: input.leadId,
          assignedStaffId,
          channel: input.channel,
          subject: input.subject,
          priority: input.priority,
        },
        include: conversationInclude,
      });
      await tx.leadActivity.create({
        data: {
          businessId: actor.businessId,
          leadId: input.leadId,
          actorUserId: actor.userId,
          action: LeadActivityAction.CONVERSATION_CREATED,
          metadata: { conversationId: created.id, channel: created.channel },
        },
      });
      return created;
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "An active conversation already exists for this lead and channel", "CONVERSATION_ALREADY_EXISTS");
      }
      throw error;
    });

    await Promise.all([
      invalidateConversationCache(actor.businessId, conversation.id),
      logAudit(actor, AuditAction.CONVERSATION_CREATED, conversation.id, conversation.leadId, context, { channel: conversation.channel }),
      subscriptionService.updateAccountUsage(actor.businessAccountId, "conversationsUsed", 1, actor.businessId),
      subscriptionService.updateBusinessUsage(actor.businessId, "conversationsUsed", 1),
    ]);
    realtimeService.publish({
      type: "conversation.created",
      businessId: actor.businessId,
      conversationId: conversation.id,
      leadId: conversation.leadId,
      assignedStaffId: conversation.assignedStaffId,
      payload: { conversation },
    });
    return conversation;
  },

  async list(actor: ConversationActor, query: ConversationListQuery) {
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const where: Prisma.ConversationWhereInput = {
      ...accessWhere(actor),
      ...(query.search ? {
        OR: [
          { subject: { contains: query.search, mode: "insensitive" } },
          { lastMessagePreview: { contains: query.search, mode: "insensitive" } },
          { lead: { fullName: { contains: query.search, mode: "insensitive" } } },
          { lead: { phone: { contains: query.search } } },
          { lead: { email: { contains: query.search, mode: "insensitive" } } },
        ],
      } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.pinned !== undefined ? { pinned: query.pinned } : {}),
      ...(query.assignedStaffId ? { assignedStaffId: query.assignedStaffId } : {}),
      ...(query.leadId ? { leadId: query.leadId } : {}),
      ...((query.dateFrom || query.dateTo) ? {
        createdAt: { ...(query.dateFrom ? { gte: query.dateFrom } : {}), ...(query.dateTo ? { lte: query.dateTo } : {}) },
      } : {}),
    };
    const [data, total] = await prisma.$transaction([
      prisma.conversation.findMany({
        where,
        include: conversationInclude,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: { [query.sortBy]: query.sortOrder },
      }),
      prisma.conversation.count({ where }),
    ]);
    const result = { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    await cacheService.set(key, result, 30);
    return result;
  },

  async detail(actor: ConversationActor, conversationId: string, query: ConversationDetailQuery) {
    const key = detailKey(actor, conversationId, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, ...accessWhere(actor) }, include: conversationInclude });
    if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");

    let before: { createdAt: Date } | null = null;
    if (query.beforeMessageId) {
      before = await prisma.message.findFirst({
        where: { id: query.beforeMessageId, businessId: actor.businessId, conversationId, deletedAt: null },
        select: { createdAt: true },
      });
      if (!before) throw new AppError(404, "Message cursor not found", "MESSAGE_NOT_FOUND");
    }
    const rows = await prisma.message.findMany({
      where: {
        businessId: actor.businessId,
        conversationId,
        deletedAt: null,
        ...(before ? { createdAt: { lt: before.createdAt } } : {}),
      },
      include: { senderUser: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
      take: query.messageLimit + 1,
    });
    const hasMore = rows.length > query.messageLimit;
    const page = rows.slice(0, query.messageLimit).reverse();
    const activities = await prisma.leadActivity.findMany({
      where: {
        businessId: actor.businessId,
        leadId: conversation.leadId,
        metadata: { path: ["conversationId"], equals: conversationId },
      },
      include: { actor: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const result = {
      conversation,
      lead: conversation.lead,
      assignedStaff: conversation.assignedStaff,
      messages: page,
      activities,
      messagePagination: {
        limit: query.messageLimit,
        hasMore,
        nextBeforeMessageId: hasMore ? page[0]?.id ?? null : null,
      },
    };
    await cacheService.set(key, result, 30);
    return result;
  },

  async assign(actor: ConversationActor, conversationId: string, assignedStaffId: string | null, context: Omit<AuditInput, "action">) {
    if (actor.role === BusinessRole.STAFF) {
      if (assignedStaffId !== actor.membershipId) {
        await auditService.log({
          ...context,
          action: AuditAction.WORK_ASSIGNMENT_BLOCKED,
          businessId: actor.businessId,
          userId: actor.userId,
          actorMembershipId: actor.membershipId,
          metadata: { conversationId, recordType: "CONVERSATION", recordId: conversationId, reason: "staff_assignment_target_not_self" } as Prisma.InputJsonValue,
        });
        throw new AppError(403, "You do not have permission to reassign this conversation.", "CANNOT_REASSIGN_WITHOUT_PERMISSION");
      }
      return this.claim(actor, conversationId, context);
    }
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, businessId: actor.businessId, deletedAt: null } });
    if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    const assignee = await validateAssignee(actor.businessId, assignedStaffId);
    const label = assignee ? `${assignee.user.firstName} ${assignee.user.lastName}` : "Unassigned";
    let systemMessageId: string | undefined;
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.conversation.update({ where: { id: conversationId }, data: { assignedStaffId }, include: conversationInclude });
      const systemMessage = await createSystemMessage({ businessId: actor.businessId, leadId: conversation.leadId, conversationId, content: `Conversation assigned to ${label}.`, metadata: { assignedStaffId } }, tx);
      systemMessageId = systemMessage.id;
      await tx.leadActivity.create({
        data: { businessId: actor.businessId, leadId: conversation.leadId, actorUserId: actor.userId, action: LeadActivityAction.CONVERSATION_ASSIGNED, metadata: { conversationId, assignedStaffId } },
      });
      return record;
    }, { maxWait: 15_000, timeout: 30_000 });
    await Promise.all([
      invalidateConversationCache(actor.businessId, conversationId),
      logAudit(actor, AuditAction.CONVERSATION_ASSIGNED, conversationId, conversation.leadId, context, { assignedStaffId }),
    ]);
    realtimeService.publish({
      type: "conversation.assigned",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId,
      staffMembershipIds: [conversation.assignedStaffId, assignedStaffId],
      payload: {
        conversationId,
        previousAssignedStaffId: conversation.assignedStaffId,
        newAssignedStaffId: assignedStaffId,
        assignedByUserId: actor.userId,
      },
    });
    realtimeService.publish({
      type: "conversation.updated",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId,
      staffMembershipIds: [conversation.assignedStaffId, assignedStaffId],
      payload: { conversationId, changes: { assignedStaffId } },
    });
    realtimeService.publish({
      type: "message.created",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      messageId: systemMessageId,
      assignedStaffId,
      staffMembershipIds: [conversation.assignedStaffId, assignedStaffId],
      payload: { messageId: systemMessageId, senderType: "SYSTEM", conversationId, leadId: conversation.leadId },
    });
    return updated;
  },

  async claim(actor: ConversationActor, conversationId: string, context: Omit<AuditInput, "action">) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, businessId: actor.businessId, deletedAt: null } });
    if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    if (conversation.assignedStaffId && conversation.assignedStaffId !== actor.membershipId) {
      await logAudit(actor, AuditAction.WORK_ASSIGNMENT_BLOCKED, conversationId, conversation.leadId, context, {
        recordType: "CONVERSATION",
        recordId: conversationId,
        previousAssignedStaffId: conversation.assignedStaffId,
        attemptedAssignedStaffId: actor.membershipId,
      });
      throw new AppError(409, "This conversation is already assigned to another team member.", "WORK_ALREADY_ASSIGNED");
    }
    if (conversation.assignedStaffId === actor.membershipId) {
      return prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: conversationInclude });
    }
    await validateAssignee(actor.businessId, actor.membershipId);
    let systemMessageId: string | undefined;
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.conversation.update({
        where: { id: conversationId },
        data: {
          assignedStaffId: actor.membershipId,
          ...(conversation.status !== ConversationStatus.CLOSED ? { status: ConversationStatus.HUMAN_HANDLING, humanTakeover: true, aiEnabled: false, needsHumanReview: false } : {}),
        },
        include: conversationInclude,
      });
      const user = await tx.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true } });
      const name = user ? `${user.firstName} ${user.lastName}`.trim() : "A team member";
      const systemMessage = await createSystemMessage({
        businessId: actor.businessId,
        leadId: conversation.leadId,
        conversationId,
        content: `${name} claimed this conversation.`,
        metadata: { assignedStaffId: actor.membershipId, reason: "CLAIM_UNASSIGNED_WORK" },
      }, tx);
      systemMessageId = systemMessage.id;
      await tx.leadActivity.create({
        data: {
          businessId: actor.businessId,
          leadId: conversation.leadId,
          actorUserId: actor.userId,
          action: LeadActivityAction.CONVERSATION_ASSIGNED,
          metadata: { conversationId, previousAssignedStaffId: null, newAssignedStaffId: actor.membershipId, reason: "CLAIM_UNASSIGNED_WORK" },
        },
      });
      return record;
    }, { maxWait: 15_000, timeout: 30_000 });
    await Promise.all([
      invalidateConversationCache(actor.businessId, conversationId),
      logAudit(actor, AuditAction.CONVERSATION_CLAIMED_BY_STAFF, conversationId, conversation.leadId, context, {
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        targetMembershipId: actor.membershipId,
        recordType: "CONVERSATION",
        recordId: conversationId,
        previousAssignedStaffId: null,
        newAssignedStaffId: actor.membershipId,
        reason: "CLAIM_UNASSIGNED_WORK",
      }),
    ]);
    realtimeService.publish({
      type: "business.conversation.claimed",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      staffMembershipIds: [updated.assignedStaffId],
      payload: { conversation: updated, previousAssignedStaffId: null, newAssignedStaffId: updated.assignedStaffId, systemMessageId },
    });
    realtimeService.publish({
      type: "conversation.updated",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      staffMembershipIds: [updated.assignedStaffId],
      payload: { conversationId, changes: { assignedStaffId: updated.assignedStaffId, status: updated.status, humanTakeover: updated.humanTakeover, aiEnabled: updated.aiEnabled } },
    });
    if (systemMessageId) {
      realtimeService.publish({
        type: "message.created",
        businessId: actor.businessId,
        conversationId,
        leadId: conversation.leadId,
        messageId: systemMessageId,
        assignedStaffId: updated.assignedStaffId,
        staffMembershipIds: [updated.assignedStaffId],
        payload: { messageId: systemMessageId, senderType: "SYSTEM", conversationId, leadId: conversation.leadId },
      });
    }
    return updated;
  },

  async updateWorkspace(
    actor: ConversationActor,
    conversationId: string,
    input: { subject?: string | null; priority?: ConversationPriority; pinned?: boolean },
  ) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, ...accessWhere(actor) } });
    if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    if (actor.role === BusinessRole.STAFF && Object.keys(input).some((field) => field !== "pinned")) {
      throw new AppError(403, "Staff can only pin assigned conversations", "FORBIDDEN");
    }
    const updated = await prisma.conversation.update({ where: { id: conversationId }, data: input, include: conversationInclude });
    await invalidateConversationCache(actor.businessId, conversationId);
    realtimeService.publish({
      type: "conversation.updated",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      payload: { conversationId, changes: input },
    });
    return updated;
  },

  async updateStatus(actor: ConversationActor, conversationId: string, status: ConversationStatus, context: Omit<AuditInput, "action">) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, ...accessWhere(actor) } });
    if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    if (conversation.status === status) return conversation;
    let systemMessageId: string | undefined;
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.conversation.update({
        where: { id: conversationId },
        data: {
          status,
          closedAt: status === ConversationStatus.CLOSED ? new Date() : null,
          ...(status === ConversationStatus.NEEDS_HUMAN_REVIEW ? {
            aiEnabled: false,
            humanTakeover: false,
            needsHumanReview: true,
            humanReviewReason: conversation.humanReviewReason ?? "Conversation manually moved to human review.",
            humanReviewCreatedAt: conversation.needsHumanReview ? undefined : new Date(),
            humanReviewResolvedAt: null,
            humanReviewResolvedByMembershipId: null,
          } : {}),
          ...(status === ConversationStatus.HUMAN_HANDLING ? {
            aiEnabled: false,
            humanTakeover: true,
            needsHumanReview: false,
            humanReviewResolvedAt: new Date(),
            humanReviewResolvedByMembershipId: actor.membershipId,
          } : {}),
          ...(status === ConversationStatus.AI_HANDLING ? {
            aiEnabled: true,
            humanTakeover: false,
            needsHumanReview: false,
            humanReviewResolvedAt: new Date(),
            humanReviewResolvedByMembershipId: actor.membershipId,
          } : {}),
          ...(status === ConversationStatus.OPEN ? { humanTakeover: false } : {}),
        },
        include: conversationInclude,
      });
      const systemMessage = await createSystemMessage({
        businessId: actor.businessId,
        leadId: conversation.leadId,
        conversationId,
        content: `Conversation status changed from ${conversation.status} to ${status}.`,
        metadata: { from: conversation.status, to: status },
      }, tx);
      systemMessageId = systemMessage.id;
      await tx.leadActivity.create({
        data: { businessId: actor.businessId, leadId: conversation.leadId, actorUserId: actor.userId, action: LeadActivityAction.CONVERSATION_STATUS_CHANGED, metadata: { conversationId, from: conversation.status, to: status } },
      });
      return record;
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "Another active conversation already exists for this lead and channel", "CONVERSATION_ALREADY_EXISTS");
      }
      throw error;
    });
    await Promise.all([
      invalidateConversationCache(actor.businessId, conversationId),
      logAudit(actor, AuditAction.CONVERSATION_STATUS_CHANGED, conversationId, conversation.leadId, context, { from: conversation.status, to: status }),
    ]);
    realtimeService.publish({
      type: "conversation.updated",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      payload: { conversationId, changes: { status: updated.status, closedAt: updated.closedAt, aiEnabled: updated.aiEnabled, humanTakeover: updated.humanTakeover, needsHumanReview: updated.needsHumanReview } },
    });
    realtimeService.publish({
      type: "message.created",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      messageId: systemMessageId,
      assignedStaffId: updated.assignedStaffId,
      payload: { messageId: systemMessageId, senderType: "SYSTEM", conversationId, leadId: conversation.leadId },
    });
    return updated;
  },

  async end(actor: ConversationActor, conversationId: string, context: Omit<AuditInput, "action">) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, ...accessWhere(actor) } });
    if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    if (conversation.status === ConversationStatus.CLOSED) {
      throw new AppError(409, "Conversation is already closed.", "CONVERSATION_ALREADY_CLOSED");
    }
    const user = await prisma.user.findUnique({
      where: { id: actor.userId },
      select: { firstName: true, lastName: true },
    });
    const staffName = user ? `${user.firstName} ${user.lastName}`.trim() : "a team member";
    let systemMessageId: string | undefined;
    const updated = await prisma.$transaction(async (tx) => {
      const record = await tx.conversation.update({
        where: { id: conversationId },
        data: {
          status: ConversationStatus.CLOSED,
          closedAt: new Date(),
          aiEnabled: false,
          humanTakeover: false,
        },
        include: conversationInclude,
      });
      const systemMessage = await createSystemMessage({
        businessId: actor.businessId,
        leadId: conversation.leadId,
        conversationId,
        content: `Conversation ended by ${staffName}.`,
        metadata: { endedByUserId: actor.userId, endedByMembershipId: actor.membershipId },
      }, tx);
      systemMessageId = systemMessage.id;
      await tx.leadActivity.create({
        data: {
          businessId: actor.businessId,
          leadId: conversation.leadId,
          actorUserId: actor.userId,
          action: LeadActivityAction.CONVERSATION_ENDED,
          metadata: { conversationId, previousStatus: conversation.status, newStatus: ConversationStatus.CLOSED },
        },
      });
      return record;
    }, { maxWait: 15_000, timeout: 30_000 });
    await Promise.all([
      invalidateConversationCache(actor.businessId, conversationId),
      cacheService.delByPattern(`business:${actor.businessId}:leads:detail:${conversation.leadId}*`),
      logAudit(actor, AuditAction.CONVERSATION_ENDED, conversationId, conversation.leadId, context, {
        previousStatus: conversation.status,
        newStatus: ConversationStatus.CLOSED,
      }),
    ]);
    realtimeService.publish({
      type: "conversation.closed",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      payload: { conversationId, status: updated.status, closedAt: updated.closedAt, closedByUserId: actor.userId, systemMessageId },
    });
    realtimeService.publish({
      type: "message.created",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      messageId: systemMessageId,
      assignedStaffId: updated.assignedStaffId,
      payload: { messageId: systemMessageId, senderType: "SYSTEM", conversationId, leadId: conversation.leadId },
    });
    realtimeService.publish({
      type: "conversation.updated",
      businessId: actor.businessId,
      conversationId,
      leadId: conversation.leadId,
      assignedStaffId: updated.assignedStaffId,
      payload: { conversationId, changes: { status: updated.status, closedAt: updated.closedAt, aiEnabled: false, humanTakeover: false } },
    });
    return updated;
  },

  async markRead(actor: ConversationActor, conversationId: string, context: Omit<AuditInput, "action">) {
    try {
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, ...accessWhere(actor) } });
      if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        await tx.message.updateMany({
          where: { businessId: actor.businessId, conversationId, senderType: MessageSenderType.CUSTOMER, readAt: null, deletedAt: null },
          data: { readAt: now, deliveryStatus: "READ" },
        });
        const record = await tx.conversation.update({ where: { id: conversationId }, data: { unreadCount: 0 }, include: conversationInclude });
        await tx.leadActivity.create({
          data: { businessId: actor.businessId, leadId: conversation.leadId, actorUserId: actor.userId, action: LeadActivityAction.CONVERSATION_MARKED_READ, metadata: { conversationId } },
        });
        return record;
      });
      await Promise.all([
        invalidateConversationCache(actor.businessId, conversationId),
        logAudit(actor, AuditAction.CONVERSATION_MARKED_READ, conversationId, conversation.leadId, context),
      ]);
      realtimeService.publish({
        type: "conversation.read",
        businessId: actor.businessId,
        conversationId,
        leadId: conversation.leadId,
        assignedStaffId: updated.assignedStaffId,
        payload: { conversationId, readByUserId: actor.userId, unreadCount: 0, readAt: now.toISOString() },
      });
      realtimeService.publish({
        type: "conversation.updated",
        businessId: actor.businessId,
        conversationId,
        leadId: conversation.leadId,
        assignedStaffId: updated.assignedStaffId,
        payload: { conversationId, changes: { unreadCount: 0 } },
      });
      return updated;
    } catch (error) {
      await auditService.log({ ...context, action: AuditAction.CONVERSATION_READ_FAILED, businessId: actor.businessId, userId: actor.userId, metadata: { conversationId } });
      throw error;
    }
  },

  async remove(actor: ConversationActor, conversationId: string, context: Omit<AuditInput, "action">) {
    if (actor.role === BusinessRole.STAFF) throw new AppError(403, "Staff cannot delete conversations", "FORBIDDEN");
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, businessId: actor.businessId, deletedAt: null } });
    if (!conversation) throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    await prisma.$transaction([
      prisma.conversation.update({ where: { id: conversationId }, data: { deletedAt: new Date() } }),
      prisma.leadActivity.create({
        data: { businessId: actor.businessId, leadId: conversation.leadId, actorUserId: actor.userId, action: LeadActivityAction.CONVERSATION_DELETED, metadata: { conversationId } },
      }),
    ]);
    await Promise.all([
      invalidateConversationCache(actor.businessId, conversationId),
      logAudit(actor, AuditAction.CONVERSATION_DELETED, conversationId, conversation.leadId, context),
    ]);
    return { message: "Conversation deleted successfully" };
  },

  async stats(actor: ConversationActor) {
    const key = statsKey(actor);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const where = accessWhere(actor);
    const [grouped, unread] = await Promise.all([
      prisma.conversation.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.conversation.count({ where: { ...where, unreadCount: { gt: 0 } } }),
    ]);
    const counts = Object.fromEntries(Object.values(ConversationStatus).map((status) => [status, 0])) as Record<ConversationStatus, number>;
    for (const group of grouped) counts[group.status] = group._count._all;
    const result = {
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      open: counts.OPEN,
      aiHandling: counts.AI_HANDLING,
      humanHandling: counts.HUMAN_HANDLING,
      closed: counts.CLOSED,
      unread,
    };
    await Promise.all([cacheService.set(key, result, 60), cacheService.set(unreadKey(actor), { unread }, 30)]);
    return result;
  },
};
