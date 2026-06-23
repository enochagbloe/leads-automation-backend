import { AuditAction, AuthTokenType, BusinessRole, MembershipStatus, PlanCode, PlatformRole, SubscriptionStatus, UserAccountType, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { prisma } from "../config/prisma";
import { createOpaqueToken, hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import { makeBusinessSlug } from "../utils/slug";
import { auditService, AuditInput } from "./audit.service";
import { emailService } from "./email.service";
import { getAccountUsage, getBusinessUsage, getPlanFeatures, getPlanLimits, subscriptionService } from "./subscription.service";
import { tokenService } from "./token.service";

const VERIFY_EXPIRY_MS = 24 * 60 * 60 * 1000;
const RESET_EXPIRY_MS = 30 * 60 * 1000;
const publicUser = (user: { id: string; firstName: string; lastName: string; email: string; emailVerified: boolean; status: UserStatus; accountType: UserAccountType; canCreateBusiness: boolean; createdAt: Date }) => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  emailVerified: user.emailVerified,
  status: user.status,
  accountType: user.accountType,
  canCreateBusiness: user.canCreateBusiness,
  createdAt: user.createdAt,
});

async function getUserBusinessContext(userId: string) {
  const membership = await prisma.businessMember.findFirst({
    where: { userId, status: MembershipStatus.ACTIVE },
    orderBy: { joinedAt: "asc" },
    include: { business: true },
  });
  return { business: membership?.business ?? null, membership };
}

function permissionList(role?: BusinessRole | PlatformRole) {
  if (role === PlatformRole.PLATFORM_ADMIN) return ["platform:admin"];
  if (role === BusinessRole.BUSINESS_OWNER) return ["business:manage", "subscription:manage", "members:manage", "leads:view_all", "leads:create", "leads:update_all", "leads:assign", "leads:delete", "conversations:view_all", "conversations:create", "conversations:send", "conversations:assign", "conversations:update_status", "conversations:delete"];
  if (role === BusinessRole.MANAGER) return ["business:manage", "members:view", "leads:view_all", "leads:create", "leads:update_all", "leads:assign", "leads:delete", "conversations:view_all", "conversations:create", "conversations:send", "conversations:assign", "conversations:update_status", "conversations:delete"];
  if (role === BusinessRole.STAFF) return ["business:view", "leads:view_assigned", "leads:create", "leads:update_assigned", "conversations:view_assigned", "conversations:create_assigned", "conversations:send_assigned", "conversations:update_status_assigned"];
  return [];
}

export const authService = {
  async register(input: { firstName: string; lastName: string; email: string; password: string; businessName: string; industry: string }, context: Omit<AuditInput, "action">) {
    if (await prisma.user.findUnique({ where: { email: input.email } })) {
      throw new AppError(409, "An account with this email already exists", "EMAIL_EXISTS");
    }
    if (await prisma.businessInvitation.findFirst({ where: { email: input.email, status: "PENDING", expiresAt: { gt: new Date() } } })) {
      throw new AppError(409, "A business invitation is pending for this email. Accept the invitation instead of creating a new business.", "INVITATION_PENDING");
    }
    const basicPlan = await prisma.plan.findUnique({ where: { code: PlanCode.BASIC } });
    if (!basicPlan) throw new AppError(503, "Default plan is unavailable", "PLAN_NOT_CONFIGURED");

    const passwordHash = await bcrypt.hash(input.password, 12);
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    const trialEndsAt = new Date(now.getTime() + 14 * 86_400_000);
    const { token, tokenHash } = createOpaqueToken();

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { firstName: input.firstName, lastName: input.lastName, email: input.email, passwordHash } });
      const account = await tx.businessAccount.create({ data: { name: `${input.businessName} Workspace`, ownerId: user.id } });
      const business = await tx.business.create({ data: { businessAccountId: account.id, name: input.businessName, industry: input.industry, slug: makeBusinessSlug(input.businessName), ownerId: user.id, email: input.email } });
      await tx.businessMember.create({ data: { userId: user.id, businessId: business.id, role: BusinessRole.BUSINESS_OWNER, status: MembershipStatus.ACTIVE, joinedAt: now } });
      const subscription = await tx.subscription.create({ data: { businessAccountId: account.id, planId: basicPlan.id, status: SubscriptionStatus.TRIALING, startsAt: now, trialEndsAt, currentPeriodStart: now, currentPeriodEnd: periodEnd } });
      await tx.accountUsageRecord.create({ data: { businessAccountId: account.id, subscriptionId: subscription.id, businessesCount: 1, staffCount: 1, periodStart: now, periodEnd } });
      await tx.businessUsageRecord.create({ data: { businessId: business.id, periodStart: now, periodEnd } });
      await tx.authToken.create({ data: { userId: user.id, type: AuthTokenType.EMAIL_VERIFICATION, tokenHash, expiresAt: new Date(Date.now() + VERIFY_EXPIRY_MS) } });
      return { user, account, business, subscription };
    });

    const verificationSent = await emailService.sendVerification(input.email, input.businessName, token);
    await Promise.all([
      auditService.log({ ...context, action: AuditAction.USER_REGISTERED, userId: result.user.id, businessId: result.business.id }),
      auditService.log({
        ...context,
        action: AuditAction.USER_ACCOUNT_TYPE_SET,
        userId: result.user.id,
        businessId: result.business.id,
        metadata: {
          targetUserId: result.user.id,
          targetEmail: result.user.email,
          accountType: UserAccountType.OWNER_CAPABLE,
          canCreateBusiness: true,
          reason: "Normal owner registration",
        },
      }),
      ...(verificationSent ? [auditService.log({ ...context, action: AuditAction.EMAIL_VERIFICATION_SENT, userId: result.user.id, businessId: result.business.id })] : []),
      auditService.log({ ...context, action: AuditAction.SUBSCRIPTION_CREATED, userId: result.user.id, businessId: result.business.id }),
      auditService.log({ ...context, action: AuditAction.PLAN_ASSIGNED, userId: result.user.id, businessId: result.business.id, metadata: { plan: PlanCode.BASIC } }),
    ]);
    return { user: publicUser(result.user), business: result.business, message: "Registration successful. Check your email to verify your account." };
  },

  async verifyEmail(token: string, context: Omit<AuditInput, "action">) {
    const stored = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored || stored.type !== AuthTokenType.EMAIL_VERIFICATION || stored.usedAt || stored.expiresAt <= new Date()) {
      throw new AppError(400, "Invalid or expired verification token", "INVALID_TOKEN");
    }
    await prisma.$transaction([
      prisma.authToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: stored.userId }, data: { emailVerified: true } }),
      prisma.business.updateMany({ where: { ownerId: stored.userId, status: "PENDING_SETUP" }, data: { status: "ACTIVE" } }),
    ]);
    const { business } = await getUserBusinessContext(stored.userId);
    await auditService.log({ ...context, action: AuditAction.EMAIL_VERIFIED, userId: stored.userId, businessId: business?.id });
    return { message: "Email verified successfully" };
  },

  async resendVerification(email: string, context: Omit<AuditInput, "action">) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerified) return { message: "If the account requires verification, an email has been sent." };
    const { business } = await getUserBusinessContext(user.id);
    const token = await tokenService.createAuthToken(user.id, AuthTokenType.EMAIL_VERIFICATION, VERIFY_EXPIRY_MS);
    const sent = await emailService.sendVerification(user.email, business?.name ?? user.firstName, token);
    if (sent) await auditService.log({ ...context, action: AuditAction.EMAIL_VERIFICATION_SENT, userId: user.id, businessId: business?.id });
    return { message: "If the account requires verification, an email has been sent." };
  },

  async login(email: string, password: string, context: Omit<AuditInput, "action">) {
    const user = await prisma.user.findUnique({ where: { email } });
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !valid) {
      await auditService.log({ ...context, action: AuditAction.LOGIN_FAILED, metadata: { email } });
      throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }
    if (user.status !== UserStatus.ACTIVE || user.deletedAt) throw new AppError(403, "Account is disabled", "ACCOUNT_DISABLED");
    if (!user.emailVerified) throw new AppError(403, "Verify your email before logging in", "EMAIL_NOT_VERIFIED");
    const profile = await this.getProfile(user.id);
    const tokens = { accessToken: tokenService.createAccessToken(user.id), refreshToken: await tokenService.createRefreshToken(user.id) };
    await auditService.log({ ...context, action: AuditAction.LOGIN_SUCCESS, userId: user.id, businessId: profile.activeBusiness?.id });
    return { ...tokens, ...profile };
  },

  async forgotPassword(email: string, context: Omit<AuditInput, "action">) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user?.status === UserStatus.ACTIVE) {
      const { business } = await getUserBusinessContext(user.id);
      const token = await tokenService.createAuthToken(user.id, AuthTokenType.PASSWORD_RESET, RESET_EXPIRY_MS);
      await emailService.sendPasswordReset(user.email, business?.name ?? user.firstName, token);
      await auditService.log({ ...context, action: AuditAction.PASSWORD_RESET_REQUESTED, userId: user.id, businessId: business?.id });
    }
    return { message: "If an account exists for that email, a password reset link has been sent." };
  },

  async resetPassword(token: string, password: string, context: Omit<AuditInput, "action">) {
    const stored = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored || stored.type !== AuthTokenType.PASSWORD_RESET || stored.usedAt || stored.expiresAt <= new Date()) {
      throw new AppError(400, "Invalid or expired reset token", "INVALID_TOKEN");
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.$transaction([
      prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
      prisma.authToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    const { business } = await getUserBusinessContext(stored.userId);
    await auditService.log({ ...context, action: AuditAction.PASSWORD_RESET_COMPLETED, userId: stored.userId, businessId: business?.id });
    return { message: "Password reset successfully" };
  },

  async getProfile(userId: string, activeBusinessId?: string | null) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          where: {
            status: MembershipStatus.ACTIVE,
          },
          include: { business: { include: { businessAccount: true } } },
          orderBy: { joinedAt: "asc" },
        },
      },
    });
    if (!user) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    const membership = activeBusinessId
      ? user.memberships.find((item) => item.businessId === activeBusinessId)
      : user.memberships[0];
    const role = user.platformRole ?? membership?.role;
    const activeBusiness = membership?.business ?? null;
    const account = activeBusiness?.businessAccount ?? null;
    const subscription = account ? await subscriptionService.getCurrentRecord(account.id) : null;
    const businessUsage = activeBusiness
      ? await prisma.businessUsageRecord.findFirst({ where: { businessId: activeBusiness.id }, orderBy: { periodStart: "desc" } })
      : null;
    const businesses = account
      ? user.memberships
        .filter((item) => item.business.businessAccountId === account.id)
        .map((item) => item.business)
      : [];
    return {
      user: publicUser(user),
      account,
      businesses,
      activeBusiness,
      membership: membership ? {
        id: membership.id,
        role: membership.role,
        status: membership.status,
        joinedAt: membership.joinedAt,
      } : null,
      role,
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        startsAt: subscription.startsAt,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
      } : null,
      plan: subscription ? {
        id: subscription.plan.id,
        code: subscription.plan.code,
        name: subscription.plan.name,
        priceMonthly: subscription.plan.priceMonthly,
        currency: subscription.plan.currency,
        limits: getPlanLimits(subscription.plan),
        features: getPlanFeatures(subscription.plan),
      } : null,
      accountUsage: subscription ? getAccountUsage(subscription.usageRecords[0]) : null,
      businessUsage: getBusinessUsage(businessUsage ?? undefined),
      limits: subscription ? getPlanLimits(subscription.plan) : null,
      features: subscription ? getPlanFeatures(subscription.plan) : null,
      permissions: permissionList(role),
    };
  },
};
