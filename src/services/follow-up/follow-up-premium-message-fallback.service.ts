import {
  FollowUpContextType,
  PremiumFollowUpMessageSource,
  PremiumFollowUpSequenceStage,
} from "@prisma/client";
import { PremiumFollowUpMessageContext } from "./follow-up-premium-message.types";

function greeting(name: string | null) {
  return name ? `Hi ${name}, ` : "";
}

function missingDetailMessage(input: PremiumFollowUpMessageContext) {
  const unresolved = input.unresolvedRequest?.toLowerCase() ?? "";
  if (/\blocation|address|site\b/.test(unresolved)) {
    return `${greeting(input.customerName)}to continue with your request, could you share the location when you are ready?`;
  }
  if (/\bdate|day|time|schedule\b/.test(unresolved)) {
    return `${greeting(input.customerName)}which day and time would work best for you?`;
  }
  if (/\bservice|option|choice\b/.test(unresolved)) {
    return `${greeting(input.customerName)}have you decided which service option you would like help with?`;
  }
  return `${greeting(input.customerName)}to continue with your request, could you share the remaining information when you are ready?`;
}

export function premiumFollowUpFallback(input: PremiumFollowUpMessageContext) {
  if (input.finalDecision === "ESCALATE_TO_STAFF") {
    return {
      message: `${greeting(input.customerName)}I'll have someone from the team assist you with that.`,
      source: PremiumFollowUpMessageSource.ESCALATION_TEMPLATE,
      missingKnowledge: false,
    };
  }
  if (input.sequenceStage === PremiumFollowUpSequenceStage.FINAL_POLITE_FOLLOW_UP) {
    return {
      message: `${greeting(input.customerName)}just leaving a final note in case you still need help. You can message us whenever you're ready.`,
      source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
      missingKnowledge: false,
    };
  }
  if (
    input.contextType === FollowUpContextType.MISSING_CUSTOMER_DETAIL
    || input.unresolvedRequest
  ) {
    return {
      message: missingDetailMessage(input),
      source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
      missingKnowledge: false,
    };
  }
  if (
    input.contextType === FollowUpContextType.APPOINTMENT_CONFIRMATION
    && !input.appointmentFacts
  ) {
    return {
      message: `${greeting(input.customerName)}could you confirm the appointment detail so the team can assist you correctly?`,
      source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
      missingKnowledge: true,
    };
  }
  if (input.sequenceStage === PremiumFollowUpSequenceStage.HELPFUL_CLARIFICATION) {
    if (/\bprice|cost|budget|expensive\b/i.test(input.customerObjection ?? "")) {
      return {
        message: `${greeting(input.customerName)}if pricing is still something you're considering, the team can help clarify the available information.`,
        source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
        missingKnowledge: false,
      };
    }
    return {
      message: `${greeting(input.customerName)}let us know if you need any clarification before continuing.`,
      source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
      missingKnowledge: false,
    };
  }
  if (input.timingContext) {
    return {
      message: `${greeting(input.customerName)}as requested, we're checking back to see whether you would like to continue.`,
      source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
      missingKnowledge: false,
    };
  }
  if (/\bbook|appointment|consultation\b/i.test(input.customerGoal ?? "")) {
    return {
      message: `${greeting(input.customerName)}would you like to continue with your booking request?`,
      source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
      missingKnowledge: false,
    };
  }
  return {
    message: `${greeting(input.customerName)}just checking whether you still need help with your request.`,
    source: PremiumFollowUpMessageSource.DETERMINISTIC_FALLBACK,
    missingKnowledge: false,
  };
}
