import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
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
import { AuditInput, auditService } from "./audit.service";
import { accountPolicyService } from "./account-policy.service";
import { cacheService } from "./cache.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { tokenService } from "./token.service";
import { updateStaffUsage } from "../middleware/subscription-guard";

type InviteWithBusiness = Prisma.BusinessInvitationGetPayload<{
  include: { business: { select: { id: true; name: true; status: true; deletedAt: true; businessAccountId: true } } };
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function safeInvite(invitation: InviteWithBusiness) {
  return {
    valid: true,
    inviteId: invitation.id,
    business: {
      id: invitation.business.id,
      name: invitation.business.name,
    },
    role: invitation.role,
    email: invitation.email,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
  };
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  const firstName = parts.shift() ?? "Staff";
  const lastName = parts.join(" ") || "Member";
  return { firstName, lastName };
}

function invalidInviteResponse(code = "INVITE_INVALID_OR_EXPIRED") {
  return {
    valid: false,
    code,
    message: "This invite link is invalid or has expired.",
  };
}

async function invalidateInviteCaches(businessId: string, userId: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:members:list:*`),
    cacheService.delByPattern(`business:${businessId}:invites:list:*`),
    cacheService.delByPattern(`business:${businessId}:notifications:list:*`),
    cacheService.delByPattern(`business:${businessId}:notifications:counts:*`),
    cacheService.delByPattern(`user:${userId}:memberships:*`),
  ]);
}

async function loadPendingInviteOrThrow(token: string) {
  const invitation = await prisma.businessInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { business: { select: { id: true, name: true, status: true, deletedAt: true, businessAccountId: true } } },
  });
  if (!invitation) throw new AppError(404, "Invite not found.", "INVITE_NOT_FOUND");
  if (invitation.status === InvitationStatus.ACCEPTED) {
    throw new AppError(409, "This invite has already been accepted.", "INVITE_ALREADY_ACCEPTED");
  }
  if (invitation.status === InvitationStatus.REVOKED) {
    throw new AppError(410, "This invite has been cancelled.", "INVITE_CANCELLED");
  }
  if (invitation.status !== InvitationStatus.PENDING || invitation.expiresAt <= new Date()) {
    throw new AppError(400, "This invite link is invalid or has expired.", "INVITE_INVALID_OR_EXPIRED");
  }
  if (!invitation.business || invitation.business.deletedAt || invitation.business.status === BusinessStatus.SUSPENDED) {
    throw new AppError(404, "Business not found.", "BUSINESS_NOT_FOUND");
  }
  if (invitation.role === BusinessRole.BUSINESS_OWNER) {
    throw new AppError(422, "This invite role is not allowed.", "INVALID_INVITE_ROLE");
  }
  return invitation;
}

async function ownerManagerRecipients(businessId: string) {
  const recipients = await prisma.businessMember.findMany({
    where: {
      businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] },
    },
    select: { id: true },
  });
  return recipients.map((recipient) => recipient.id);
}

async function notifyJoined(input: {
  businessId: string;
  businessAccountId: string;
  memberName: string;
  membershipId: string;
  role: BusinessRole;
}) {
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
    metadata: {
      membershipId: input.membershipId,
      role: input.role,
    },
  });
}

async function activateMembership(input: {
  invitation: InviteWithBusiness;
  userId: string;
}) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const existing = await tx.businessMember.findUnique({
      where: { businessId_userId: { businessId: input.invitation.businessId, userId: input.userId } },
    });
    if (existing && existing.status === MembershipStatus.ACTIVE) {
      throw new AppError(409, "This user is already a member of this business.", "USER_ALREADY_BUSINESS_MEMBER");
    }
    if (existing && existing.status === MembershipStatus.DISABLED) {
      throw new AppError(403, "This account is not allowed to accept this staff invite.", "ACCOUNT_NOT_ALLOWED_FOR_STAFF_INVITE");
    }
    const membership = await tx.businessMember.upsert({
      where: { businessId_userId: { businessId: input.invitation.businessId, userId: input.userId } },
      create: {
        businessId: input.invitation.businessId,
        userId: input.userId,
        role: input.invitation.role,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
        invitedById: input.invitation.invitedById,
      },
      update: {
        role: input.invitation.role,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
        invitedById: input.invitation.invitedById,
      },
    });
    const updatedInvite = await tx.businessInvitation.update({
      where: { id: input.invitation.id },
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAt: now,
        acceptedByUserId: input.userId,
      },
    });
    return { membership, invitation: updatedInvite, reactivated: Boolean(existing) };
  });
}

async function finalizeAcceptance(input: {
  invitation: InviteWithBusiness;
  user: { id: string; firstName: string; lastName: string; email: string };
  context: Omit<AuditInput, "action">;
  createdFromInvite?: boolean;
}) {
  const { membership, invitation, reactivated } = await activateMembership({ invitation: input.invitation, userId: input.user.id });
  await updateStaffUsage(input.invitation.business.businessAccountId, 1, input.invitation.businessId);
  const memberName = `${input.user.firstName} ${input.user.lastName}`.trim();
  await Promise.all([
    auditService.log({
      ...input.context,
      action: AuditAction.STAFF_INVITE_ACCEPTED,
      businessId: input.invitation.businessId,
      userId: input.user.id,
      metadata: json({
        businessId: input.invitation.businessId,
        inviteId: input.invitation.id,
        targetEmail: input.invitation.email,
        targetUserId: input.user.id,
        membershipId: membership.id,
        role: membership.role,
        acceptedAt: invitation.acceptedAt,
      }),
    }),
    auditService.log({
      ...input.context,
      action: AuditAction.BUSINESS_MEMBER_ACTIVATED_FROM_INVITE,
      businessId: input.invitation.businessId,
      userId: input.user.id,
      metadata: json({
        inviteId: input.invitation.id,
        membershipId: membership.id,
        role: membership.role,
        reactivated,
      }),
    }),
    ...(input.createdFromInvite ? [
      auditService.log({
        ...input.context,
        action: AuditAction.STAFF_ACCOUNT_CREATED_FROM_INVITE,
        businessId: input.invitation.businessId,
        userId: input.user.id,
        metadata: json({
          inviteId: input.invitation.id,
          targetEmail: input.invitation.email,
          targetUserId: input.user.id,
          accountType: UserAccountType.STAFF_ONLY,
        }),
      }),
    ] : []),
    invalidateInviteCaches(input.invitation.businessId, input.user.id),
    notifyJoined({
      businessId: input.invitation.businessId,
      businessAccountId: input.invitation.business.businessAccountId,
      memberName,
      membershipId: membership.id,
      role: membership.role,
    }),
  ]);
  realtimeService.publish({
    type: "business.member.joined",
    businessId: input.invitation.businessId,
    staffMembershipIds: await ownerManagerRecipients(input.invitation.businessId),
    payload: {
      businessId: input.invitation.businessId,
      membershipId: membership.id,
      role: membership.role,
      status: membership.status,
    },
  });
  realtimeService.publish({
    type: "business.invite.accepted",
    businessId: input.invitation.businessId,
    staffMembershipIds: await ownerManagerRecipients(input.invitation.businessId),
    payload: {
      businessId: input.invitation.businessId,
      inviteId: input.invitation.id,
      membershipId: membership.id,
      role: membership.role,
      status: InvitationStatus.ACCEPTED,
    },
  });
  return {
    accepted: true,
    business: {
      id: input.invitation.business.id,
      name: input.invitation.business.name,
    },
    membership: {
      id: membership.id,
      role: membership.role,
      status: membership.status,
    },
    activeBusinessId: input.invitation.business.id,
    activeMembershipId: membership.id,
    role: membership.role,
  };
}

export const businessInviteAcceptanceService = {
  async validateInviteToken(token: string, context: Omit<AuditInput, "action">) {
    const invitation = await prisma.businessInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { business: { select: { id: true, name: true, status: true, deletedAt: true, businessAccountId: true } } },
    });
    if (!invitation || invitation.status !== InvitationStatus.PENDING || invitation.expiresAt <= new Date() || invitation.business.deletedAt) {
      return invalidInviteResponse();
    }
    if (invitation.role === BusinessRole.BUSINESS_OWNER) return invalidInviteResponse("INVALID_INVITE_ROLE");
    await auditService.log({
      ...context,
      action: AuditAction.STAFF_INVITE_VIEWED,
      businessId: invitation.businessId,
      metadata: json({
        businessId: invitation.businessId,
        inviteId: invitation.id,
        targetEmail: invitation.email,
        role: invitation.role,
      }),
    });
    return safeInvite(invitation);
  },

  async acceptInviteForExistingUser(input: { token: string; actorUserId: string; context: Omit<AuditInput, "action"> }) {
    const invitation = await loadPendingInviteOrThrow(input.token);
    const user = await prisma.user.findUnique({ where: { id: input.actorUserId } });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      await auditService.log({
        ...input.context,
        action: AuditAction.STAFF_INVITE_ACCEPTANCE_BLOCKED,
        businessId: invitation.businessId,
        userId: user.id,
        metadata: json({ inviteId: invitation.id, targetEmail: invitation.email, actorEmail: user.email, reason: "INVITE_EMAIL_MISMATCH" }),
      });
      throw new AppError(403, "This invite was sent to a different email address. Please log in with the invited email.", "INVITE_EMAIL_MISMATCH");
    }
    await accountPolicyService.validateStaffInviteTargetEmail({
      businessId: invitation.businessId,
      targetEmail: invitation.email,
      actorUserId: invitation.invitedById,
      context: input.context,
      allowExistingBusinessMembership: true,
    });
    return finalizeAcceptance({ invitation, user, context: input.context });
  },

  async signupAndAcceptInvite(input: { token: string; name: string; password: string; context: Omit<AuditInput, "action"> }) {
    const invitation = await loadPendingInviteOrThrow(input.token);
    const existing = await prisma.user.findUnique({ where: { email: invitation.email } });
    if (existing) throw new AppError(409, "An account already exists for this email. Please log in to accept the invite.", "USER_ALREADY_EXISTS");
    await accountPolicyService.validateStaffInviteTargetEmail({
      businessId: invitation.businessId,
      targetEmail: invitation.email,
      actorUserId: invitation.invitedById,
      context: input.context,
    });
    const { firstName, lastName } = splitName(input.name);
    const user = await prisma.user.create({
      data: {
        firstName,
        lastName,
        email: invitation.email,
        passwordHash: await bcrypt.hash(input.password, 12),
        emailVerified: true,
        status: UserStatus.ACTIVE,
        accountType: UserAccountType.STAFF_ONLY,
        canCreateBusiness: false,
      },
    });
    await auditService.log({
      ...input.context,
      action: AuditAction.USER_ACCOUNT_TYPE_SET,
      businessId: invitation.businessId,
      userId: user.id,
      metadata: json({
        targetUserId: user.id,
        targetEmail: user.email,
        accountType: UserAccountType.STAFF_ONLY,
        canCreateBusiness: false,
        reason: "Invite signup",
      }),
    });
    const accepted = await finalizeAcceptance({ invitation, user, context: input.context, createdFromInvite: true });
    return {
      ...accepted,
      accessToken: tokenService.createAccessToken(user.id),
      refreshToken: await tokenService.createRefreshToken(user.id),
    };
  },
};
