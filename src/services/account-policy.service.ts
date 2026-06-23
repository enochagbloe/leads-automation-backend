import { AuditAction, BusinessRole, MembershipStatus, Prisma, User, UserAccountType } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { AuditInput, auditService } from "./audit.service";

type UserForBusinessCreation = Pick<User, "id" | "email" | "accountType" | "canCreateBusiness">;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export const accountPolicyService = {
  async assertCanCreateBusiness(user: UserForBusinessCreation, context: Omit<AuditInput, "action">) {
    if (user.accountType === UserAccountType.OWNER_CAPABLE && user.canCreateBusiness) return;
    await auditService.log({
      ...context,
      action: AuditAction.BUSINESS_CREATION_BLOCKED_FOR_STAFF_ACCOUNT,
      userId: user.id,
      metadata: json({
        actorUserId: user.id,
        targetEmail: user.email,
        accountType: user.accountType,
        canCreateBusiness: user.canCreateBusiness,
        reason: "Staff-only account cannot create business",
      }),
    });
    throw new AppError(
      403,
      "This account was created as a staff account. Staff accounts cannot create businesses.",
      "STAFF_ACCOUNT_CANNOT_CREATE_BUSINESS",
      { accountType: user.accountType, canCreateBusiness: user.canCreateBusiness },
    );
  },

  async validateStaffInviteTargetEmail(input: {
    businessId: string;
    targetEmail: string;
    actorUserId: string;
    context: Omit<AuditInput, "action">;
  }) {
    const email = input.targetEmail.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          where: { status: { not: MembershipStatus.REMOVED } },
          include: { business: { select: { id: true, status: true, deletedAt: true } } },
        },
      },
    });
    if (!user) return { email, user: null };

    const existingMembership = user.memberships.find((membership) => membership.businessId === input.businessId);
    if (existingMembership) {
      throw new AppError(409, "This user is already a member of this business.", "USER_ALREADY_BUSINESS_MEMBER");
    }

    const hasActiveOwnerBusiness = user.memberships.some((membership) =>
      membership.role === BusinessRole.BUSINESS_OWNER
      && membership.status === MembershipStatus.ACTIVE
      && !membership.business.deletedAt);

    if (hasActiveOwnerBusiness) {
      await auditService.log({
        ...input.context,
        action: AuditAction.STAFF_INVITE_BLOCKED_OWNER_EMAIL,
        businessId: input.businessId,
        userId: input.actorUserId,
        metadata: json({
          actorUserId: input.actorUserId,
          targetUserId: user.id,
          targetEmail: email,
          accountType: user.accountType,
          reason: "Invited email already belongs to an active business owner",
        }),
      });
      throw new AppError(
        409,
        "This email is already linked to a verified business account. Please invite a staff email instead.",
        "INVITED_EMAIL_ALREADY_BUSINESS_OWNER",
      );
    }

    return { email, user };
  },
};
