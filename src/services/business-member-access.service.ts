import {
  AppointmentActivityType,
  AppointmentHumanConfirmationReason,
  AppointmentStatus,
  AuditAction,
  BusinessNotificationStatus,
  BusinessRole,
  ConversationStatus,
  LeadActivityAction,
  MembershipStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { AuditInput, auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { createSystemMessage } from "./message.service";
import { permissionFlags } from "./permission.service";
import { realtimeService } from "./realtime.service";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./subscription.service";

type MemberActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type MutationInput = {
  businessId: string;
  targetMembershipId: string;
  actorMembershipId: string;
  reason?: string | null;
};

const assignableRoles = [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER, BusinessRole.STAFF];

const terminalAppointmentStatuses = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.MISSED,
];

const unresolvedNotificationStatuses = [
  BusinessNotificationStatus.UNREAD,
  BusinessNotificationStatus.READ,
];

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function requireTeamManager(actor: MemberActor) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER) {
    throw new AppError(403, "You do not have permission to manage staff access.", "FORBIDDEN");
  }
}

function canReceiveAssignedWork(member: { role: BusinessRole; status: MembershipStatus }) {
  return member.status === MembershipStatus.ACTIVE && assignableRoles.includes(member.role);
}

function staffLimitError(allowedActiveMembers: number, currentActiveMembers: number) {
  throw new AppError(403, "Your current plan does not allow more active staff members. Upgrade your plan or disable another staff member.", "STAFF_LIMIT_EXCEEDED", {
    allowedActiveMembers,
    currentActiveMembers,
  });
}

async function invalidateMemberCaches(businessId: string, targetUserId?: string, targetMembershipId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:members:*`),
    cacheService.delByPattern(`business:${businessId}:team:*`),
    cacheService.delByPattern(`business:${businessId}:notifications:list:*`),
    cacheService.delByPattern(`business:${businessId}:notifications:counts:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:detail:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:stats:*`),
    cacheService.delByPattern(`business:${businessId}:appointments:*`),
    cacheService.delByPattern(`business:${businessId}:leads:list:*`),
    cacheService.delByPattern(`business:${businessId}:leads:detail:*`),
    cacheService.delByPattern(`business:${businessId}:leads:counts:*`),
    ...(targetUserId ? [cacheService.delByPattern(`user:${targetUserId}:business-memberships*`)] : []),
    ...(targetUserId && targetMembershipId ? [cacheService.delByPattern(`user:${targetUserId}:active-business:${businessId}*`)] : []),
  ]);
}

async function loadTarget(tx: Prisma.TransactionClient, businessId: string, targetMembershipId: string) {
  const target = await tx.businessMember.findFirst({
    where: { id: targetMembershipId, businessId },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true } }, business: { select: { id: true, businessAccountId: true } } },
  });
  if (!target) throw new AppError(404, "Business member not found.", "BUSINESS_MEMBER_NOT_FOUND");
  return target;
}

async function currentPlanLimit(tx: Prisma.TransactionClient, businessAccountId: string) {
  const subscription = await tx.subscription.findFirst({
    where: { businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  return subscription.plan.maxStaff;
}

async function activeMemberCount(tx: Prisma.TransactionClient, businessId: string) {
  return tx.businessMember.count({ where: { businessId, status: MembershipStatus.ACTIVE } });
}

async function assertCanRestore(tx: Prisma.TransactionClient, businessId: string, businessAccountId: string) {
  const limit = await currentPlanLimit(tx, businessAccountId);
  if (limit === null) return;
  const activeCount = await activeMemberCount(tx, businessId);
  if (activeCount >= limit) staffLimitError(limit, activeCount);
}

async function adjustStaffUsage(tx: Prisma.TransactionClient, businessAccountId: string, delta: number) {
  if (delta === 0) return;
  const subscription = await tx.subscription.findFirst({
    where: { businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: { usageRecords: { orderBy: { periodStart: "desc" }, take: 1 } },
  });
  const usage = subscription?.usageRecords[0];
  if (!usage) return;
  await tx.accountUsageRecord.update({
    where: { id: usage.id },
    data: { staffCount: delta > 0 ? { increment: delta } : Math.max(0, usage.staffCount + delta) },
  });
}

function assertTargetCanChange(actor: MemberActor, target: { id: string; role: BusinessRole }, action: "disable" | "remove" | "restore") {
  if (target.id === actor.membershipId) {
    throw new AppError(403, "Staff cannot remove or disable themselves. Contact your organization.", "STAFF_CANNOT_REMOVE_SELF");
  }
  if (target.role === BusinessRole.BUSINESS_OWNER && action === "disable") {
    throw new AppError(403, "Business owners cannot be disabled.", "CANNOT_DISABLE_BUSINESS_OWNER");
  }
  if (target.role === BusinessRole.BUSINESS_OWNER && action === "remove") {
    throw new AppError(403, "Business owners cannot be removed.", "CANNOT_REMOVE_BUSINESS_OWNER");
  }
}

async function cleanupAssignedRecords(tx: Prisma.TransactionClient, actor: MemberActor, targetMembershipId: string, reason: string) {
  const now = new Date();
  const leads = await tx.lead.findMany({
    where: { businessId: actor.businessId, assignedStaffId: targetMembershipId, deletedAt: null },
    select: { id: true },
  });
  if (leads.length > 0) {
    await tx.lead.updateMany({
      where: { id: { in: leads.map((lead) => lead.id) } },
      data: { assignedStaffId: null },
    });
    await tx.leadActivity.createMany({
      data: leads.map((lead) => ({
        businessId: actor.businessId,
        leadId: lead.id,
        actorUserId: actor.userId,
        action: LeadActivityAction.LEAD_ASSIGNED,
        metadata: json({ previousAssignedStaffId: targetMembershipId, newAssignedStaffId: null, reason }),
      })),
    });
  }

  const conversations = await tx.conversation.findMany({
    where: { businessId: actor.businessId, assignedStaffId: targetMembershipId, deletedAt: null, status: { not: ConversationStatus.CLOSED } },
    select: { id: true, leadId: true, status: true },
  });
  for (const conversation of conversations) {
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        assignedStaffId: null,
        ...(conversation.status === ConversationStatus.HUMAN_HANDLING
          ? { status: ConversationStatus.NEEDS_HUMAN_REVIEW, needsHumanReview: true, humanTakeover: false, aiEnabled: false }
          : {}),
      },
    });
    await createSystemMessage({
      businessId: actor.businessId,
      leadId: conversation.leadId,
      conversationId: conversation.id,
      content: "Assigned staff is no longer active. Conversation is now unassigned for owner or manager review.",
      metadata: json({ previousAssignedStaffId: targetMembershipId, reason }),
    }, tx);
  }

  const appointments = await tx.appointment.findMany({
    where: {
      businessId: actor.businessId,
      assignedStaffId: targetMembershipId,
      endTime: { gt: now },
      status: { notIn: terminalAppointmentStatuses },
    },
    select: { id: true, status: true },
  });
  for (const appointment of appointments) {
    const needsConfirmation = appointment.status === AppointmentStatus.CONFIRMED;
    await tx.appointment.update({
      where: { id: appointment.id },
      data: {
        assignedStaffId: null,
        ...(needsConfirmation
          ? {
            status: AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
            humanConfirmationRequired: true,
            humanConfirmationReason: AppointmentHumanConfirmationReason.STAFF_REQUIRED,
          }
          : {}),
      },
    });
    await tx.appointmentActivity.create({
      data: {
        businessId: actor.businessId,
        appointmentId: appointment.id,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        type: AppointmentActivityType.APPOINTMENT_STAFF_ASSIGNED,
        message: "Assigned staff is no longer active. Appointment is now unassigned.",
        metadata: json({
          previousAssignedStaffId: targetMembershipId,
          newAssignedStaffId: null,
          reason,
          statusChangedTo: needsConfirmation ? AppointmentStatus.NEEDS_HUMAN_CONFIRMATION : null,
        }),
      },
    });
  }

  const notificationResult = await tx.businessNotification.updateMany({
    where: {
      businessId: actor.businessId,
      recipientMembershipId: targetMembershipId,
      status: { in: unresolvedNotificationStatuses },
    },
    data: { status: BusinessNotificationStatus.DISMISSED, dismissedAt: now },
  });

  return {
    affectedLeads: leads.length,
    affectedConversations: conversations.length,
    affectedAppointments: appointments.length,
    affectedNotifications: notificationResult.count,
  };
}

async function auditMemberChange(
  actor: MemberActor,
  action: AuditAction,
  target: { id: string; userId: string; status: MembershipStatus },
  previousStatus: MembershipStatus,
  newStatus: MembershipStatus,
  context: Omit<AuditInput, "action"> | undefined,
  metadata?: Record<string, unknown>,
) {
  await auditService.log({
    ...(context ?? {}),
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: json({
      businessId: actor.businessId,
      targetMembershipId: target.id,
      targetUserId: target.userId,
      actorMembershipId: actor.membershipId,
      actorUserId: actor.userId,
      previousStatus,
      newStatus,
      ...metadata,
    }),
  });
}

function publishMemberChange(type: "business.member.disabled" | "business.member.restored" | "business.member.removed" | "business.member.suspended_by_plan", actor: MemberActor, targetMembershipId: string, payload: Record<string, unknown>) {
  realtimeService.publish({
    type,
    businessId: actor.businessId,
    staffMembershipIds: [targetMembershipId],
    payload,
  });
  realtimeService.publish({
    type: "business.member.access_changed",
    businessId: actor.businessId,
    staffMembershipIds: [targetMembershipId],
    payload,
  });
  realtimeService.publish({
    type: "business.team.updated",
    businessId: actor.businessId,
    payload: { businessId: actor.businessId },
  });
}

export const businessMemberAccessService = {
  async listMembers(actor: MemberActor) {
    const visibilityScope = actor.role === BusinessRole.STAFF ? actor.membershipId : "team";
    const cacheKey = `business:${actor.businessId}:members:list:${visibilityScope}`;
    const cached = await cacheService.get<unknown>(cacheKey);
    if (cached) return cached;

    const members = await prisma.businessMember.findMany({
      where: {
        businessId: actor.businessId,
        status: { not: MembershipStatus.REMOVED },
        ...(actor.role === BusinessRole.STAFF ? { id: actor.membershipId } : {}),
      },
      orderBy: [
        { role: "asc" },
        { joinedAt: "asc" },
        { createdAt: "asc" },
      ],
      select: {
        id: true,
        userId: true,
        businessId: true,
        role: true,
        status: true,
        disabledAt: true,
        disabledReason: true,
        suspendedAt: true,
        suspendedReason: true,
        restoredAt: true,
        positionTitle: true,
        specialties: true,
        serviceTags: true,
        isAiHandoffEligible: true,
        canTakeAppointments: true,
        aiHandoffPriority: true,
        joinedAt: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        business: {
          select: {
            id: true,
            name: true,
            slug: true,
            industry: true,
          },
        },
      },
    });

    const result = {
      business: members[0]?.business ?? null,
      members: members.map((member) => ({
        membershipId: member.id,
        userId: member.userId,
        businessId: member.businessId,
        role: member.role,
        status: member.status,
        disabledAt: member.disabledAt,
        disabledReason: member.disabledReason,
        suspendedAt: member.suspendedAt,
        suspendedReason: member.suspendedReason,
        restoredAt: member.restoredAt,
        positionTitle: member.positionTitle,
        specialties: member.specialties,
        serviceTags: member.serviceTags,
        isAiHandoffEligible: member.isAiHandoffEligible,
        canTakeAppointments: member.canTakeAppointments,
        aiHandoffPriority: member.aiHandoffPriority,
        joinedAt: member.joinedAt,
        createdAt: member.createdAt,
        updatedAt: member.updatedAt,
        canReceiveAssignedWork: canReceiveAssignedWork(member),
        user: member.user,
        name: `${member.user.firstName} ${member.user.lastName}`.trim(),
        email: member.user.email,
        business: member.business,
        permissions: permissionFlags({
          role: member.role,
          membershipStatus: member.status,
          canCreateBusiness: false,
        }),
      })),
    };
    await cacheService.set(cacheKey, result, 60);
    return result;
  },

  async disableMember(actor: MemberActor, targetMembershipId: string, input: { reason?: string | null }, context: Omit<AuditInput, "action">) {
    requireTeamManager(actor);
    const result = await prisma.$transaction(async (tx) => {
      const target = await loadTarget(tx, actor.businessId, targetMembershipId);
      assertTargetCanChange(actor, target, "disable");
      if (target.status === MembershipStatus.DISABLED) throw new AppError(409, "Business member is already disabled.", "BUSINESS_MEMBER_ALREADY_DISABLED");
      if (target.status === MembershipStatus.REMOVED) throw new AppError(409, "Business member has already been removed.", "BUSINESS_MEMBER_ALREADY_REMOVED");
      const previousStatus = target.status;
      const cleanup = await cleanupAssignedRecords(tx, actor, target.id, "member_disabled");
      const updated = await tx.businessMember.update({
        where: { id: target.id },
        data: {
          status: MembershipStatus.DISABLED,
          disabledAt: new Date(),
          disabledByMembershipId: actor.membershipId,
          disabledReason: input.reason ?? null,
          suspendedAt: null,
          suspendedByMembershipId: null,
          suspendedReason: null,
        },
      });
      if (previousStatus === MembershipStatus.ACTIVE) await adjustStaffUsage(tx, target.business.businessAccountId, -1);
      return { target, updated, previousStatus, cleanup };
    });
    await Promise.all([
      auditMemberChange(actor, AuditAction.BUSINESS_MEMBER_DISABLED, result.target, result.previousStatus, result.updated.status, context, { reason: input.reason ?? null, ...result.cleanup }),
      auditMemberChange(actor, AuditAction.ASSIGNED_RECORDS_UNASSIGNED_DUE_TO_MEMBER_STATUS, result.target, result.previousStatus, result.updated.status, context, { reason: "member_disabled", ...result.cleanup }),
      invalidateMemberCaches(actor.businessId, result.target.userId, result.target.id),
    ]);
    publishMemberChange("business.member.disabled", actor, result.target.id, { targetMembershipId: result.target.id, previousStatus: result.previousStatus, newStatus: result.updated.status });
    return { member: result.updated, affectedRecords: result.cleanup };
  },

  async removeMember(actor: MemberActor, targetMembershipId: string, input: { reason?: string | null }, context: Omit<AuditInput, "action">) {
    requireTeamManager(actor);
    const result = await prisma.$transaction(async (tx) => {
      const target = await loadTarget(tx, actor.businessId, targetMembershipId);
      assertTargetCanChange(actor, target, "remove");
      if (target.status === MembershipStatus.REMOVED) throw new AppError(409, "Business member has already been removed.", "BUSINESS_MEMBER_ALREADY_REMOVED");
      const previousStatus = target.status;
      const cleanup = await cleanupAssignedRecords(tx, actor, target.id, "member_removed");
      const updated = await tx.businessMember.update({
        where: { id: target.id },
        data: {
          status: MembershipStatus.REMOVED,
          removedAt: new Date(),
          removedByMembershipId: actor.membershipId,
          removedReason: input.reason ?? null,
          disabledAt: null,
          disabledByMembershipId: null,
          disabledReason: null,
          suspendedAt: null,
          suspendedByMembershipId: null,
          suspendedReason: null,
        },
      });
      if (previousStatus === MembershipStatus.ACTIVE) await adjustStaffUsage(tx, target.business.businessAccountId, -1);
      return { target, updated, previousStatus, cleanup };
    });
    await Promise.all([
      auditMemberChange(actor, AuditAction.BUSINESS_MEMBER_REMOVED, result.target, result.previousStatus, result.updated.status, context, { reason: input.reason ?? null, ...result.cleanup }),
      auditMemberChange(actor, AuditAction.ASSIGNED_RECORDS_UNASSIGNED_DUE_TO_MEMBER_STATUS, result.target, result.previousStatus, result.updated.status, context, { reason: "member_removed", ...result.cleanup }),
      invalidateMemberCaches(actor.businessId, result.target.userId, result.target.id),
    ]);
    publishMemberChange("business.member.removed", actor, result.target.id, { targetMembershipId: result.target.id, previousStatus: result.previousStatus, newStatus: result.updated.status });
    return { member: result.updated, affectedRecords: result.cleanup };
  },

  async restoreDisabledMember(actor: MemberActor, targetMembershipId: string, context: Omit<AuditInput, "action">) {
    requireTeamManager(actor);
    const result = await prisma.$transaction(async (tx) => {
      const target = await loadTarget(tx, actor.businessId, targetMembershipId);
      assertTargetCanChange(actor, target, "restore");
      if (target.status === MembershipStatus.ACTIVE) throw new AppError(409, "Business member is already active.", "BUSINESS_MEMBER_ALREADY_ACTIVE");
      if (target.status === MembershipStatus.REMOVED) throw new AppError(409, "Business member has already been removed.", "BUSINESS_MEMBER_ALREADY_REMOVED");
      await assertCanRestore(tx, actor.businessId, target.business.businessAccountId);
      const previousStatus = target.status;
      const updated = await tx.businessMember.update({
        where: { id: target.id },
        data: {
          status: MembershipStatus.ACTIVE,
          restoredAt: new Date(),
          restoredByMembershipId: actor.membershipId,
          disabledAt: null,
          disabledByMembershipId: null,
          disabledReason: null,
          suspendedAt: null,
          suspendedByMembershipId: null,
          suspendedReason: null,
        },
      });
      await adjustStaffUsage(tx, target.business.businessAccountId, 1);
      return { target, updated, previousStatus };
    });
    const action = result.previousStatus === MembershipStatus.SUSPENDED_BY_PLAN
      ? AuditAction.BUSINESS_MEMBER_RESTORED_AFTER_PLAN_CHANGE
      : AuditAction.BUSINESS_MEMBER_RESTORED;
    await Promise.all([
      auditMemberChange(actor, action, result.target, result.previousStatus, result.updated.status, context),
      invalidateMemberCaches(actor.businessId, result.target.userId, result.target.id),
    ]);
    publishMemberChange("business.member.restored", actor, result.target.id, { targetMembershipId: result.target.id, previousStatus: result.previousStatus, newStatus: result.updated.status });
    return { member: result.updated };
  },

  async suspendMembersByPlanLimit(input: { businessId: string; actorMembershipId: string; allowedStaffCount: number }, context?: Omit<AuditInput, "action">) {
    const actorMembership = await prisma.businessMember.findFirst({ where: { id: input.actorMembershipId, businessId: input.businessId }, include: { business: true } });
    if (!actorMembership) throw new AppError(404, "Business member not found.", "BUSINESS_MEMBER_NOT_FOUND");
    const actor: MemberActor = {
      userId: actorMembership.userId,
      businessAccountId: actorMembership.business.businessAccountId,
      businessId: input.businessId,
      membershipId: actorMembership.id,
      role: actorMembership.role,
    };
    const result = await prisma.$transaction(async (tx) => {
      const activeMembers = await tx.businessMember.findMany({
        where: { businessId: input.businessId, status: MembershipStatus.ACTIVE },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }, { createdAt: "asc" }],
        include: { business: { select: { businessAccountId: true } } },
      });
      if (activeMembers.length <= input.allowedStaffCount) return { suspended: [], summaries: [] as Array<Record<string, number>> };
      const owners = activeMembers.filter((member) => member.role === BusinessRole.BUSINESS_OWNER);
      const managers = activeMembers.filter((member) => member.role === BusinessRole.MANAGER);
      const staff = activeMembers.filter((member) => member.role === BusinessRole.STAFF);
      const keepSlots = Math.max(input.allowedStaffCount - owners.length, 0);
      const keptNonOwners = [...managers, ...staff].slice(0, keepSlots);
      const keepIds = new Set([...owners, ...keptNonOwners].map((member) => member.id));
      const excess = activeMembers.filter((member) => !keepIds.has(member.id) && member.role !== BusinessRole.BUSINESS_OWNER);
      const suspended = [];
      const summaries = [];
      for (const member of excess) {
        const cleanup = await cleanupAssignedRecords(tx, actor, member.id, "subscription_downgrade");
        const updated = await tx.businessMember.update({
          where: { id: member.id },
          data: {
            status: MembershipStatus.SUSPENDED_BY_PLAN,
            suspendedAt: new Date(),
            suspendedByMembershipId: input.actorMembershipId,
            suspendedReason: "SUBSCRIPTION_DOWNGRADE",
          },
        });
        await adjustStaffUsage(tx, member.business.businessAccountId, -1);
        suspended.push({ member, updated, cleanup });
        summaries.push(cleanup);
      }
      return { suspended, summaries };
    });
    await Promise.all(result.suspended.flatMap((item) => [
      auditMemberChange(actor, AuditAction.BUSINESS_MEMBER_SUSPENDED_BY_PLAN, item.member, MembershipStatus.ACTIVE, item.updated.status, context, { reason: "SUBSCRIPTION_DOWNGRADE", ...item.cleanup }),
      auditMemberChange(actor, AuditAction.ASSIGNED_RECORDS_UNASSIGNED_DUE_TO_MEMBER_STATUS, item.member, MembershipStatus.ACTIVE, item.updated.status, context, { reason: "subscription_downgrade", ...item.cleanup }),
      invalidateMemberCaches(input.businessId, item.member.userId, item.member.id),
    ]));
    for (const item of result.suspended) {
      publishMemberChange("business.member.suspended_by_plan", actor, item.member.id, { targetMembershipId: item.member.id, previousStatus: MembershipStatus.ACTIVE, newStatus: item.updated.status });
    }
    return {
      suspendedMembers: result.suspended.length,
      affectedRecords: result.summaries.reduce((total, item) => ({
        affectedLeads: total.affectedLeads + (item.affectedLeads ?? 0),
        affectedConversations: total.affectedConversations + (item.affectedConversations ?? 0),
        affectedAppointments: total.affectedAppointments + (item.affectedAppointments ?? 0),
        affectedNotifications: total.affectedNotifications + (item.affectedNotifications ?? 0),
      }), { affectedLeads: 0, affectedConversations: 0, affectedAppointments: 0, affectedNotifications: 0 }),
    };
  },

  async restoreMembersAfterPlanUpgrade(input: { businessId: string; actorMembershipId: string; allowedStaffCount: number }) {
    const suspendedMembers = await prisma.businessMember.count({ where: { businessId: input.businessId, status: MembershipStatus.SUSPENDED_BY_PLAN } });
    const activeMembers = await prisma.businessMember.count({ where: { businessId: input.businessId, status: MembershipStatus.ACTIVE } });
    return {
      restoredMembers: 0,
      suspendedMembers,
      allowedActiveMembers: input.allowedStaffCount,
      currentActiveMembers: activeMembers,
      message: "Suspended members are not automatically restored after upgrade. Restore selected members manually.",
    };
  },

  async validateMemberAccess(input: { businessId: string; membershipId: string }) {
    const member = await prisma.businessMember.findFirst({ where: { id: input.membershipId, businessId: input.businessId } });
    if (!member) throw new AppError(404, "Business member not found.", "BUSINESS_MEMBER_NOT_FOUND");
    if (member.status === MembershipStatus.ACTIVE) return member;
    const code = member.status === MembershipStatus.SUSPENDED_BY_PLAN
      ? "MEMBERSHIP_SUSPENDED_BY_PLAN"
      : member.status === MembershipStatus.DISABLED
        ? "MEMBERSHIP_DISABLED"
        : member.status === MembershipStatus.REMOVED
          ? "MEMBERSHIP_REMOVED"
          : "MEMBERSHIP_INVITE_NOT_ACCEPTED";
    throw new AppError(403, "This member does not have active access to this business.", code);
  },

  async isEligibleStaffForAiRouting(input: { businessId: string; membershipId: string }) {
    const member = await prisma.businessMember.findFirst({
      where: {
        id: input.membershipId,
        businessId: input.businessId,
        status: MembershipStatus.ACTIVE,
        role: { in: [BusinessRole.MANAGER, BusinessRole.STAFF] },
      },
      select: { id: true },
    });
    return Boolean(member);
  },

  async isEligibleStaffForOperationalAssignment(input: { businessId: string; membershipId: string }) {
    const member = await prisma.businessMember.findFirst({
      where: {
        id: input.membershipId,
        businessId: input.businessId,
        status: MembershipStatus.ACTIVE,
        role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER, BusinessRole.STAFF] },
      },
      select: { id: true },
    });
    return Boolean(member);
  },

  async isEligibleStaffForAiHandoff(input: { businessId: string; membershipId: string }) {
    const member = await prisma.businessMember.findFirst({
      where: {
        id: input.membershipId,
        businessId: input.businessId,
        status: MembershipStatus.ACTIVE,
        isAiHandoffEligible: true,
        role: { in: [BusinessRole.MANAGER, BusinessRole.STAFF] },
      },
      select: { id: true },
    });
    return Boolean(member);
  },

  async updateOperationalProfile(
    actor: MemberActor,
    targetMembershipId: string,
    input: {
      positionTitle?: string | null;
      specialties?: string[];
      serviceTags?: string[];
      isAiHandoffEligible?: boolean;
      canTakeAppointments?: boolean;
      aiHandoffPriority?: number | null;
    },
    context: Omit<AuditInput, "action">,
  ) {
    requireTeamManager(actor);
    const result = await prisma.$transaction(async (tx) => {
      const target = await loadTarget(tx, actor.businessId, targetMembershipId);
      if (target.status === MembershipStatus.REMOVED) {
        throw new AppError(409, "Business member has already been removed.", "BUSINESS_MEMBER_ALREADY_REMOVED");
      }
      const changedFields = Object.keys(input).filter((field) => {
        const key = field as keyof typeof input;
        return JSON.stringify(target[key as keyof typeof target] ?? null) !== JSON.stringify(input[key] ?? null);
      });
      if (changedFields.length === 0) return { target, updated: target, changedFields };
      const updated = await tx.businessMember.update({
        where: { id: target.id },
        data: input,
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      });
      return { target, updated, changedFields };
    });
    if (result.changedFields.length > 0) {
      await Promise.all([
        auditMemberChange(actor, AuditAction.STAFF_OPERATIONAL_PROFILE_UPDATED, result.target, result.target.status, result.target.status, context, {
          changedFields: result.changedFields,
          previousValues: Object.fromEntries(result.changedFields.map((field) => [field, result.target[field as keyof typeof result.target] ?? null])),
          newValues: Object.fromEntries(result.changedFields.map((field) => [field, result.updated[field as keyof typeof result.updated] ?? null])),
        }),
        invalidateMemberCaches(actor.businessId, result.target.userId, result.target.id),
      ]);
      realtimeService.publish({
        type: "business.member.operational_profile_updated",
        businessId: actor.businessId,
        staffMembershipIds: [result.target.id],
        payload: { targetMembershipId: result.target.id, changedFields: result.changedFields },
      });
      realtimeService.publish({
        type: "business.team.updated",
        businessId: actor.businessId,
        payload: { businessId: actor.businessId },
      });
    }
    return { member: result.updated };
  },
};
