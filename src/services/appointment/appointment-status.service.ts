import { AppointmentRescheduleRequestStatus, AppointmentStatus } from "@prisma/client";
import { AppError } from "../../utils/errors";
import { OUTCOME_CONFIRMATION_GRACE_MS, TERMINAL_APPOINTMENT_STATUSES } from "./appointment.constants";

export function appointmentHasEnded(appointment: { endTime: Date }, now = new Date()) {
  return now.getTime() > appointment.endTime.getTime();
}

export function appointmentOutcomeDue(appointment: { endTime: Date }, now = new Date()) {
  return now.getTime() > appointment.endTime.getTime() + OUTCOME_CONFIRMATION_GRACE_MS;
}

export function appointmentInOutcomeGrace(appointment: { endTime: Date }, now = new Date()) {
  return appointmentHasEnded(appointment, now) && !appointmentOutcomeDue(appointment, now);
}

export function assertAppointmentEndedForOutcome(appointment: { endTime: Date }, action: "complete" | "no-show" | "missed") {
  if (appointmentHasEnded(appointment)) return;
  const messages = {
    complete: "Appointments cannot be completed before their scheduled end time.",
    "no-show": "Appointments cannot be marked no-show before their scheduled end time.",
    missed: "Appointments cannot be marked missed before their scheduled end time.",
  };
  const codes = {
    complete: "APPOINTMENT_CANNOT_COMPLETE",
    "no-show": "APPOINTMENT_CANNOT_NO_SHOW",
    missed: "APPOINTMENT_CANNOT_MARK_MISSED",
  };
  throw new AppError(422, messages[action], codes[action]);
}

export function availableActions(appointment: { status: AppointmentStatus; endTime: Date; rescheduleCount?: number | null }) {
  if (TERMINAL_APPOINTMENT_STATUSES.has(appointment.status)) return [];
  if (appointment.status === AppointmentStatus.NEEDS_OUTCOME_CONFIRMATION || appointmentInOutcomeGrace(appointment)) {
    return ["COMPLETE", "NO_SHOW", "MISSED"];
  }
  const canReschedule = !appointmentHasEnded(appointment) && (appointment.rescheduleCount ?? 0) < 1;
  if (
    appointment.status === AppointmentStatus.PENDING_BUSINESS_CONFIRMATION
    || appointment.status === AppointmentStatus.NEEDS_HUMAN_CONFIRMATION
    || appointment.status === AppointmentStatus.RESCHEDULE_REQUESTED
  ) {
    return ["CONFIRM", ...(canReschedule ? ["RESCHEDULE"] : []), "CANCEL"];
  }
  if (appointment.status === AppointmentStatus.CONFIRMED || appointment.status === AppointmentStatus.RESCHEDULED) {
    return [...(canReschedule ? ["RESCHEDULE"] : []), "CANCEL"];
  }
  return [];
}

export function rescheduleRequestState(appointment: {
  rescheduleRequests?: Array<{
    id: string;
    status: AppointmentRescheduleRequestStatus;
    requestedStartTime: Date | null;
    requestedEndTime: Date | null;
    requestedTimezone: string | null;
    requestedDateText: string | null;
    reason: string | null;
    createdAt: Date;
  }>;
}) {
  const request = appointment.rescheduleRequests?.[0] ?? null;
  if (!request) return { rescheduleRequested: false, rescheduleRequest: null };
  return {
    rescheduleRequested: true,
    rescheduleRequest: {
      id: request.id,
      status: request.status,
      requestedStartTime: request.requestedStartTime,
      requestedEndTime: request.requestedEndTime,
      requestedTimezone: request.requestedTimezone,
      requestedDateText: request.requestedDateText,
      rescheduleReason: request.reason,
      createdAt: request.createdAt,
    },
  };
}

export function withAvailableActions<T extends { status: AppointmentStatus; endTime: Date; rescheduleCount?: number | null; rescheduleRequests?: Array<{
  id: string;
  status: AppointmentRescheduleRequestStatus;
  requestedStartTime: Date | null;
  requestedEndTime: Date | null;
  requestedTimezone: string | null;
  requestedDateText: string | null;
  reason: string | null;
  createdAt: Date;
}> }>(appointment: T) {
  return { ...appointment, ...rescheduleRequestState(appointment), availableActions: availableActions(appointment) };
}

export function withAvailableActionsList<T extends { status: AppointmentStatus; endTime: Date; rescheduleCount?: number | null }>(appointments: T[]) {
  return appointments.map((appointment) => withAvailableActions(appointment));
}
