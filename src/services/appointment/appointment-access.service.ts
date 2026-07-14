import { BusinessRole, Prisma } from "@prisma/client";
import { AppError } from "../../utils/errors";
import { AppointmentActor } from "./appointment.types";

export function isManager(actor: AppointmentActor) {
  return actor.role === BusinessRole.BUSINESS_OWNER || actor.role === BusinessRole.MANAGER;
}

export function requireManager(actor: AppointmentActor) {
  if (!isManager(actor)) {
    throw new AppError(403, "You do not have permission to manage this appointment.", "FORBIDDEN");
  }
}

export function requireReason(reason: string | null | undefined, action: "rescheduling" | "cancelling") {
  if (!reason?.trim()) {
    throw new AppError(422, `Please provide a reason before ${action} this appointment.`, "APPOINTMENT_REASON_REQUIRED");
  }
  return reason.trim();
}

export function accessWhere(actor: AppointmentActor): Prisma.AppointmentWhereInput {
  return {
    businessId: actor.businessId,
    ...(actor.role === BusinessRole.STAFF ? { OR: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: null }] } : {}),
  };
}

export function assignedStaffFilter(actor: AppointmentActor, requestedAssignedStaffId?: string) {
  if (actor.role !== BusinessRole.STAFF) return requestedAssignedStaffId ? { assignedStaffId: requestedAssignedStaffId } : {};
  if (!requestedAssignedStaffId) return {};
  return requestedAssignedStaffId === actor.membershipId
    ? { assignedStaffId: actor.membershipId }
    : { AND: [{ assignedStaffId: actor.membershipId }, { assignedStaffId: requestedAssignedStaffId }] };
}
