import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { CheckAppointmentAvailabilityInput } from "../../validation/appointment.schemas";
import { STAFF_CONFLICT_BLOCKING_STATUSES } from "./appointment.constants";
import { dayOfWeekFor, parseTime, zonedDateTimeToUtc } from "./appointment-date-time.utils";
import { validateAssignee, validateService } from "./appointment-validation.service";

export async function checkSlot(input: CheckAppointmentAvailabilityInput & { businessId: string }, tx: Prisma.TransactionClient = prisma) {
  const { service, durationMinutes } = await validateService(input.businessId, input.serviceId, input.durationMinutes, tx);
  const assignee = await validateAssignee(input.businessId, input.assignedStaffId, tx);
  const startTime = zonedDateTimeToUtc(input.date, input.time, input.timezone);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);
  const { totalMinutes: startMinutes } = parseTime(input.time);
  const endMinutes = startMinutes + durationMinutes;
  const day = dayOfWeekFor(startTime, input.timezone);
  const rule = await tx.businessAvailability.findFirst({
    where: { businessId: input.businessId, dayOfWeek: day, isActive: true },
  });
  if (!rule || !rule.isOpen || !rule.openTime || !rule.closeTime) {
    return { available: false, reason: "BUSINESS_CLOSED", message: "The business is closed at this time.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[] };
  }
  const openMinutes = parseTime(rule.openTime).totalMinutes;
  const closeMinutes = parseTime(rule.closeTime).totalMinutes;
  if (startMinutes < openMinutes || endMinutes > closeMinutes) {
    return { available: false, reason: "APPOINTMENT_OUTSIDE_BUSINESS_HOURS", message: "The appointment is outside business hours.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[] };
  }
  if (rule.breakStartTime && rule.breakEndTime) {
    const breakStart = parseTime(rule.breakStartTime).totalMinutes;
    const breakEnd = parseTime(rule.breakEndTime).totalMinutes;
    if (startMinutes < breakEnd && endMinutes > breakStart) {
      return { available: false, reason: "APPOINTMENT_OVERLAPS_BREAK_TIME", message: "The appointment overlaps a break time.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[] };
    }
  }
  if (assignee) {
    const conflict = await tx.appointment.findFirst({
      where: {
        businessId: input.businessId,
        assignedStaffId: assignee.id,
        status: { in: STAFF_CONFLICT_BLOCKING_STATUSES },
        startTime: { lt: endTime },
        endTime: { gt: startTime },
        ...(input.excludeAppointmentId ? { id: { not: input.excludeAppointmentId } } : {}),
      },
      select: { id: true, title: true, startTime: true, endTime: true },
    });
    if (conflict) {
      return { available: false, reason: "APPOINTMENT_STAFF_UNAVAILABLE", message: "The assigned staff member already has an appointment at this time.", suggestedSlots: [] as unknown[], startTime, endTime, durationMinutes, warnings: [] as string[], conflict };
    }
  }
  return {
    available: true,
    reason: null,
    message: null,
    startTime,
    endTime,
    durationMinutes,
    warnings: service ? [] as string[] : ["No service selected; using manual duration."],
  };
}

export async function lockAppointmentAvailabilityScope(
  tx: Prisma.TransactionClient,
  input: Pick<CheckAppointmentAvailabilityInput, "assignedStaffId" | "date"> & { businessId: string },
) {
  if (!input.assignedStaffId) return;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext(${input.businessId}),
      hashtext(${`${input.assignedStaffId}:${input.date}`})
    )
  `;
}
