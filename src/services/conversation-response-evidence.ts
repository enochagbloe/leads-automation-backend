import type { AiBusinessContext } from "./ai-context-builder.service";
import { env } from "../config/env";

const populated = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const normalize = (value: string) => value.toLowerCase().replace(/[?.!]+$/g, "").trim();

/** Evidence admission only: never classifies intent, resolves entities, or authorizes effects. */
export function hasFactualAnswerEvidence(context: AiBusinessContext): boolean {
  const plan = context.conversationPlan!;
  if (plan.move !== "ANSWER" || plan.reasonCode === "CUSTOMER_GREETING") return true;
  const semantic = context.knowledgeArticles.some(a => populated(a.body) || populated(a.summary))
    || context.knowledgeDocumentChunks.some(c => populated(c.chunkText))
    || context.approvedKnowledgeFacts.some(f => populated(f.valueText));
  if (semantic) return true;
  const question = normalize(context.triggerMessage.text);
  const business = context.business;
  const guarded = (field: string) => context.runtimeKnowledgeGuards?.some(g => g.canonicalEntityType === "BUSINESS_PROFILE" && (!g.canonicalField || g.canonicalField === field));
  const profile = (field: keyof typeof business) => !guarded(field) && populated(business[field]);
  switch (plan.intent) {
    case "GENERAL_QUESTION":
      // Deliberately narrow whole-question selectors: merely mentioning a contact word
      // in an unrelated question must not unlock all business-profile data.
      if (/^(?:where are you(?: located| based)?|what is your (?:address|location)|what's your (?:address|location))$/.test(question)) return profile("address") || (!guarded("locations") && Boolean(business.locations?.some(populated)));
      if (/^(?:what is|what's) your (?:phone|telephone|contact)(?: number)?$/.test(question)) return profile("phone");
      if (/^(?:what is|what's) your email(?: address)?$/.test(question)) return profile("email");
      if (/^(?:what is|what's) your website(?: address)?$/.test(question)) return profile("website");
      if (/^(?:how can i contact you|what are your contact details)$/.test(question)) return profile("phone") || profile("email");
      if (/^(?:tell me about (?:your business|your company|you)|what does your (?:business|company) do|what do you do)$/.test(question)) return profile("description");
      if (/^(?:what areas do you (?:serve|cover)|where do you (?:operate|provide services)|what is your service area)$/.test(question)) return profile("serviceArea");
      return false;
    case "SERVICE_INQUIRY": {
      if (context.demoSessionId) return true; // Preserve the existing demo service/clarification path.
      const purpose = context.conversationInterpretation?.customerPurpose;
      if (purpose && ["UNSUPPORTED", "AMBIGUOUS"].includes(purpose.resolution)) return false;
      if (purpose?.serviceId && ["EXACT", "INFERRED"].includes(purpose.resolution) && purpose.confidence >= env.AI_MIN_CONFIDENCE
        && purpose.evidence.some(e => e.messageId === context.triggerMessage.id && context.triggerMessage.text.includes(e.quote))
        && context.services.some(s => s.id === purpose.serviceId)) return true;
      // A current literal catalog reference or an explicit catalog-list question is evidence.
      const reference = question.replace(/^(?:do you (?:offer|provide|do)|tell me about|what is|what's)\s+(?:the\s+)?/, "");
      return context.services.some(s => populated(s.name) && reference === normalize(s.name))
        || (context.services.length > 0 && /^(?:what services do you (?:offer|provide)|what do you offer|list your services)$/.test(question));
    }
    case "AVAILABILITY_INQUIRY":
      return Boolean(context.demoSessionId || populated(context.availability?.summaryText) || context.availability?.weeklyHours?.length);
    case "PAYMENT_QUESTION":
      return Boolean(context.demoSessionId || context.policies.some(p => populated(p.content) && /\b(?:payment|deposit|refund|cancellation)\b/i.test(`${p.category} ${p.title}`)));
    default:
      // Governed pricing fallback, human review and workflow execution remain with their owners.
      return true;
  }
}
