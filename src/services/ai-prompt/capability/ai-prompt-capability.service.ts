import { AiPromptScope, PlanCode } from "@prisma/client";
import { AiPromptCapabilities } from "../core/ai-prompt.types";

const ALL_SCOPES = Object.values(AiPromptScope);
const IMPLEMENTED_SCOPES = new Set<AiPromptScope>([
  AiPromptScope.GLOBAL,
  AiPromptScope.FOLLOW_UP,
]);

export function aiPromptCapabilitiesForPlan(plan: PlanCode, scope: AiPromptScope): AiPromptCapabilities {
  const implemented = IMPLEMENTED_SCOPES.has(scope);
  const base: AiPromptCapabilities = {
    plan,
    scope,
    implemented,
    maxPromptLength: plan === PlanCode.PREMIUM ? 8_000 : plan === PlanCode.PLUS ? 6_000 : 4_000,
    canActivate: implemented,
  };

  if (scope !== AiPromptScope.FOLLOW_UP) return base;

  if (plan === PlanCode.PREMIUM) {
    return {
      ...base,
      maxFollowUpAttempts: 3,
      postAppointmentFollowUp: true,
      staleLeadRecovery: true,
      adaptiveTiming: true,
      goalAwareSequencing: true,
      objectionAwareSequencing: true,
      priorityLeadRecovery: true,
      aiRewrite: true,
    };
  }

  if (plan === PlanCode.PLUS) {
    return {
      ...base,
      maxFollowUpAttempts: 2,
      postAppointmentFollowUp: true,
      staleLeadRecovery: true,
      adaptiveTiming: false,
      goalAwareSequencing: false,
      objectionAwareSequencing: false,
      priorityLeadRecovery: false,
      aiRewrite: true,
    };
  }

  return {
    ...base,
    maxFollowUpAttempts: 1,
    postAppointmentFollowUp: false,
    staleLeadRecovery: false,
    adaptiveTiming: false,
    goalAwareSequencing: false,
    objectionAwareSequencing: false,
    priorityLeadRecovery: false,
    aiRewrite: false,
  };
}

export const aiPromptCapabilityService = {
  forPlan: aiPromptCapabilitiesForPlan,
  scopesForPlan(plan: PlanCode) {
    return ALL_SCOPES.map((scope) => ({
      scope,
      capabilities: aiPromptCapabilitiesForPlan(plan, scope),
    }));
  },
};
