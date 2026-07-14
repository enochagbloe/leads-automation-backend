import { PlanCode, Prisma } from "@prisma/client";
import { AppError } from "../../utils/errors";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "./appointment.constants";
import { AppointmentActor } from "./appointment.types";

function appointmentLimitError(plan: { code: PlanCode; name: string; maxAppointmentsPerMonth: number | null }, current: number) {
  const recommendedPlan = plan.code === PlanCode.BASIC ? PlanCode.PLUS : plan.code === PlanCode.PLUS ? PlanCode.PREMIUM : null;
  return new AppError(
    403,
    `Your current plan allows up to ${plan.maxAppointmentsPerMonth} appointments per month. Upgrade to create more appointments.`,
    "APPOINTMENT_LIMIT_REACHED",
    { currentPlan: plan.code, recommendedPlan, limit: plan.maxAppointmentsPerMonth, current },
  );
}

export async function incrementAppointmentUsage(tx: Prisma.TransactionClient, actor: AppointmentActor) {
  const subscription = await tx.subscription.findFirst({
    where: { businessAccountId: actor.businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: { plan: true, usageRecords: { orderBy: { periodStart: "desc" }, take: 1 } },
  });
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  const usage = subscription.usageRecords[0];
  if (!usage) throw new AppError(500, "Current account usage record is unavailable");
  const updated = await tx.accountUsageRecord.updateMany({
    where: {
      id: usage.id,
      ...(subscription.plan.maxAppointmentsPerMonth !== null ? { appointmentsUsed: { lt: subscription.plan.maxAppointmentsPerMonth } } : {}),
    },
    data: { appointmentsUsed: { increment: 1 } },
  });
  if (updated.count !== 1) {
    const current = await tx.accountUsageRecord.findUniqueOrThrow({ where: { id: usage.id } });
    throw appointmentLimitError(subscription.plan, current.appointmentsUsed);
  }
  await tx.businessUsageRecord.upsert({
    where: { businessId_periodStart: { businessId: actor.businessId, periodStart: usage.periodStart } },
    create: {
      businessId: actor.businessId,
      appointmentsUsed: 1,
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
    },
    update: { appointmentsUsed: { increment: 1 } },
  });
  return subscription;
}
