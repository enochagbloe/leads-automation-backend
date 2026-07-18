import { AppointmentSource } from "@prisma/client";
import {
  AppointmentAutoConfirmSettingsInput,
  AppointmentCalendarQuery,
  AppointmentListQuery,
  AppointmentSettingsInput,
  ApproveAppointmentRescheduleRequestInput,
  CheckAppointmentAvailabilityInput,
  CreateAppointmentInput,
  DeclineAppointmentRescheduleRequestInput,
  RequestAppointmentRescheduleInput,
  RescheduleAppointmentInput,
} from "../validation/appointment.schemas";
import { AuditInput } from "./audit.service";
import { assign, claim } from "./appointment/appointment-assignment.service";
import { createAppointmentFromValidatedInput } from "./appointment/appointment-create.service";
import { cancel, complete, confirm, missed, noShow } from "./appointment/appointment-outcome.service";
import { calendar, checkAvailability, detail, getAppointmentContextForAi, list } from "./appointment/appointment-query.service";
import {
  approveAppointmentRescheduleRequest,
  declineAppointmentRescheduleRequest,
  requestAppointmentReschedule,
  rescheduleAppointmentFromValidatedInput,
} from "./appointment/appointment-reschedule.service";
import { getAutoConfirmSettings, updateAutoConfirmSettings, updateSettings } from "./appointment/appointment-settings.service";
import { AppointmentActor } from "./appointment/appointment.types";

export type { AppointmentActor, InternalCreateAppointmentInput } from "./appointment/appointment.types";
export { assertAppointmentConfirmationModeAllowed } from "./appointment/appointment-validation.service";

export const appointmentService = {
  checkAvailability(actor: AppointmentActor, input: CheckAppointmentAvailabilityInput) {
    return checkAvailability(actor, input);
  },

  create(actor: AppointmentActor, input: CreateAppointmentInput, context: Omit<AuditInput, "action">) {
    return createAppointmentFromValidatedInput(actor, {
      ...input,
      source: AppointmentSource.MANUAL,
    }, context);
  },

  createAppointmentFromValidatedInput,

  list(actor: AppointmentActor, query: AppointmentListQuery) {
    return list(actor, query);
  },

  calendar(actor: AppointmentActor, query: AppointmentCalendarQuery) {
    return calendar(actor, query);
  },

  detail(actor: AppointmentActor, appointmentId: string) {
    return detail(actor, appointmentId);
  },

  getAutoConfirmSettings(actor: AppointmentActor) {
    return getAutoConfirmSettings(actor);
  },

  updateAutoConfirmSettings(actor: AppointmentActor, input: AppointmentAutoConfirmSettingsInput, context: Omit<AuditInput, "action">) {
    return updateAutoConfirmSettings(actor, input, context);
  },

  updateSettings(actor: AppointmentActor, input: AppointmentSettingsInput, context: Omit<AuditInput, "action">) {
    return updateSettings(actor, input, context);
  },

  reschedule(actor: AppointmentActor, appointmentId: string, input: RescheduleAppointmentInput, context: Omit<AuditInput, "action">) {
    return rescheduleAppointmentFromValidatedInput(actor, appointmentId, input, context);
  },

  requestReschedule(actor: AppointmentActor, appointmentId: string, input: RequestAppointmentRescheduleInput, context: Omit<AuditInput, "action">) {
    return requestAppointmentReschedule(actor, appointmentId, input, context);
  },

  approveRescheduleRequest(
    actor: AppointmentActor,
    appointmentId: string,
    requestId: string,
    input: ApproveAppointmentRescheduleRequestInput,
    context: Omit<AuditInput, "action">,
  ) {
    return approveAppointmentRescheduleRequest(actor, appointmentId, requestId, input, context);
  },

  declineRescheduleRequest(
    actor: AppointmentActor,
    appointmentId: string,
    requestId: string,
    input: DeclineAppointmentRescheduleRequestInput,
    context: Omit<AuditInput, "action">,
  ) {
    return declineAppointmentRescheduleRequest(actor, appointmentId, requestId, input, context);
  },

  cancel(actor: AppointmentActor, appointmentId: string, reason: string | null | undefined, context: Omit<AuditInput, "action">) {
    return cancel(actor, appointmentId, reason, context);
  },

  confirm(actor: AppointmentActor, appointmentId: string, note: string | null | undefined, context: Omit<AuditInput, "action">) {
    return confirm(actor, appointmentId, note, context);
  },

  complete(actor: AppointmentActor, appointmentId: string, completedNote: string | null | undefined, context: Omit<AuditInput, "action">) {
    return complete(actor, appointmentId, completedNote, context);
  },

  noShow(actor: AppointmentActor, appointmentId: string, noShowReason: string | null | undefined, context: Omit<AuditInput, "action">) {
    return noShow(actor, appointmentId, noShowReason, context);
  },

  missed(actor: AppointmentActor, appointmentId: string, missedReason: string | null | undefined, context: Omit<AuditInput, "action">) {
    return missed(actor, appointmentId, missedReason, context);
  },

  assign(actor: AppointmentActor, appointmentId: string, assignedStaffId: string | null, context: Omit<AuditInput, "action">) {
    return assign(actor, appointmentId, assignedStaffId, context);
  },

  claim(actor: AppointmentActor, appointmentId: string, context: Omit<AuditInput, "action">) {
    return claim(actor, appointmentId, context);
  },

  getAppointmentContextForAi(businessId: string, conversationId?: string) {
    return getAppointmentContextForAi(businessId, conversationId);
  },
};

export const appointmentInternalService = {
  checkAppointmentAvailability: appointmentService.checkAvailability,
  createAppointmentFromValidatedInput,
  rescheduleAppointmentFromValidatedInput,
  cancelAppointmentFromValidatedInput: appointmentService.cancel,
  getAppointmentContextForAi: appointmentService.getAppointmentContextForAi,
};
