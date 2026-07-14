import { AppointmentConfirmationMode, AppointmentHumanConfirmationReason, AppointmentSource, AppointmentStatus, PlanCode, ServiceCapacityMode } from "@prisma/client";
import { CreationConfirmation } from "./appointment.types";
import { statusForLocation } from "./appointment-validation.service";
import { AppointmentServiceRules } from "./appointment-staff.service";

export function confirmationForCreation(
  planCode: PlanCode,
  appointmentConfirmationMode: AppointmentConfirmationMode,
  source: AppointmentSource,
  location: ReturnType<typeof statusForLocation>,
  assignedStaffId: string | null,
  availability: { available: boolean; reason: string | null },
  service: AppointmentServiceRules | null,
): CreationConfirmation {
  const businessConfirmationSource = source !== AppointmentSource.MANUAL;
  if (planCode === PlanCode.BASIC && source === AppointmentSource.AI_CONVERSATION) {
    return {
      status: AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
      locationStatus: location.locationStatus,
      humanConfirmationRequired: true,
      humanConfirmationReason: AppointmentHumanConfirmationReason.BUSINESS_CONFIRMATION_REQUIRED,
    };
  }
  if (
    planCode === PlanCode.BASIC
    && appointmentConfirmationMode === AppointmentConfirmationMode.MANUAL_CONFIRMATION_REQUIRED
    && businessConfirmationSource
  ) {
    return {
      status: AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
      locationStatus: location.locationStatus,
      humanConfirmationRequired: true,
      humanConfirmationReason: AppointmentHumanConfirmationReason.BUSINESS_CONFIRMATION_REQUIRED,
    };
  }
  if (planCode !== PlanCode.BASIC && appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_WHEN_STAFF_ASSIGNED) {
    if (!assignedStaffId) {
      return {
        status: AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: true,
        humanConfirmationReason: AppointmentHumanConfirmationReason.STAFF_REQUIRED,
      };
    }
    if (!availability.available && availability.reason === "APPOINTMENT_STAFF_UNAVAILABLE") {
      return {
        status: AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: true,
        humanConfirmationReason: AppointmentHumanConfirmationReason.AVAILABILITY_CONFLICT,
      };
    }
    if (location.humanConfirmationRequired) return location;
    return {
      status: AppointmentStatus.CONFIRMED,
      locationStatus: location.locationStatus,
      humanConfirmationRequired: false,
      humanConfirmationReason: null,
    };
  }
  if (planCode === PlanCode.PREMIUM && appointmentConfirmationMode === AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS) {
    if (!assignedStaffId && service?.capacityMode !== ServiceCapacityMode.UNLIMITED) {
      return {
        status: AppointmentStatus.PENDING_BUSINESS_CONFIRMATION,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: true,
        humanConfirmationReason: AppointmentHumanConfirmationReason.STAFF_REQUIRED,
      };
    }
    if (!availability.available) {
      return {
        status: AppointmentStatus.NEEDS_HUMAN_CONFIRMATION,
        locationStatus: location.locationStatus,
        humanConfirmationRequired: true,
        humanConfirmationReason: AppointmentHumanConfirmationReason.AVAILABILITY_CONFLICT,
      };
    }
    if (location.humanConfirmationRequired) return location;
    return {
      status: AppointmentStatus.CONFIRMED,
      locationStatus: location.locationStatus,
      humanConfirmationRequired: false,
      humanConfirmationReason: null,
    };
  }
  return location;
}
