import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  LeadActivityAction,
  LeadStatus,
  MembershipStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { AuditInput, auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { subscriptionService } from "./subscription.service";
import { realtimeService } from "./realtime.service";
import { invalidateAiBusinessContext } from "./ai-context-builder.service";
import { CreateLeadInput, LeadListQuery, UpdateLeadInput } from "../validation/lead.schemas";

type LeadActor = {
  userId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

const leadInclude = {
  assignedStaff: {
    select: {
      id: true,
      role: true,
      status: true,
      user: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.LeadInclude;

function listKey(actor: LeadActor, query: LeadListQuery) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  const hash = crypto.createHash("sha256").update(JSON.stringify({ ...query, scope })).digest("hex");
  return `business:${actor.businessId}:leads:list:${hash}`;
}

function detailKey(businessId: string, leadId: string) {
  return `business:${businessId}:leads:detail:${leadId}`;
}

function countsKey(actor: LeadActor) {
  const scope = actor.role === BusinessRole.STAFF ? actor.membershipId : "all";
  return `business:${actor.businessId}:leads:counts:${scope}`;
}

function leadAccessWhere(actor: LeadActor): Prisma.LeadWhereInput {
  return {
    businessId: actor.businessId,
    deletedAt: null,
    ...(actor.role === BusinessRole.STAFF ? { assignedStaffId: actor.membershipId } : {}),
  };
}

async function validateAssignee(businessId: string, assignedStaffId: string | null | undefined) {
  if (!assignedStaffId) return;
  const member = await prisma.businessMember.findFirst({
    where: {
      id: assignedStaffId,
      businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER, BusinessRole.STAFF] },
    },
  });
  if (!member) throw new AppError(422, "Selected assignee is not an active member of this business.", "INVALID_LEAD_ASSIGNEE");
}

async function invalidateLeadCache(businessId: string, leadId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:leads:list:*`),
    cacheService.delByPattern(`business:${businessId}:leads:counts:*`),
    ...(leadId ? [cacheService.del(detailKey(businessId, leadId))] : []),
    invalidateAiBusinessContext(businessId),
  ]);
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function logAudit(
  actor: LeadActor,
  action: AuditAction,
  leadId: string,
  context: Omit<AuditInput, "action">,
  metadata?: Record<string, unknown>,
) {
  await auditService.log({
    ...context,
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    metadata: asJson({ leadId, ...metadata }),
  });
}

export const leadService = {
  async create(actor: LeadActor, input: CreateLeadInput, context: Omit<AuditInput, "action">) {
    const resolvedAssignedStaffId = input.assignedStaffId
      ?? (input.source === "MANUAL" ? actor.membershipId : null);
    await validateAssignee(actor.businessId, resolvedAssignedStaffId);
    if (await prisma.lead.findFirst({ where: { businessId: actor.businessId, phone: input.phone, deletedAt: null } })) {
      throw new AppError(409, "A lead with this phone number already exists for this business.", "DUPLICATE_LEAD");
    }

    const lead = await prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          businessId: actor.businessId,
          createdById: actor.userId,
          fullName: input.fullName,
          phone: input.phone,
          email: input.email,
          source: input.source,
          status: input.status,
          assignedStaffId: resolvedAssignedStaffId,
          notes: input.notes,
          tags: input.tags ?? [],
          customFields: input.customFields === null ? Prisma.DbNull : input.customFields as Prisma.InputJsonValue | undefined,
        },
        include: leadInclude,
      });
      await tx.leadActivity.create({
        data: {
          businessId: actor.businessId,
          leadId: created.id,
          actorUserId: actor.userId,
          action: LeadActivityAction.LEAD_CREATED,
          metadata: asJson({
            assignedStaffId: resolvedAssignedStaffId,
            source: created.source,
            createdById: actor.userId,
          }),
        },
      });
      return created;
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "A lead with this phone number already exists for this business.", "DUPLICATE_LEAD");
      }
      throw error;
    });
    await Promise.all([
      invalidateLeadCache(actor.businessId, lead.id),
      logAudit(actor, AuditAction.LEAD_CREATED, lead.id, context, {
        assignedStaffId: resolvedAssignedStaffId,
        source: lead.source,
        createdById: actor.userId,
      }),
      subscriptionService.updateBusinessUsage(actor.businessId, "leadsCreated", 1),
    ]);
    realtimeService.publish({
      type: "lead.created",
      businessId: actor.businessId,
      leadId: lead.id,
      assignedStaffId: lead.assignedStaffId,
      payload: { lead },
    });
    return lead;
  },

  async list(actor: LeadActor, query: LeadListQuery) {
    const key = listKey(actor, query);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;

    const where: Prisma.LeadWhereInput = {
      ...(query.search ? {
        OR: [
          { fullName: { contains: query.search, mode: "insensitive" } },
          { phone: { contains: query.search } },
          { email: { contains: query.search, mode: "insensitive" } },
        ],
      } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.assignedStaffId ? { assignedStaffId: query.assignedStaffId } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...((query.dateFrom || query.dateTo) ? {
        createdAt: { ...(query.dateFrom ? { gte: query.dateFrom } : {}), ...(query.dateTo ? { lte: query.dateTo } : {}) },
      } : {}),
      ...leadAccessWhere(actor),
    };
    const [data, total] = await prisma.$transaction([
      prisma.lead.findMany({
        where,
        include: leadInclude,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: { [query.sortBy]: query.sortOrder },
      }),
      prisma.lead.count({ where }),
    ]);
    const result = { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    await cacheService.set(key, result, 60);
    return result;
  },

  async detail(actor: LeadActor, leadId: string) {
    const key = detailKey(actor.businessId, leadId);
    const cached = await cacheService.get<Awaited<ReturnType<typeof loadDetail>>>(key);
    if (cached) {
      if (actor.role === BusinessRole.STAFF && cached.lead.assignedStaffId !== actor.membershipId) {
        throw new AppError(404, "Lead not found", "LEAD_NOT_FOUND");
      }
      return cached;
    }
    const result = await loadDetail(actor.businessId, leadId);
    if (!result || (actor.role === BusinessRole.STAFF && result.lead.assignedStaffId !== actor.membershipId)) {
      throw new AppError(404, "Lead not found", "LEAD_NOT_FOUND");
    }
    await cacheService.set(key, result, 120);
    return result;
  },

  async update(actor: LeadActor, leadId: string, input: UpdateLeadInput, context: Omit<AuditInput, "action">) {
    const existing = await prisma.lead.findFirst({ where: { id: leadId, ...leadAccessWhere(actor) } });
    if (!existing) throw new AppError(404, "Lead not found", "LEAD_NOT_FOUND");
    if (input.assignedStaffId !== undefined) {
      throw new AppError(422, "Use the lead assignment endpoint to change assignment.", "INVALID_ASSIGNMENT_UPDATE");
    }
    if (actor.role === BusinessRole.STAFF) {
      const disallowed = Object.keys(input).filter((key) => !["status", "notes"].includes(key));
      if (disallowed.length) throw new AppError(403, "Staff can only update status and notes for assigned leads", "FORBIDDEN");
    } else {
      await validateAssignee(actor.businessId, input.assignedStaffId);
    }
    if (input.phone && input.phone !== existing.phone && await prisma.lead.findFirst({
      where: { businessId: actor.businessId, phone: input.phone, deletedAt: null, id: { not: leadId } },
    })) {
      throw new AppError(409, "A lead with this phone number already exists for this business.", "DUPLICATE_LEAD");
    }

    const statusChanged = input.status !== undefined && input.status !== existing.status;
    const notesChanged = input.notes !== undefined && input.notes !== existing.notes;
    const assignmentChanged = input.assignedStaffId !== undefined && input.assignedStaffId !== existing.assignedStaffId;
    const updated = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.update({
        where: { id: leadId },
        data: {
          ...input,
          customFields: input.customFields === null ? Prisma.DbNull : input.customFields as Prisma.InputJsonValue | undefined,
          ...(statusChanged && input.status !== LeadStatus.NEW ? { lastContactedAt: new Date() } : {}),
        },
        include: leadInclude,
      });
      await tx.leadActivity.create({
        data: { businessId: actor.businessId, leadId, actorUserId: actor.userId, action: LeadActivityAction.LEAD_UPDATED, metadata: asJson({ fields: Object.keys(input) }) },
      });
      if (statusChanged) await tx.leadActivity.create({
        data: { businessId: actor.businessId, leadId, actorUserId: actor.userId, action: LeadActivityAction.LEAD_STATUS_CHANGED, metadata: asJson({ from: existing.status, to: input.status }) },
      });
      if (notesChanged) await tx.leadActivity.create({
        data: { businessId: actor.businessId, leadId, actorUserId: actor.userId, action: LeadActivityAction.LEAD_NOTE_UPDATED },
      });
      if (assignmentChanged) await tx.leadActivity.create({
        data: { businessId: actor.businessId, leadId, actorUserId: actor.userId, action: LeadActivityAction.LEAD_ASSIGNED, metadata: asJson({ from: existing.assignedStaffId, to: input.assignedStaffId }) },
      });
      return lead;
    });
    await invalidateLeadCache(actor.businessId, leadId);
    await Promise.all([
      logAudit(actor, AuditAction.LEAD_UPDATED, leadId, context, { fields: Object.keys(input) }),
      ...(statusChanged ? [logAudit(actor, AuditAction.LEAD_STATUS_CHANGED, leadId, context, { from: existing.status, to: input.status })] : []),
      ...(assignmentChanged ? [logAudit(actor, AuditAction.LEAD_ASSIGNED, leadId, context, { from: existing.assignedStaffId, to: input.assignedStaffId })] : []),
    ]);
    realtimeService.publish({
      type: "lead.updated",
      businessId: actor.businessId,
      leadId,
      assignedStaffId: updated.assignedStaffId,
      payload: { lead: updated, changes: input },
    });
    return updated;
  },

  async assign(actor: LeadActor, leadId: string, assignedStaffId: string | null, context: Omit<AuditInput, "action">) {
    if (actor.role === BusinessRole.STAFF) {
      throw new AppError(403, "You do not have permission to assign or reassign leads.", "FORBIDDEN");
    }
    const existing = await prisma.lead.findFirst({ where: { id: leadId, businessId: actor.businessId, deletedAt: null } });
    if (!existing) throw new AppError(404, "Lead not found", "LEAD_NOT_FOUND");
    await validateAssignee(actor.businessId, assignedStaffId);
    if (existing.assignedStaffId === assignedStaffId) {
      return prisma.lead.findUniqueOrThrow({ where: { id: leadId }, include: leadInclude });
    }
    const assignmentMetadata = {
      previousAssignedStaffId: existing.assignedStaffId,
      newAssignedStaffId: assignedStaffId,
      assignedByUserId: actor.userId,
      assignedByMembershipId: actor.membershipId,
      reason: "manual_reassignment",
    };
    const updated = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.update({
        where: { id: leadId },
        data: { assignedStaffId },
        include: leadInclude,
      });
      await tx.leadActivity.create({
        data: {
          businessId: actor.businessId,
          leadId,
          actorUserId: actor.userId,
          action: LeadActivityAction.LEAD_ASSIGNED,
          metadata: asJson(assignmentMetadata),
        },
      });
      return lead;
    });
    await invalidateLeadCache(actor.businessId, leadId);
    await logAudit(actor, AuditAction.LEAD_ASSIGNED, leadId, context, {
      ...assignmentMetadata,
      businessId: actor.businessId,
    });
    realtimeService.publish({
      type: "lead.updated",
      businessId: actor.businessId,
      leadId,
      assignedStaffId: updated.assignedStaffId,
      staffMembershipIds: [existing.assignedStaffId, updated.assignedStaffId],
      payload: { lead: updated, changes: assignmentMetadata },
    });
    return updated;
  },

  async updateStatus(actor: LeadActor, leadId: string, status: LeadStatus, context: Omit<AuditInput, "action">) {
    return this.update(actor, leadId, { status }, context);
  },

  async remove(actor: LeadActor, leadId: string, context: Omit<AuditInput, "action">) {
    if (actor.role === BusinessRole.STAFF) throw new AppError(403, "Staff cannot delete leads", "FORBIDDEN");
    const existing = await prisma.lead.findFirst({ where: { id: leadId, businessId: actor.businessId, deletedAt: null } });
    if (!existing) throw new AppError(404, "Lead not found", "LEAD_NOT_FOUND");
    await prisma.$transaction([
      prisma.lead.update({ where: { id: leadId }, data: { deletedAt: new Date() } }),
      prisma.leadActivity.create({ data: { businessId: actor.businessId, leadId, actorUserId: actor.userId, action: LeadActivityAction.LEAD_DELETED } }),
    ]);
    await Promise.all([invalidateLeadCache(actor.businessId, leadId), logAudit(actor, AuditAction.LEAD_DELETED, leadId, context)]);
    return { message: "Lead deleted successfully" };
  },

  async stats(actor: LeadActor) {
    const key = countsKey(actor);
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const grouped = await prisma.lead.groupBy({
      by: ["status"],
      where: leadAccessWhere(actor),
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(Object.values(LeadStatus).map((status) => [status, 0])) as Record<LeadStatus, number>;
    for (const group of grouped) byStatus[group.status] = group._count._all;
    const result = { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
    await cacheService.set(key, result, 60);
    return result;
  },
};

async function loadDetail(businessId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId, deletedAt: null }, include: leadInclude });
  if (!lead) return null;
  const activities = await prisma.leadActivity.findMany({
    where: { businessId, leadId },
    orderBy: { createdAt: "desc" },
    include: { actor: { select: { id: true, firstName: true, lastName: true } } },
  });
  return { lead, activities };
}
