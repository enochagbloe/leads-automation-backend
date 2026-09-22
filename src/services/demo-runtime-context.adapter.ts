import { hasGroundedPrice } from "./conversation-response-policy.service";
import { createHash } from "node:crypto";
import type { AiBusinessContext } from "./ai-context-builder.service";
import type { DemoContext } from "./demo-context.service";
import type { DemoActor } from "./demo.service";
import type { RuntimeKnowledgeProvider } from "./runtime-knowledge.provider";

// IDs are context references only: never production Service/Knowledge Hub record IDs.
export function demoContextId(actor: DemoActor, kind: string, identity: string) {
  return `demo_${kind}_${createHash("sha256").update(JSON.stringify([actor.businessId, actor.demoSessionId, kind, identity])).digest("hex").slice(0, 32)}`;
}
type DemoKnowledgeScope = { actor: DemoActor; context: DemoContext };
export const demoKnowledgeProvider: RuntimeKnowledgeProvider<DemoKnowledgeScope> = {
  async load({ actor, context }) {
    const documentId = demoContextId(actor, "website", context.sourceWebsite ?? "company");
    return {
      knowledgeArticles: [], approvedKnowledgeFacts: [], runtimeKnowledgeGuards: [],
      knowledgeDocumentChunks: context.facts.faqs.slice(0, 6).map(faq => ({
        id: demoContextId(actor, "faq", JSON.stringify(faq)), documentId,
        documentTitle: "Temporary website FAQ",
        chunkText: `Question: ${faq.question}\nAnswer: ${faq.answer}`,
      })),
    };
  },
};

/** Pure normalization of an already validated, actor-scoped DemoContext. No DB writes or AI calls. */
export async function adaptDemoRuntimeContext(actor: DemoActor, context: DemoContext): Promise<Pick<AiBusinessContext, "business" | "services" | "availability" | "policies" | "knowledgeArticles" | "knowledgeDocumentChunks" | "approvedKnowledgeFacts" | "runtimeKnowledgeGuards" | "safetyInstructions">> {
  const facts = context.facts;
  const services: AiBusinessContext["services"] = facts.services.map(service => ({
    id: demoContextId(actor, "service", JSON.stringify(service)), name: service.name,
    description: service.description, priceDescription: service.price, durationText: service.duration,
    source: "WEBSITE",
    // Operational settings are deliberately absent, not guessed from a public website.
  }));
  const availability: AiBusinessContext["availability"] = facts.openingHours.length ? {
    source: "WEBSITE", meaning: "BUSINESS_HOURS_NOT_SLOTS", timezone: null, weeklyHours: [],
    summaryText: facts.openingHours.map(h => `${h.day}: ${h.hours}`).join("; "),
  } : null;
  const policies = facts.policies.map(content => ({
    id: demoContextId(actor, "policy", content), title: "Website policy", category: "GENERAL", content,
  }));
  const knowledge = await demoKnowledgeProvider.load({ actor, context });
  return {
    business: { id: actor.businessId, name: context.businessName, industry: facts.industry, description: facts.description, website: context.sourceWebsite, ...facts.contacts, locations: facts.locations },
    services, availability, policies, ...knowledge,
    safetyInstructions: {
      canAnswerServiceQuestions: services.length > 0,
      canAnswerPricingQuestions: services.some(s => Boolean(s.priceDescription)) || hasGroundedPrice(knowledge.knowledgeDocumentChunks.map(c => ({ id: c.id, value: c.chunkText }))),
      canAnswerBusinessHoursQuestions: availability !== null,
      canAnswerAvailabilityQuestions: false,
      canAnswerPolicyQuestions: policies.length > 0,
      canDetectBookingIntent: services.length > 0,
      cannotConfirmAppointmentsWithoutBackend: true, mustRequestHumanReviewWhenUnsure: true,
    },
  };
}
