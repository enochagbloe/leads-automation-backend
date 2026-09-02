import { prisma } from "../../src/config/prisma";

async function main() {
  if (process.env.CI !== "true") throw new Error("This fixture is only for an isolated CI database.");
  const user = await prisma.user.create({ data: {
    firstName: "CI", lastName: "Owner", email: "ci-owner@example.invalid", passwordHash: "not-a-login-password",
  } });
  const account = await prisma.businessAccount.create({ data: { name: "CI account", ownerId: user.id } });
  const business = await prisma.business.create({ data: {
    businessAccountId: account.id, ownerId: user.id, name: "CI clinic", industry: "Healthcare", slug: "ci-clinic", status: "ACTIVE",
  } });
  await prisma.businessMember.create({ data: { businessId: business.id, userId: user.id, role: "BUSINESS_OWNER", status: "ACTIVE", canManageKnowledgeHub: true } });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { code: "PREMIUM" } });
  await prisma.subscription.create({ data: {
    businessAccountId: account.id, planId: plan.id, status: "ACTIVE",
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
  } });
}
main().finally(() => prisma.$disconnect()).catch((error) => { console.error(error); process.exitCode = 1; });
