import { AuditAction, BusinessRole, InvitationStatus, MembershipStatus, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { canAddStaff } from "../middleware/subscription-guard";
import { createOpaqueToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import { accountPolicyService } from "./account-policy.service";
import { AuditInput, auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { emailService } from "./email.service";
import { realtimeService } from "./realtime.service";

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export type BusinessInvitationActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

export function assertCanManageBusinessInvitations(actor: Pick<BusinessInvitationActor, "role">) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
    throw new AppError(403, "You do not have permission to manage team invitations.", "FORBIDDEN");
  }
}

export async function lockBusinessInvitations(tx: Prisma.TransactionClient, businessId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('business_invitations'), hashtext(${businessId}))`;
}

async function assertActorBusinessContext(actor: BusinessInvitationActor) {
  const membership = await prisma.businessMember.findFirst({
    where: {
      id: actor.membershipId,
      userId: actor.userId,
      businessId: actor.businessId,
      role: actor.role,
      status: MembershipStatus.ACTIVE,
      business: { businessAccountId: actor.businessAccountId, deletedAt: null },
    },
    select: { id: true },
  });
  if (!membership) {
    throw new AppError(403, "You do not have access to invitations for this business.", "BUSINESS_MEMBERSHIP_NOT_FOUND");
  }
}

export async function invalidateBusinessTeamCaches(businessId: string, userId?: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:members:*`),
    cacheService.delByPattern(`business:${businessId}:team:*`),
    cacheService.delByPattern(`business:${businessId}:invites:*`),
    cacheService.delByPattern(`business:${businessId}:notifications:list:*`),
    cacheService.delByPattern(`business:${businessId}:notifications:counts:*`),
    ...(userId ? [
      cacheService.delByPattern(`user:${userId}:memberships:*`),
      cacheService.delByPattern(`user:${userId}:business-memberships*`),
    ] : []),
  ]);
}

function publishTeamUpdated(businessId: string) {
  realtimeService.publish({
    type: "business.team.updated",
    businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { businessId },
  });
}

const publicInvitationSelect = {
  id: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  acceptedAt: true,
  acceptedByUserId: true,
} satisfies Prisma.BusinessInvitationSelect;

export const businessInvitationManagementService = {
  async list(actor: BusinessInvitationActor) {
    assertCanManageBusinessInvitations(actor);
    await assertActorBusinessContext(actor);
    const invitations = await prisma.$transaction(async (tx) => {
      await lockBusinessInvitations(tx, actor.businessId);
      await tx.businessInvitation.updateMany({
        where: {
          businessId: actor.businessId,
          status: InvitationStatus.PENDING,
          expiresAt: { lte: new Date() },
        },
        data: { status: InvitationStatus.EXPIRED },
      });
      return tx.businessInvitation.findMany({
        where: { businessId: actor.businessId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: publicInvitationSelect,
      });
    }, TRANSACTION_OPTIONS);
    return { invitations };
  },

  async create(
    actor: BusinessInvitationActor,
    input: { email: string; role: "MANAGER" | "STAFF" },
    context: Omit<AuditInput, "action">,
  ) {
    assertCanManageBusinessInvitations(actor);
    await assertActorBusinessContext(actor);
    const role = input.role === "MANAGER" ? BusinessRole.MANAGER : BusinessRole.STAFF;
    if (actor.role === BusinessRole.MANAGER && role !== BusinessRole.STAFF) {
      throw new AppError(403, "Managers can only invite staff members.", "FORBIDDEN");
    }
    const business = await prisma.business.findFirst({
      where: { id: actor.businessId, businessAccountId: actor.businessAccountId, deletedAt: null },
      select: { id: true, name: true, businessAccountId: true },
    });
    if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");

    const inviteTarget = await accountPolicyService.validateStaffInviteTargetEmail({
      businessId: actor.businessId,
      targetEmail: input.email,
      actorUserId: actor.userId,
      context,
    });
    if (inviteTarget.user) {
      const membership = await prisma.businessMember.findUnique({
        where: { businessId_userId: { businessId: actor.businessId, userId: inviteTarget.user.id } },
      });
      if (membership && membership.status !== MembershipStatus.REMOVED) {
        throw new AppError(409, "This user is already a member of this business.", "USER_ALREADY_BUSINESS_MEMBER");
      }
    }

    await canAddStaff(actor.businessAccountId, actor.businessId);
    const { token, tokenHash } = createOpaqueToken();
    const invitation = await prisma.$transaction(async (tx) => {
      await lockBusinessInvitations(tx, actor.businessId);
      const now = new Date();
      await tx.businessInvitation.updateMany({
        where: { businessId: actor.businessId, status: InvitationStatus.PENDING, expiresAt: { lte: now } },
        data: { status: InvitationStatus.EXPIRED },
      });
      await tx.businessInvitation.updateMany({
        where: { businessId: actor.businessId, email: inviteTarget.email, status: InvitationStatus.PENDING },
        data: { status: InvitationStatus.REVOKED },
      });
      return tx.businessInvitation.create({
        data: {
          businessId: actor.businessId,
          email: inviteTarget.email,
          role,
          tokenHash,
          invitedById: actor.userId,
          expiresAt: new Date(now.getTime() + INVITATION_EXPIRY_MS),
        },
        select: publicInvitationSelect,
      });
    }, TRANSACTION_OPTIONS);

    const sent = await emailService.sendBusinessInvitation(inviteTarget.email, business.name, role, token);
    await Promise.all([
      invalidateBusinessTeamCaches(actor.businessId),
      auditService.log({
        ...context,
        action: AuditAction.STAFF_INVITED,
        businessId: actor.businessId,
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        metadata: { invitationId: invitation.id, email: inviteTarget.email, role, sent },
      }),
    ]);
    publishTeamUpdated(actor.businessId);
    return { invitation, emailSent: sent };
  },

  async revoke(
    actor: BusinessInvitationActor,
    invitationId: string,
    context: Omit<AuditInput, "action">,
  ) {
    assertCanManageBusinessInvitations(actor);
    await assertActorBusinessContext(actor);
    const result = await prisma.$transaction(async (tx) => {
      await lockBusinessInvitations(tx, actor.businessId);
      const invitation = await tx.businessInvitation.findFirst({
        where: { id: invitationId, businessId: actor.businessId },
        select: publicInvitationSelect,
      });
      if (!invitation) throw new AppError(404, "Invitation not found.", "BUSINESS_INVITATION_NOT_FOUND");
      if (actor.role === BusinessRole.MANAGER && invitation.role !== BusinessRole.STAFF) {
        throw new AppError(403, "Managers can only revoke staff invitations.", "FORBIDDEN");
      }
      if (invitation.status === InvitationStatus.REVOKED) return { invitation, changed: false };
      if (invitation.status !== InvitationStatus.PENDING) {
        throw new AppError(409, "Only pending invitations can be revoked.", "BUSINESS_INVITATION_NOT_REVOCABLE");
      }
      if (invitation.expiresAt <= new Date()) {
        const expired = await tx.businessInvitation.update({
          where: { id: invitation.id },
          data: { status: InvitationStatus.EXPIRED },
          select: publicInvitationSelect,
        });
        return { invitation: expired, changed: false };
      }
      const revoked = await tx.businessInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.REVOKED },
        select: publicInvitationSelect,
      });
      return { invitation: revoked, changed: true };
    }, TRANSACTION_OPTIONS);

    await invalidateBusinessTeamCaches(actor.businessId);
    if (result.changed) {
      await auditService.log({
        ...context,
        action: AuditAction.STAFF_INVITATION_REVOKED,
        businessId: actor.businessId,
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        metadata: { invitationId: result.invitation.id, email: result.invitation.email },
      });
      publishTeamUpdated(actor.businessId);
    }
    return { invitation: result.invitation };
  },
};
