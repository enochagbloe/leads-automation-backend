import { AuditAction, BusinessRole, BusinessStatus, InvitationStatus, MembershipStatus, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../config/prisma";
import { createOpaqueToken, hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import { makeBusinessSlug } from "../utils/slug";
import { AuditInput, auditService } from "./audit.service";
import { emailService } from "./email.service";
import { canAddStaff, canCreateBusiness, updateStaffUsage } from "../middleware/subscription-guard";
import { getAccountUsage, getPlanFeatures, getPlanLimits, subscriptionService } from "./subscription.service";

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export const businessService = {
  async create(
    userId: string,
    businessAccountId: string | null,
    input: { name: string; industry: string; email?: string; phone?: string },
    context: Omit<AuditInput, "action">,
  ) {
    const [user, account] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      businessAccountId
        ? prisma.businessAccount.findFirst({ where: { id: businessAccountId, ownerId: userId } })
        : null,
    ]);
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
      throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    }
    if (!account) throw new AppError(403, "Only a workspace owner can create businesses", "BUSINESS_ACCOUNT_REQUIRED");
    await canCreateBusiness(account.id);
    const subscription = await subscriptionService.getCurrentRecord(account.id);
    const usage = subscription.usageRecords[0];
    if (!usage) throw new AppError(500, "Current account usage record is unavailable");
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const usageIncrement = subscription.plan.maxBusinesses === null
        ? await tx.accountUsageRecord.updateMany({
          where: { id: usage.id },
          data: { businessesCount: { increment: 1 } },
        })
        : await tx.accountUsageRecord.updateMany({
          where: { id: usage.id, businessesCount: { lt: subscription.plan.maxBusinesses } },
          data: { businessesCount: { increment: 1 } },
        });
      if (usageIncrement.count !== 1) {
        throw new AppError(409, "Business creation limit was reached by another request. Please retry.", "PLAN_LIMIT_REACHED", {
          currentPlan: subscription.plan.code,
          recommendedPlan: subscription.plan.code === "BASIC" ? "PLUS" : "PREMIUM",
        });
      }
      const business = await tx.business.create({
        data: {
          businessAccountId: account.id,
          name: input.name,
          industry: input.industry,
          slug: makeBusinessSlug(input.name),
          ownerId: userId,
          email: input.email ?? user.email,
          phone: input.phone,
          status: BusinessStatus.ACTIVE,
        },
      });
      const membership = await tx.businessMember.create({
        data: {
          userId,
          businessId: business.id,
          role: BusinessRole.BUSINESS_OWNER,
          status: MembershipStatus.ACTIVE,
          joinedAt: now,
        },
      });
      await tx.businessUsageRecord.create({
        data: {
          businessId: business.id,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
        },
      });
      const accountUsage = await tx.accountUsageRecord.findUniqueOrThrow({ where: { id: usage.id } });
      return { business, membership, accountUsage };
    });

    await Promise.all([
      auditService.log({ ...context, action: AuditAction.BUSINESS_CREATED, userId, businessId: result.business.id }),
      auditService.log({ ...context, action: AuditAction.USAGE_RECORD_UPDATED, userId, businessId: result.business.id, metadata: { businessAccountId: account.id, usageKey: "businessesCount", currentValue: result.accountUsage.businessesCount } }),
    ]);

    return {
      account,
      business: result.business,
      message: "Business created successfully",
      membership: {
        id: result.membership.id,
        role: result.membership.role,
        status: result.membership.status,
        joinedAt: result.membership.joinedAt,
      },
      subscription: {
        id: subscription.id,
        plan: subscription.plan.code,
        status: subscription.status,
        accountUsage: getAccountUsage(result.accountUsage),
        limits: getPlanLimits(subscription.plan),
        features: getPlanFeatures(subscription.plan),
        startsAt: subscription.startsAt,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
    };
  },

  async listMemberships(userId: string) {
    return prisma.businessMember.findMany({
      where: { userId, status: MembershipStatus.ACTIVE },
      orderBy: { joinedAt: "asc" },
      select: {
        id: true,
        role: true,
        status: true,
        joinedAt: true,
        business: true,
      },
    });
  },

  async inviteMember(
    businessId: string,
    invitedById: string,
    input: { email: string; role: "MANAGER" | "STAFF" },
    context: Omit<AuditInput, "action">,
  ) {
    const role = input.role === "MANAGER" ? BusinessRole.MANAGER : BusinessRole.STAFF;
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");

    const existingUser = await prisma.user.findUnique({ where: { email: input.email } });
    if (existingUser) {
      const membership = await prisma.businessMember.findUnique({
        where: { businessId_userId: { businessId, userId: existingUser.id } },
      });
      if (membership && membership.status !== MembershipStatus.REMOVED) {
        throw new AppError(409, "This user already belongs to the business", "MEMBERSHIP_EXISTS");
      }
    }

    await canAddStaff(business.businessAccountId, businessId);
    const { token, tokenHash } = createOpaqueToken();
    await prisma.businessInvitation.updateMany({
      where: { businessId, email: input.email, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED },
    });
    const invitation = await prisma.businessInvitation.create({
      data: {
        businessId,
        email: input.email,
        role,
        tokenHash,
        invitedById,
        expiresAt: new Date(Date.now() + INVITATION_EXPIRY_MS),
      },
    });
    const sent = await emailService.sendBusinessInvitation(input.email, business.name, role, token);
    await auditService.log({
      ...context,
      action: AuditAction.STAFF_INVITED,
      businessId,
      userId: invitedById,
      metadata: { invitationId: invitation.id, email: input.email, role, sent },
    });
    return {
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt },
      emailSent: sent,
    };
  },

  async acceptInvitation(
    input: { token: string; firstName?: string; lastName?: string; password?: string },
    context: Omit<AuditInput, "action">,
  ) {
    const invitation = await prisma.businessInvitation.findUnique({ where: { tokenHash: hashToken(input.token) } });
    if (!invitation || invitation.status !== InvitationStatus.PENDING || invitation.expiresAt <= new Date()) {
      throw new AppError(400, "Invalid or expired business invitation", "INVALID_INVITATION");
    }

    const invitedBusiness = await prisma.business.findUnique({ where: { id: invitation.businessId } });
    if (!invitedBusiness) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
    await canAddStaff(invitedBusiness.businessAccountId, invitation.businessId);
    let user = await prisma.user.findUnique({ where: { email: invitation.email } });
    if (!user) {
      if (!input.firstName || !input.lastName || !input.password) {
        throw new AppError(422, "First name, last name, and password are required for a new account", "INVITEE_ACCOUNT_DETAILS_REQUIRED");
      }
      user = await prisma.user.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: invitation.email,
          passwordHash: await bcrypt.hash(input.password, 12),
          emailVerified: true,
          status: UserStatus.ACTIVE,
        },
      });
    } else {
      if (user.status !== UserStatus.ACTIVE || user.deletedAt) {
        throw new AppError(403, "This user account is disabled", "ACCOUNT_DISABLED");
      }
      if (!user.emailVerified) {
        user = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
      }
    }

    const now = new Date();
    const membership = await prisma.$transaction(async (tx) => {
      const member = await tx.businessMember.upsert({
        where: { businessId_userId: { businessId: invitation.businessId, userId: user!.id } },
        create: {
          businessId: invitation.businessId,
          userId: user!.id,
          role: invitation.role,
          status: MembershipStatus.ACTIVE,
          joinedAt: now,
          invitedById: invitation.invitedById,
        },
        update: {
          role: invitation.role,
          status: MembershipStatus.ACTIVE,
          joinedAt: now,
          invitedById: invitation.invitedById,
        },
      });
      await tx.businessInvitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.ACCEPTED, acceptedAt: now },
      });
      return member;
    });
    await updateStaffUsage(invitedBusiness.businessAccountId, 1, invitation.businessId);
    await auditService.log({
      ...context,
      action: AuditAction.STAFF_INVITATION_ACCEPTED,
      businessId: invitation.businessId,
      userId: user.id,
      metadata: { invitationId: invitation.id, membershipId: membership.id, role: membership.role },
    });
    return { message: "Business invitation accepted", membership };
  },
};
