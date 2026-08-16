import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  BusinessRole,
  BusinessStatus,
  InvitationStatus,
  MembershipStatus,
  PlanCode,
  SubscriptionStatus,
  UserAccountType,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { validateAssignee } from "../src/services/appointment/appointment-validation.service";
import { businessInviteAcceptanceService } from "../src/services/business-invite-acceptance.service";
import { businessInvitationManagementService } from "../src/services/business-invitation-management.service";
import { businessMemberAccessService } from "../src/services/business-member-access.service";
import { hashToken } from "../src/utils/crypto";

test("business invitations activate one assignable membership and remain tenant-scoped", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const suffix = crypto.randomUUID();
  const emails = {
    owner: `invite-owner-${suffix}@example.com`,
    newUser: `invite-new-${suffix}@example.com`,
    existingUser: `invite-existing-${suffix}@example.com`,
  };
  const plan = await prisma.plan.findUnique({ where: { code: PlanCode.PREMIUM } });
  assert.ok(plan, "The Premium plan must be seeded before this integration test runs.");
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  let businessId: string | null = null;
  let otherBusinessId: string | null = null;
  let businessAccountId: string | null = null;

  try {
    const owner = await prisma.user.create({
      data: {
        firstName: "Invite",
        lastName: "Owner",
        email: emails.owner,
        passwordHash: "integration-test-only",
        emailVerified: true,
        accountType: UserAccountType.OWNER_CAPABLE,
      },
    });
    const account = await prisma.businessAccount.create({ data: { name: `Invite Account ${suffix}`, ownerId: owner.id } });
    businessAccountId = account.id;
    const business = await prisma.business.create({
      data: {
        businessAccountId: account.id,
        ownerId: owner.id,
        name: `Invite Business ${suffix}`,
        industry: "Testing",
        slug: `invite-business-${suffix}`,
        status: BusinessStatus.ACTIVE,
        email: emails.owner,
      },
    });
    businessId = business.id;
    const otherBusiness = await prisma.business.create({
      data: {
        businessAccountId: account.id,
        ownerId: owner.id,
        name: `Other Invite Business ${suffix}`,
        industry: "Testing",
        slug: `other-invite-business-${suffix}`,
        status: BusinessStatus.ACTIVE,
        email: emails.owner,
      },
    });
    otherBusinessId = otherBusiness.id;
    const ownerMembership = await prisma.businessMember.create({
      data: {
        businessId: business.id,
        userId: owner.id,
        role: BusinessRole.BUSINESS_OWNER,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
      },
    });
    await prisma.businessMember.create({
      data: {
        businessId: otherBusiness.id,
        userId: owner.id,
        role: BusinessRole.BUSINESS_OWNER,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        businessAccountId: account.id,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });
    await prisma.accountUsageRecord.create({
      data: {
        businessAccountId: account.id,
        subscriptionId: subscription.id,
        businessesCount: 2,
        staffCount: 1,
        periodStart: now,
        periodEnd,
      },
    });
    const actor = {
      userId: owner.id,
      businessAccountId: account.id,
      businessId: business.id,
      membershipId: ownerMembership.id,
      role: BusinessRole.BUSINESS_OWNER,
    };

    const newUserToken = crypto.randomBytes(32).toString("hex");
    const newUserInvitation = await prisma.businessInvitation.create({
      data: {
        businessId: business.id,
        email: emails.newUser,
        role: BusinessRole.STAFF,
        status: InvitationStatus.PENDING,
        tokenHash: hashToken(newUserToken),
        invitedById: owner.id,
        expiresAt: periodEnd,
      },
    });
    const newUserAcceptance = await businessInviteAcceptanceService.signupAndAcceptInvite({
      token: newUserToken,
      name: "New Invitee",
      password: "Pass123$integration",
      context: {},
    });
    assert.equal(newUserAcceptance.accepted, true);
    const createdUser = await prisma.user.findUniqueOrThrow({ where: { email: emails.newUser } });
    const createdMembership = await prisma.businessMember.findUniqueOrThrow({
      where: { businessId_userId: { businessId: business.id, userId: createdUser.id } },
    });
    assert.equal(createdMembership.status, MembershipStatus.ACTIVE);
    assert.equal(createdMembership.role, BusinessRole.STAFF);
    assert.ok(createdMembership.joinedAt);
    const acceptedNewUserInvite = await prisma.businessInvitation.findUniqueOrThrow({ where: { id: newUserInvitation.id } });
    assert.equal(acceptedNewUserInvite.status, InvitationStatus.ACCEPTED);
    assert.equal(acceptedNewUserInvite.acceptedByUserId, createdUser.id);
    assert.ok(acceptedNewUserInvite.acceptedAt);

    const existingUser = await prisma.user.create({
      data: {
        firstName: "Existing",
        lastName: "Invitee",
        email: emails.existingUser,
        passwordHash: "integration-test-only",
        emailVerified: true,
        accountType: UserAccountType.STAFF_ONLY,
        canCreateBusiness: false,
      },
    });
    await prisma.businessMember.create({
      data: {
        businessId: otherBusiness.id,
        userId: existingUser.id,
        role: BusinessRole.STAFF,
        status: MembershipStatus.ACTIVE,
        joinedAt: now,
      },
    });
    const existingUserToken = crypto.randomBytes(32).toString("hex");
    const existingInvitation = await prisma.businessInvitation.create({
      data: {
        businessId: business.id,
        email: emails.existingUser,
        role: BusinessRole.MANAGER,
        status: InvitationStatus.PENDING,
        tokenHash: hashToken(existingUserToken),
        invitedById: owner.id,
        expiresAt: periodEnd,
      },
    });
    const concurrentResults = await Promise.all([
      businessInviteAcceptanceService.acceptInviteForExistingUser({ token: existingUserToken, actorUserId: existingUser.id, context: {} }),
      businessInviteAcceptanceService.acceptInviteForExistingUser({ token: existingUserToken, actorUserId: existingUser.id, context: {} }),
    ]);
    assert.equal(new Set(concurrentResults.map((result) => result.membership.id)).size, 1);
    assert.equal(concurrentResults.filter((result) => result.idempotentReplay).length, 1);
    assert.equal(await prisma.businessMember.count({ where: { businessId: business.id, userId: existingUser.id } }), 1);

    const usage = await prisma.accountUsageRecord.findUniqueOrThrow({
      where: { subscriptionId_periodStart: { subscriptionId: subscription.id, periodStart: now } },
    });
    assert.equal(usage.staffCount, 3);

    const expiredInvitation = await prisma.businessInvitation.create({
      data: {
        businessId: business.id,
        email: `expired-${suffix}@example.com`,
        role: BusinessRole.STAFF,
        tokenHash: hashToken(crypto.randomBytes(32).toString("hex")),
        invitedById: owner.id,
        expiresAt: new Date(now.getTime() - 1_000),
      },
    });
    const revokedInvitation = await prisma.businessInvitation.create({
      data: {
        businessId: business.id,
        email: `revoked-${suffix}@example.com`,
        role: BusinessRole.STAFF,
        tokenHash: hashToken(crypto.randomBytes(32).toString("hex")),
        invitedById: owner.id,
        expiresAt: periodEnd,
      },
    });
    const revoked = await businessInvitationManagementService.revoke(actor, revokedInvitation.id, {});
    assert.equal(revoked.invitation.status, InvitationStatus.REVOKED);

    const invitationList = await businessInvitationManagementService.list(actor);
    assert.equal(invitationList.invitations.find((invite) => invite.id === newUserInvitation.id)?.status, InvitationStatus.ACCEPTED);
    assert.equal(invitationList.invitations.find((invite) => invite.id === existingInvitation.id)?.status, InvitationStatus.ACCEPTED);
    assert.equal(invitationList.invitations.filter((invite) => invite.status === InvitationStatus.PENDING).length, 0);
    assert.equal(invitationList.invitations.find((invite) => invite.id === expiredInvitation.id)?.status, InvitationStatus.EXPIRED);

    const team = await businessMemberAccessService.listMembers(actor) as { members: Array<{ membershipId: string; canReceiveAssignedWork: boolean }> };
    assert.ok(team.members.some((member) => member.membershipId === createdMembership.id && member.canReceiveAssignedWork));
    const assignmentTarget = await validateAssignee(business.id, createdMembership.id);
    assert.equal(assignmentTarget?.id, createdMembership.id);
    assert.equal((await validateAssignee(business.id, ownerMembership.id))?.id, ownerMembership.id);
    const managerMembership = await prisma.businessMember.findUniqueOrThrow({
      where: { businessId_userId: { businessId: business.id, userId: existingUser.id } },
    });
    assert.equal((await validateAssignee(business.id, managerMembership.id))?.id, managerMembership.id);

    const managerInvitations = await businessInvitationManagementService.list({
      userId: existingUser.id,
      businessAccountId: account.id,
      businessId: business.id,
      membershipId: managerMembership.id,
      role: BusinessRole.MANAGER,
    });
    assert.equal(managerInvitations.invitations.length, invitationList.invitations.length);

    await businessMemberAccessService.disableMember(actor, managerMembership.id, { reason: "distinct-user quota test" }, {});
    let lifecycleUsage = await prisma.accountUsageRecord.findUniqueOrThrow({
      where: { subscriptionId_periodStart: { subscriptionId: subscription.id, periodStart: now } },
    });
    assert.equal(lifecycleUsage.staffCount, 3);
    await businessMemberAccessService.restoreDisabledMember(actor, managerMembership.id, {});
    lifecycleUsage = await prisma.accountUsageRecord.findUniqueOrThrow({
      where: { subscriptionId_periodStart: { subscriptionId: subscription.id, periodStart: now } },
    });
    assert.equal(lifecycleUsage.staffCount, 3);

    const staffTeam = await businessMemberAccessService.listMembers({
      userId: createdUser.id,
      businessAccountId: account.id,
      businessId: business.id,
      membershipId: createdMembership.id,
      role: BusinessRole.STAFF,
    }) as { members: Array<{ membershipId: string }> };
    assert.deepEqual(staffTeam.members.map((member) => member.membershipId), [createdMembership.id]);
    await assert.rejects(
      businessInvitationManagementService.list({
        userId: createdUser.id,
        businessAccountId: account.id,
        businessId: business.id,
        membershipId: createdMembership.id,
        role: BusinessRole.STAFF,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "FORBIDDEN",
    );

    await assert.rejects(
      businessInvitationManagementService.list({ ...actor, businessId: otherBusiness.id }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BUSINESS_MEMBERSHIP_NOT_FOUND",
    );
  } finally {
    if (otherBusinessId) await prisma.business.deleteMany({ where: { id: otherBusinessId } });
    if (businessId) await prisma.business.deleteMany({ where: { id: businessId } });
    if (businessAccountId) await prisma.businessAccount.deleteMany({ where: { id: businessAccountId } });
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  }
});
