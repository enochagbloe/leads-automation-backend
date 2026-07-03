import {
  AppointmentConfirmationMode,
  AppointmentLocationStatus,
  AppointmentLocationType,
  AppointmentSource,
  PlanCode,
  ServiceCapacityMode,
} from "@prisma/client";
import { env } from "../config/env";

export type AppointmentAutoConfirmDecisionInput = {
  planCode: PlanCode;
  appointmentConfirmationMode: AppointmentConfirmationMode;
  aiAutoConfirmAppointmentsEnabled: boolean;
  source: AppointmentSource;
  service: {
    id: string;
    name: string;
    isBookable: boolean;
    autoConfirmEligible: boolean;
    requiresManualApproval: boolean;
    requiresPayment: boolean;
    paymentRequiredBeforeBooking: boolean;
    requiresDepositBeforeConfirmation: boolean;
    requiresLocationBeforeConfirmation: boolean;
    requiresStaffAssignment: boolean;
    allowedLocationTypes: AppointmentLocationType[];
    defaultLocationType: AppointmentLocationType | null;
    requiresStaffAssignmentBeforeConfirmation: boolean;
    requiresManagerApproval: boolean;
    capacityMode: ServiceCapacityMode;
    requiredStaffRole: string | null;
    requiredSkillTags: string[];
    allowAiToChooseLocationType: boolean;
  } | null;
  customerName: string | null;
  customerPhone: string | null;
  assignedStaffId: string | null;
  locationType: AppointmentLocationType;
  locationStatus: AppointmentLocationStatus;
  availability: {
    available: boolean;
    reason: string | null;
    message?: string | null;
  };
  aiDecision?: {
    confidence?: number | null;
    intent?: string | null;
    reason?: string | null;
    requiresHumanReview?: boolean | null;
    suggestedAction?: string | null;
  } | null;
};

export type AppointmentAutoConfirmDecision = {
  evaluated: boolean;
  shouldAutoConfirm: boolean;
  confidence: number | null;
  decisionReason: string;
  failedReason: string | null;
  failedReasons: string[];
};

const riskyIntentPattern = /complaint|angry|refund|cancel|emergency|urgent|legal|price|discount|negot/i;

function fail(confidence: number | null, reasons: string[]): AppointmentAutoConfirmDecision {
  return {
    evaluated: true,
    shouldAutoConfirm: false,
    confidence,
    decisionReason: "AI appointment auto-confirmation was evaluated and blocked.",
    failedReason: reasons.join("; "),
    failedReasons: reasons,
  };
}

export function evaluatePremiumAppointmentAutoConfirmation(
  input: AppointmentAutoConfirmDecisionInput,
): AppointmentAutoConfirmDecision {
  if (input.source !== AppointmentSource.AI_CONVERSATION) {
    return {
      evaluated: false,
      shouldAutoConfirm: false,
      confidence: null,
      decisionReason: "Auto-confirmation was not evaluated for non-AI appointment source.",
      failedReason: null,
      failedReasons: [],
    };
  }

  const confidence = input.aiDecision?.confidence ?? null;
  const reasons: string[] = [];
  if (!env.PREMIUM_APPOINTMENT_AUTO_CONFIRM_ENABLED) {
    reasons.push("Premium appointment auto-confirmation feature flag is disabled.");
  }
  if (input.planCode !== PlanCode.PREMIUM) reasons.push("Premium plan is required.");
  if (input.appointmentConfirmationMode !== AppointmentConfirmationMode.AUTO_CONFIRM_SAFE_BOOKINGS) {
    reasons.push("Safe booking auto-confirmation mode is not enabled.");
  }
  if (!input.aiAutoConfirmAppointmentsEnabled) reasons.push("AI appointment auto-confirmation is disabled.");
  if (!input.service) reasons.push("A bookable service is required.");
  if (input.service && !input.service.isBookable) reasons.push("Selected service is not bookable.");
  if (input.service && !input.service.autoConfirmEligible) reasons.push("Selected service is not eligible for AI auto-confirmation.");
  if (input.service?.requiresManualApproval || input.service?.requiresManagerApproval) {
    reasons.push("Selected service requires manager approval.");
  }
  if (input.service?.requiresPayment || input.service?.paymentRequiredBeforeBooking || input.service?.requiresDepositBeforeConfirmation) {
    reasons.push("Selected service requires payment or deposit before confirmation.");
  }
  if (
    input.service
    && input.service.allowedLocationTypes.length > 0
    && !input.service.allowedLocationTypes.includes(input.locationType)
  ) {
    reasons.push("Requested location type is not allowed for this service.");
  }
  if (input.service?.requiresLocationBeforeConfirmation && input.locationStatus !== AppointmentLocationStatus.CONFIRMED) {
    reasons.push("Selected service requires a confirmed location.");
  }
  if (
    input.locationStatus !== AppointmentLocationStatus.CONFIRMED
    && input.locationStatus !== AppointmentLocationStatus.NOT_REQUIRED
  ) {
    reasons.push("Appointment location must be confirmed or not required.");
  }
  if (input.service?.requiresStaffAssignment && !input.assignedStaffId) {
    reasons.push("Selected service requires staff assignment.");
  }
  if (input.service?.capacityMode === ServiceCapacityMode.BUSINESS_WIDE) {
    reasons.push("Business-wide capacity rules are not available for safe AI auto-confirmation yet.");
  }
  if (
    input.service?.capacityMode === ServiceCapacityMode.STAFF_BASED
    && (input.service.requiresStaffAssignmentBeforeConfirmation || input.service.requiresStaffAssignment)
    && !input.assignedStaffId
  ) {
    reasons.push("Safe staff-based auto-confirmation requires an eligible assigned staff member.");
  }
  if (!input.assignedStaffId && input.service?.capacityMode !== ServiceCapacityMode.UNLIMITED) {
    reasons.push("Safe auto-confirmation requires an assigned staff member or explicit unlimited capacity.");
  }
  if (!input.customerName?.trim()) reasons.push("Customer name is required.");
  if (!input.customerPhone?.trim()) reasons.push("Customer phone is required.");
  if (!input.availability.available) reasons.push(input.availability.message ?? input.availability.reason ?? "Appointment slot is unavailable.");
  if (confidence === null || confidence < env.AI_AUTO_CONFIRM_MIN_CONFIDENCE) {
    reasons.push(`AI confidence must be at least ${env.AI_AUTO_CONFIRM_MIN_CONFIDENCE}.`);
  }
  if (input.aiDecision?.requiresHumanReview) reasons.push("AI decision requires human review.");
  const riskText = [input.aiDecision?.intent, input.aiDecision?.reason, input.aiDecision?.suggestedAction].filter(Boolean).join(" ");
  if (riskyIntentPattern.test(riskText)) reasons.push("AI decision contains risk signals.");

  if (reasons.length > 0) return fail(confidence, reasons);
  return {
    evaluated: true,
    shouldAutoConfirm: true,
    confidence,
    decisionReason: "Premium AI auto-confirmed a safe appointment booking.",
    failedReason: null,
    failedReasons: [],
  };
}
