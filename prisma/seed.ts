import { PlanCode, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const plans = [
  {
    code: PlanCode.BASIC,
    name: "Basic",
    priceMonthly: 99,
    currency: "GHS",
    maxStaff: 2,
    maxServices: 5,
    maxAppointmentsPerMonth: 100,
    maxConversationsPerMonth: 500,
    maxAiRepliesPerMonth: 500,
    maxKnowledgeItems: 20,
    maxBusinesses: 1,
    allowAnalytics: false,
    allowRemoveBranding: false,
    allowPrioritySupport: false,
  },
  {
    code: PlanCode.PLUS,
    name: "Plus",
    priceMonthly: 199,
    currency: "GHS",
    maxStaff: 5,
    maxServices: 20,
    maxAppointmentsPerMonth: 500,
    maxConversationsPerMonth: 2000,
    maxAiRepliesPerMonth: 2000,
    maxKnowledgeItems: 100,
    maxBusinesses: 5,
    allowAnalytics: true,
    allowRemoveBranding: false,
    allowPrioritySupport: false,
  },
  {
    code: PlanCode.PREMIUM,
    name: "Premium",
    priceMonthly: 399,
    currency: "GHS",
    maxStaff: null,
    maxServices: 100,
    maxAppointmentsPerMonth: null,
    maxConversationsPerMonth: 10000,
    maxAiRepliesPerMonth: 10000,
    maxKnowledgeItems: null,
    maxBusinesses: 10,
    allowAnalytics: true,
    allowRemoveBranding: true,
    allowPrioritySupport: true,
  },
];

async function main() {
  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan,
    });
  }
}

main()
  .finally(async () => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
