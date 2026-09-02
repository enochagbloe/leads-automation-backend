import type { AiBusinessContext } from "../ai-context-builder.service";

type ServiceContext = AiBusinessContext["services"][number];
type RuntimeGuard = AiBusinessContext["runtimeKnowledgeGuards"][number];

const PRICING_FIELDS = new Set(["basePrice", "priceType", "priceDescription", "currency"]);

export function redactGuardedServicePricing(
  service: ServiceContext,
  guards: readonly RuntimeGuard[],
): ServiceContext {
  const pricingBlocked = guards.some((guard) => guard.canonicalEntityType === "SERVICE"
    && (guard.canonicalEntityId === null || guard.canonicalEntityId === service.id)
    && (guard.canonicalField === null || PRICING_FIELDS.has(guard.canonicalField)));
  if (!pricingBlocked) return service;

  // Price type and prose can reveal the disputed price even when basePrice is null.
  // Unstructured service descriptions cannot be safely redacted at field level.
  return {
    ...service,
    priceType: "NOT_SET",
    basePrice: null,
    currency: undefined,
    priceDescription: null,
    description: null,
  };
}

export function redactGuardedContextPricing(context: AiBusinessContext): AiBusinessContext {
  const services = context.services.map((service) => redactGuardedServicePricing(service, context.runtimeKnowledgeGuards));
  return {
    ...context,
    services,
    safetyInstructions: {
      ...context.safetyInstructions,
      canAnswerPricingQuestions: services.some((service) => service.priceType != null && service.priceType !== "NOT_SET"),
    },
  };
}
