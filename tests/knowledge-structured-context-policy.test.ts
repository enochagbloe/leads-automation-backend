import assert from "node:assert/strict";
import test from "node:test";
import type { AiBusinessContext } from "../src/services/ai-context-builder.service";
import { aiPromptContextFormatter } from "../src/services/ai-context-builder.service";
import { redactGuardedContextPricing, redactGuardedServicePricing } from "../src/services/knowledge-document/knowledge-structured-context-policy";

type Service = AiBusinessContext["services"][number];
type Guard = AiBusinessContext["runtimeKnowledgeGuards"][number];

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: "service-1", name: "Consultation", category: "Care",
    description: "Consultation costs GHS 487.", priceType: "RANGE",
    basePrice: 487, currency: "GHS", priceDescription: "GHS 487–587",
    durationMinutes: 30, isBookable: true, allowedLocationTypes: [],
    autoConfirmEligible: false, requiresManualApproval: true,
    requiresManagerApproval: false, requiresStaffAssignmentBeforeConfirmation: false,
    requiresLocationBeforeConfirmation: false, capacityMode: "BUSINESS_WIDE",
    requiredSkillTags: [], allowAiToChooseLocationType: false,
    ...overrides,
  };
}

function guard(overrides: Partial<Guard> = {}): Guard {
  return {
    reviewItemId: "review-1", canonicalEntityType: "SERVICE",
    canonicalEntityId: "service-1", canonicalField: "basePrice", priority: "CRITICAL",
    ...overrides,
  };
}

// Only fields consumed by the prompt formatter are needed for these regression cases.
function context(services: Service[], guards: Guard[]): AiBusinessContext {
  return {
    business: { id: "business-1", name: "Clinic" },
    services, runtimeKnowledgeGuards: guards,
    availability: null, policies: [], knowledgeArticles: [], knowledgeDocumentChunks: [],
    approvedKnowledgeFacts: [], recentMessages: [], existingCustomerIssues: [],
    pendingFollowUpContexts: [], customerMemory: {}, readiness: {}, conversation: {},
    lead: null, triggerMessage: { id: "message-1", text: "How much?", createdAt: "2026-09-02" },
    planCapabilities: { tone: "PROFESSIONAL" },
    safetyInstructions: { canAnswerPricingQuestions: true },
  } as unknown as AiBusinessContext;
}

for (const priceType of ["FIXED", "STARTING_FROM", "RANGE", "QUOTE_ONLY", "FREE"] as const) {
  test(`a blocked ${priceType} price is absent from the final prompt`, () => {
    // The existing builder already nulled basePrice; alternate price text still leaked.
    const input = context([service({ priceType, basePrice: null })], [guard()]);
    const original = structuredClone(input);
    const formatted = aiPromptContextFormatter.format(input);
    const catalog = JSON.parse(formatted).sections.serviceCatalog.data;
    assert.equal(catalog[0].pricing, "Price not set. Do not invent price.");
    assert.equal(catalog[0].description, null);
    assert.equal(catalog[0].durationMinutes, 30);
    assert.equal(catalog[0].name, "Consultation");
    assert.doesNotMatch(formatted, /487|587|Free\./);
    assert.match(aiPromptContextFormatter.buildSystemPrompt(input), /"canAnswerPricingQuestions":false/);
    assert.deepEqual(input, original, "redaction must not mutate cached input");
  });
}

test("another service retains its price and pricing capability", () => {
  const safeService = service({ id: "service-2", name: "Follow-up", priceType: "FIXED", basePrice: 125 });
  const input = context([service(), safeService], [guard()]);
  const sanitized = redactGuardedContextPricing(input);
  assert.equal(sanitized.services[0]?.basePrice, null);
  assert.equal(sanitized.services[1], safeService);
  assert.equal(sanitized.safetyInstructions.canAnswerPricingQuestions, true);
  const catalog = JSON.parse(aiPromptContextFormatter.format(input)).sections.serviceCatalog.data;
  assert.equal(catalog[1].pricing, "Fixed price: GHS 125");
});

test("all price representations are withheld for every pricing field guard", () => {
  for (const canonicalField of ["basePrice", "priceType", "currency", "priceDescription", null]) {
    const result = redactGuardedServicePricing(service(), [guard({ canonicalField })]);
    assert.equal(result.basePrice, null);
    assert.equal(result.priceDescription, null);
    assert.equal(result.description, null);
    assert.equal(result.currency, undefined);
    assert.equal(result.priceType, "NOT_SET");
  }
});

test("an unbound service price guard applies conservatively to all services", () => {
  const result = redactGuardedServicePricing(service({ id: "service-2" }), [guard({ canonicalEntityId: null })]);
  assert.equal(result.basePrice, null);
});

test("unrelated entity and field guards preserve service pricing", () => {
  const input = service();
  for (const unrelated of [
    guard({ canonicalEntityId: "service-2" }),
    guard({ canonicalEntityType: "BUSINESS_PROFILE" }),
    guard({ canonicalField: "durationMinutes" }),
  ]) {
    assert.equal(redactGuardedServicePricing(input, [unrelated]), input);
  }
});

test("removing a resolved guard restores canonical pricing on a fresh context", () => {
  const original = service({ priceType: "FIXED" });
  assert.equal(redactGuardedServicePricing(original, [guard()]).basePrice, null);
  assert.equal(redactGuardedServicePricing(original, []).basePrice, 487);
  assert.equal(redactGuardedContextPricing(context([original], [])).safetyInstructions.canAnswerPricingQuestions, true);
});
