import { AuditAction, BusinessRole, BusinessStatus, MembershipStatus, UserAccountType, UserStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { makeBusinessSlug } from "../utils/slug";
import { AuditInput, auditService } from "./audit.service";
import { canCreateBusiness } from "../middleware/subscription-guard";
import { getAccountUsage, getPlanFeatures, getPlanLimits, subscriptionService } from "./subscription.service";
import { accountPolicyService } from "./account-policy.service";
import { permissionFlags } from "./permission.service";
import { followUpService } from "./follow-up.service";

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
    await accountPolicyService.assertCanCreateBusiness(user, context);
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
          canManageKnowledgeHub: true,
        },
      });
      await tx.businessUsageRecord.create({
        data: {
          businessId: business.id,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
        },
      });
      await followUpService.seedDefaultRulesForBusiness(business.id, membership.id, tx);
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
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { accountType: true, canCreateBusiness: true } });
    const memberships = await prisma.businessMember.findMany({
      where: { userId, status: { not: MembershipStatus.REMOVED }, business: { deletedAt: null } },
      orderBy: { joinedAt: "asc" },
      select: {
        id: true,
        businessId: true,
        role: true,
        status: true,
        disabledAt: true,
        disabledReason: true,
        removedAt: true,
        removedReason: true,
        suspendedAt: true,
        suspendedReason: true,
        restoredAt: true,
        positionTitle: true,
        specialties: true,
        serviceTags: true,
        isAiHandoffEligible: true,
        canTakeAppointments: true,
        canManageKnowledgeHub: true,
        aiHandoffPriority: true,
        joinedAt: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        business: true,
      },
    });
    return {
      memberships: memberships.map((membership) => ({
        membershipId: membership.id,
        businessId: membership.businessId,
        businessName: membership.business.name,
        role: membership.role,
        status: membership.status,
        disabledAt: membership.disabledAt,
        disabledReason: membership.disabledReason,
        removedAt: membership.removedAt,
        removedReason: membership.removedReason,
        suspendedAt: membership.suspendedAt,
        suspendedReason: membership.suspendedReason,
        restoredAt: membership.restoredAt,
        positionTitle: membership.positionTitle,
        specialties: membership.specialties,
        serviceTags: membership.serviceTags,
        isAiHandoffEligible: membership.isAiHandoffEligible,
        canTakeAppointments: membership.canTakeAppointments,
        canManageKnowledgeHub: membership.canManageKnowledgeHub,
        aiHandoffPriority: membership.aiHandoffPriority,
        userId: membership.user.id,
        name: `${membership.user.firstName} ${membership.user.lastName}`.trim(),
        email: membership.user.email,
        accountType: user?.accountType ?? UserAccountType.OWNER_CAPABLE,
        canCreateBusiness: user?.canCreateBusiness ?? true,
        lastAccessedAt: null,
        business: membership.business,
        permissions: permissionFlags({
          role: membership.role,
          membershipStatus: membership.status,
          canCreateBusiness: user?.canCreateBusiness ?? true,
          canManageKnowledgeHub: membership.canManageKnowledgeHub,
        }),
      })),
    };
  },
};
