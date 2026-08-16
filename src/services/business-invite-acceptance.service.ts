import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessMember,
  BusinessRole,
  BusinessStatus,
  InvitationStatus,
  MembershipStatus,
  Prisma,
  UserAccountType,
  UserStatus,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../config/prisma";
import { hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import { accountPolicyService } from "./account-policy.service";
import { AuditInput, auditService } from "./audit.service";
import { invalidateBusinessTeamCaches, lockBusinessInvitations } from "./business-invitation-management.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./subscription.service";
import { tokenService } from "./token.service";

type InviteWithBusiness = Prisma.BusinessInvitationGetPayload<{
  include: { business: { select: { id: true; name: true; status: true; deletedAt: true; businessAccountId: true } } };
}>;

type AcceptedUser = { id: string; firstName: string; lastName: string; email: string };
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function safeInvite(invitation: InviteWithBusiness) {
  return {
    valid: true,
    inviteId: invitation.id,
    business: { id: invitation.business.id, name: invitation.business.name },
    role: invitation.role,
    email: invitation.email,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
  };
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts.shift() ?? "Staff", lastName: parts.join(" ") || "Member" };
}

function invalidInviteResponse(code = "INVITE_INVALID_OR_EXPIRED") {
  return { valid: false, code, message: "This invite link is invalid or has expired." };
}

async function loadInvite(token: string) {
  return prisma.businessInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { business: { select: { id: true, name: true, status: true, deletedAt: true, businessAccountId: true } } },
  });
}

function assertInviteBusinessIsEligible(invitation: InviteWithBusiness) {
  if (invitation.business.deletedAt || invitation.business.status === BusinessStatus.SUSPENDED) {
    throw new AppError(404, "Business not found.", "BUSINESS_NOT_FOUND");
  }
  if (invitation.role === BusinessRole.BUSINESS_OWNER) {
    throw new AppError(422, "This invite role is not allowed.", "INVALID_INVITE_ROLE");
  }
}

function assertInviteCanBeAccepted(invitation: InviteWithBusiness) {
  if (invitation.status === InvitationStatus.REVOKED) throw new AppError(410, "This invite has been cancelled.", "INVITE_CANCELLED");
  if (invitation.status === InvitationStatus.EXPIRED) throw new AppError(410, "This invite link has expired.", "INVITE_EXPIRED");
  if (invitation.status !== InvitationStatus.PENDING && invitation.status !== InvitationStatus.ACCEPTED) {
    throw new AppError(400, "This invite link is invalid.", "INVITE_INVALID");
  }
  assertInviteBusinessIsEligible(invitation);
}

async function ownerManagerRecipients(businessId: string) {
  const recipients = await prisma.businessMember.findMany({
    where: { businessId, status: MembershipStatus.ACTIVE, role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] } },
    select: { id: true },
  });
  return recipients.map((recipient) => recipient.id);
}

async function notifyJoined(input: { businessId: string; businessAccountId: string; memberName: string; membershipId: string; role: BusinessRole }) {
  const recipients = await ownerManagerRecipients(input.businessId);
  if (!recipients.length) return [];
  return notificationService.createNotificationsForRecipients({
    businessId: input.businessId,
    businessAccountId: input.businessAccountId,
    recipientMembershipIds: recipients,
    type: BusinessNotificationType.INFO,
    priority: BusinessNotificationPriority.NORMAL,
    title: "Team member joined",
    message: `${input.memberName} accepted the invitation and joined your business.`,
    entityType: BusinessNotificationEntityType.BUSINESS,
    entityId: input.businessId,
    actions: [{ label: "View team", action: "VIEW_TEAM", variant: "default" }],
    metadata: { membershipId: input.membershipId, role: input.role },
  });
}

async function reserveStaffCapacity(tx: Prisma.TransactionClient, input: { businessAccountId: string; requiresAdditionalSeat: boolean }) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('business_staff_quota'), hashtext(${input.businessAccountId}))`;
  const now = new Date();
  const subscription = await tx.subscription.findFirst({
    where: {
      businessAccountId: input.businessAccountId,
      status: { in: ACTIVE_SUBSCRIPTION_STATUSES },
      currentPeriodStart: { lte: now },
      currentPeriodEnd: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    include: {
      plan: true,
      usageRecords: {
        where: { businessAccountId: input.businessAccountId, periodStart: { lte: now }, periodEnd: { gt: now } },
        orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
      },
    },
  });
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  const matchingUsage = subscription.usageRecords.filter((usage) => (
    usage.subscriptionId === subscription.id
    && usage.periodStart.getTime() === subscription.currentPeriodStart.getTime()
    && usage.periodEnd.getTime() === subscription.currentPeriodEnd.getTime()
  ));
  if (matchingUsage.length !== 1) {
    throw new AppError(500, "The current account usage period is unavailable or ambiguous.", "USAGE_RECORD_UNAVAILABLE");
  }
  const activeMemberCount = await tx.businessMember.count({
    where: { status: MembershipStatus.ACTIVE, business: { businessAccountId: input.businessAccountId, deletedAt: null } },
  });
  if (input.requiresAdditionalSeat && subscription.plan.maxStaff !== null && activeMemberCount >= subscription.plan.maxStaff) {
    throw new AppError(403, "Your current plan does not allow more active staff members.", "STAFF_LIMIT_EXCEEDED", {
      current: activeMemberCount,
      limit: subscription.plan.maxStaff,
    });
  }
  const nextCount = activeMemberCount + (input.requiresAdditionalSeat ? 1 : 0);
  await tx.accountUsageRecord.update({ where: { id: matchingUsage[0]!.id }, data: { staffCount: nextCount } });
  return { previousCount: matchingUsage[0]!.staffCount, currentCount: nextCount };
}

type AcceptanceTransactionResult = {
  invitation: InviteWithBusiness;
  membership: BusinessMember;
  user: AcceptedUser;
  reactivated: boolean;
  duplicate: boolean;
  createdFromInvite: boolean;
  usage: { previousCount: number; currentCount: number } | null;
};

async function acceptInTransaction(input: {
  token: string;
  actorUserId?: string;
  signup?: { firstName: string; lastName: string; passwordHash: string };
}): Promise<AcceptanceTransactionResult> {
  const tokenHash = hashToken(input.token);
  const outcome = await prisma.$transaction(async (tx) => {
    const initial = await tx.businessInvitation.findUnique({
      where: { tokenHash },
      include: { business: { select: { id: true, name: true, status: true, deletedAt: true, businessAccountId: true } } },
    });
    if (!initial) throw new AppError(404, "Invite not found.", "INVITE_NOT_FOUND");
    await lockBusinessInvitations(tx, initial.businessId);
    const invitation = await tx.businessInvitation.findUniqueOrThrow({
      where: { id: initial.id },
      include: { business: { select: { id: true, name: true, status: true, deletedAt: true, businessAccountId: true } } },
    });
    assertInviteCanBeAccepted(invitation);

    if (invitation.status === InvitationStatus.ACCEPTED) {
      if (!input.actorUserId || invitation.acceptedByUserId !== input.actorUserId) {
        throw new AppError(409, "This invite has already been accepted.", "INVITE_ALREADY_ACCEPTED");
      }
      const [user, membership] = await Promise.all([
        tx.user.findUnique({ where: { id: input.actorUserId }, select: { id: true, firstName: true, lastName: true, email: true } }),
        tx.businessMember.findUnique({ where: { businessId_userId: { businessId: invitation.businessId, userId: input.actorUserId } } }),
      ]);
      if (!user || !membership || membership.status !== MembershipStatus.ACTIVE) {
        throw new AppError(409, "The accepted invitation is inconsistent with the active membership.", "INVITE_ACCEPTANCE_STATE_INVALID");
      }
      return { invitation, membership, user, reactivated: false, duplicate: true, createdFromInvite: false, usage: null };
    }

    if (invitation.expiresAt <= new Date()) {
      await tx.businessInvitation.update({ where: { id: invitation.id }, data: { status: InvitationStatus.EXPIRED } });
      return { expired: true as const };
    }

    let user: AcceptedUser;
    let createdFromInvite = false;
    if (input.actorUserId) {
      const existingUser = await tx.user.findUnique({
        where: { id: input.actorUserId },
        select: { id: true, firstName: true, lastName: true, email: true, status: true, deletedAt: true },
      });
      if (!existingUser || existingUser.status !== UserStatus.ACTIVE || existingUser.deletedAt) {
        throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
      }
      if (existingUser.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new AppError(403, "This invite was sent to a different email address.", "INVITE_EMAIL_MISMATCH");
      }
      user = existingUser;
    } else {
      if (!input.signup) throw new AppError(422, "Account details are required.", "INVITEE_ACCOUNT_DETAILS_REQUIRED");
      if (await tx.user.findUnique({ where: { email: invitation.email } })) {
        throw new AppError(409, "An account already exists for this email. Please log in to accept the invite.", "USER_ALREADY_EXISTS");
      }
      user = await tx.user.create({
        data: {
          firstName: input.signup.firstName,
          lastName: input.signup.lastName,
          email: invitation.email,
          passwordHash: input.signup.passwordHash,
          emailVerified: true,
          status: UserStatus.ACTIVE,
          accountType: UserAccountType.STAFF_ONLY,
          canCreateBusiness: false,
        },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      createdFromInvite = true;
    }

    const existingMembership = await tx.businessMember.findUnique({
      where: { businessId_userId: { businessId: invitation.businessId, userId: user.id } },
    });
    if (existingMembership?.status === MembershipStatus.DISABLED) {
      throw new AppError(403, "This account is not allowed to accept this staff invite.", "ACCOUNT_NOT_ALLOWED_FOR_STAFF_INVITE");
    }
    const requiresAdditionalSeat = existingMembership?.status !== MembershipStatus.ACTIVE;
    const usage = await reserveStaffCapacity(tx, {
      businessAccountId: invitation.business.businessAccountId,
      requiresAdditionalSeat,
    });
    const now = new Date();
    const membership = await tx.businessMember.upsert({
      where: { businessId_userId: { businessId: invitation.businessId, userId: user.id } },
      create: {
        businessId: invitation.businessId,
        userId: user.id,
        role: invitation.role,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
        invitedById: invitation.invitedById,
      },
      update: {
        role: invitation.role,
        status: MembershipStatus.ACTIVE,
        joinedAt: existingMembership?.status === MembershipStatus.ACTIVE ? existingMembership.joinedAt ?? now : now,
        invitedById: invitation.invitedById,
        removedAt: null,
        removedByMembershipId: null,
        removedReason: null,
        suspendedAt: null,
        suspendedByMembershipId: null,
        suspendedReason: null,
      },
    });
    const accepted = await tx.businessInvitation.updateMany({
      where: { id: invitation.id, businessId: invitation.businessId, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.ACCEPTED, acceptedAt: now, acceptedByUserId: user.id },
    });
    if (accepted.count !== 1) throw new AppError(409, "Invitation state changed. Please retry.", "INVITE_STATE_CHANGED");
    return {
      invitation: { ...invitation, status: InvitationStatus.ACCEPTED, acceptedAt: now, acceptedByUserId: user.id },
      membership,
      user,
      reactivated: Boolean(existingMembership && existingMembership.status !== MembershipStatus.ACTIVE),
      duplicate: false,
      createdFromInvite,
      usage,
    };
  }, TRANSACTION_OPTIONS);
  if ("expired" in outcome) throw new AppError(410, "This invite link has expired.", "INVITE_EXPIRED");
  return outcome;
}

function acceptanceResponse(result: AcceptanceTransactionResult) {
  return {
    accepted: true,
    idempotentReplay: result.duplicate,
    business: { id: result.invitation.business.id, name: result.invitation.business.name },
    membership: { id: result.membership.id, role: result.membership.role, status: result.membership.status },
    activeBusinessId: result.invitation.business.id,
    activeMembershipId: result.membership.id,
    role: result.membership.role,
  };
}

async function publishAcceptance(result: AcceptanceTransactionResult, context: Omit<AuditInput, "action">) {
  if (result.duplicate) return;
  const memberName = `${result.user.firstName} ${result.user.lastName}`.trim();
  const sideEffects = await Promise.allSettled([
    auditService.log({
      ...context,
      action: AuditAction.STAFF_INVITE_ACCEPTED,
      businessId: result.invitation.businessId,
      userId: result.user.id,
      metadata: json({ inviteId: result.invitation.id, membershipId: result.membership.id, role: result.membership.role, acceptedAt: result.invitation.acceptedAt }),
    }),
    auditService.log({
      ...context,
      action: AuditAction.BUSINESS_MEMBER_ACTIVATED_FROM_INVITE,
      businessId: result.invitation.businessId,
      userId: result.user.id,
      metadata: json({ inviteId: result.invitation.id, membershipId: result.membership.id, reactivated: result.reactivated }),
    }),
    ...(result.createdFromInvite ? [auditService.log({
      ...context,
      action: AuditAction.STAFF_ACCOUNT_CREATED_FROM_INVITE,
      businessId: result.invitation.businessId,
      userId: result.user.id,
      metadata: json({ inviteId: result.invitation.id, targetUserId: result.user.id, accountType: UserAccountType.STAFF_ONLY }),
    })] : []),
    ...(result.usage && result.usage.previousCount !== result.usage.currentCount ? [auditService.log({
      ...context,
      action: AuditAction.USAGE_RECORD_UPDATED,
      businessId: result.invitation.businessId,
      userId: result.user.id,
      metadata: json({ usageKey: "staffCount", ...result.usage }),
    })] : []),
    invalidateBusinessTeamCaches(result.invitation.businessId, result.user.id),
    notifyJoined({
      businessId: result.invitation.businessId,
      businessAccountId: result.invitation.business.businessAccountId,
      memberName,
      membershipId: result.membership.id,
      role: result.membership.role,
    }),
  ]);
  for (const sideEffect of sideEffects) {
    if (sideEffect.status === "rejected") {
      console.error("Business invitation acceptance side effect failed", {
        businessId: result.invitation.businessId,
        invitationId: result.invitation.id,
        membershipId: result.membership.id,
        error: sideEffect.reason,
      });
    }
  }
  realtimeService.publish({
    type: "business.member.joined",
    businessId: result.invitation.businessId,
    staffMembershipIds: [result.membership.id],
    payload: { membershipId: result.membership.id, role: result.membership.role, status: result.membership.status },
  });
  realtimeService.publish({
    type: "business.invite.accepted",
    businessId: result.invitation.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { inviteId: result.invitation.id, membershipId: result.membership.id, status: InvitationStatus.ACCEPTED },
  });
  realtimeService.publish({
    type: "business.team.updated",
    businessId: result.invitation.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { businessId: result.invitation.businessId },
  });
}

export const businessInviteAcceptanceService = {
  async validateInviteToken(token: string, context: Omit<AuditInput, "action">) {
    const invitation = await loadInvite(token);
    if (!invitation || invitation.status !== InvitationStatus.PENDING || invitation.expiresAt <= new Date() || invitation.business.deletedAt) {
      return invalidInviteResponse();
    }
    if (invitation.role === BusinessRole.BUSINESS_OWNER) return invalidInviteResponse("INVALID_INVITE_ROLE");
    await auditService.log({
      ...context,
      action: AuditAction.STAFF_INVITE_VIEWED,
      businessId: invitation.businessId,
      metadata: json({ inviteId: invitation.id, role: invitation.role }),
    });
    return safeInvite(invitation);
  },

  async acceptInviteForExistingUser(input: { token: string; actorUserId: string; context: Omit<AuditInput, "action"> }) {
    const invitation = await loadInvite(input.token);
    if (!invitation) throw new AppError(404, "Invite not found.", "INVITE_NOT_FOUND");
    assertInviteCanBeAccepted(invitation);
    const user = await prisma.user.findUnique({ where: { id: input.actorUserId } });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      await auditService.log({
        ...input.context,
        action: AuditAction.STAFF_INVITE_ACCEPTANCE_BLOCKED,
        businessId: invitation.businessId,
        userId: user.id,
        metadata: json({ inviteId: invitation.id, reason: "INVITE_EMAIL_MISMATCH" }),
      });
      throw new AppError(403, "This invite was sent to a different email address.", "INVITE_EMAIL_MISMATCH");
    }
    if (invitation.status !== InvitationStatus.ACCEPTED) {
      await accountPolicyService.validateStaffInviteTargetEmail({
        businessId: invitation.businessId,
        targetEmail: invitation.email,
        actorUserId: invitation.invitedById,
        context: input.context,
        allowExistingBusinessMembership: true,
      });
    }
    const result = await acceptInTransaction({ token: input.token, actorUserId: input.actorUserId });
    await publishAcceptance(result, input.context);
    return acceptanceResponse(result);
  },

  async signupAndAcceptInvite(input: { token: string; name: string; password: string; context: Omit<AuditInput, "action"> }) {
    const invitation = await loadInvite(input.token);
    if (!invitation) throw new AppError(404, "Invite not found.", "INVITE_NOT_FOUND");
    assertInviteCanBeAccepted(invitation);
    if (invitation.status === InvitationStatus.ACCEPTED) throw new AppError(409, "This invite has already been accepted.", "INVITE_ALREADY_ACCEPTED");
    if (await prisma.user.findUnique({ where: { email: invitation.email } })) {
      throw new AppError(409, "An account already exists for this email. Please log in to accept the invite.", "USER_ALREADY_EXISTS");
    }
    await accountPolicyService.validateStaffInviteTargetEmail({
      businessId: invitation.businessId,
      targetEmail: invitation.email,
      actorUserId: invitation.invitedById,
      context: input.context,
    });
    const { firstName, lastName } = splitName(input.name);
    const result = await acceptInTransaction({
      token: input.token,
      signup: { firstName, lastName, passwordHash: await bcrypt.hash(input.password, 12) },
    });
    await publishAcceptance(result, input.context);
    return {
      ...acceptanceResponse(result),
      accessToken: tokenService.createAccessToken(result.user.id),
      refreshToken: await tokenService.createRefreshToken(result.user.id),
    };
  },

  async acceptLegacySignup(input: { token: string; firstName?: string; lastName?: string; password?: string; context: Omit<AuditInput, "action"> }) {
    const invitation = await loadInvite(input.token);
    if (!invitation) throw new AppError(404, "Invite not found.", "INVITE_NOT_FOUND");
    const existingUser = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
    if (existingUser) {
      return this.acceptInviteForExistingUser({
        token: input.token,
        actorUserId: existingUser.id,
        context: input.context,
      });
    }
    if (!input.firstName || !input.lastName || !input.password) {
      throw new AppError(422, "First name, last name, and password are required for a new account.", "INVITEE_ACCOUNT_DETAILS_REQUIRED");
    }
    return this.signupAndAcceptInvite({
      token: input.token,
      name: `${input.firstName} ${input.lastName}`,
      password: input.password,
      context: input.context,
    });
  },
};
