import type { AiBusinessContext } from "./ai-context-builder.service";
import type { ConversationContextSnapshot } from "./conversation-context.service";
import type { ConversationInterpretation } from "./conversation-interpretation.schema";
import { knowledgeRetrievalService, type KnowledgeGrounding } from "./knowledge-retrieval.service";
import { AppError } from "../utils/errors";

type Input = { businessId: string; interpretation: ConversationInterpretation; snapshot: ConversationContextSnapshot; context: AiBusinessContext };
type Knowledge = Pick<AiBusinessContext, "knowledgeArticles" | "knowledgeDocumentChunks" | "approvedKnowledgeFacts">;
const intentContext: Partial<Record<ConversationInterpretation["intent"], string>> = {
  HUMAN_REQUEST: "human representative customer support contact assistance",
  COMPLAINT: "complaint report problem customer support policy",
  PAYMENT_QUESTION: "payment policy fees refund cancellation policy",
  CANCELLATION_INTENT: "cancellation refund payment no-show policy",
  RESCHEDULE_INTENT: "reschedule appointment change policy",
  PRICING_INQUIRY: "pricing cost fees",
};
const text = (value: unknown, limit: number) => typeof value === "string" ? value.trim().slice(0, limit) : "";

/** Deterministic query composition, never another language-model rewrite. */
export function buildConversationKnowledgeQuery({ interpretation: i, snapshot: s, context }: Input) {
  const current = s.currentMessage?.text ?? context.triggerMessage.text;
  const parts = [`Customer: ${text(current, 700)}`, `Intent: ${i.needsClarification ? "UNKNOWN" : i.intent}`];
  if (!i.needsClarification && intentContext[i.intent]) parts.push(intentContext[i.intent]!);
  if (!i.needsClarification && i.customerPurpose?.need) parts.push(`Current need: ${text(i.customerPurpose.need, 250)}`);
  // Inherit topic only for a short follow-up in a fresh, scoped, live conversation.
  const active = ["ACTIVE", "WAITING_FOR_CUSTOMER", "WAITING_FOR_SYSTEM"].includes(s.state.workflowStatus);
  const short = current.trim().length <= 80 && current.trim().split(/\s+/).length <= 8;
  const reference = Boolean(i.selectedOption || i.resolvedEntities.some(e => e.source === "REFERENCE_RESOLUTION"));
  const relatedIntent = ["BOOKING_INTENT", "RESCHEDULE_INTENT", "CANCELLATION_INTENT", "SERVICE_INQUIRY", "PRICING_INQUIRY", "PAYMENT_QUESTION", "AVAILABILITY_INQUIRY"].includes(i.intent);
  const resolvedService = i.resolvedEntities.find(e => e.key === "serviceId");
  const currentServiceId = i.customerPurpose?.serviceId ?? resolvedService?.normalizedValue ?? resolvedService?.value;
  const previousServiceId = s.state.knownEntities.serviceId?.normalizedValue ?? s.state.knownEntities.serviceId?.value;
  const changedService = Boolean(currentServiceId && previousServiceId && currentServiceId !== previousServiceId);
  const scoped = s.state.businessId === context.business.id && s.state.conversationId === context.conversation.id && s.currentMessage?.id === context.triggerMessage.id;
  const now = Date.parse(s.currentMessage?.createdAt ?? "");
  const recent = s.recentMessages.filter(m => m.id !== s.currentMessage?.id && now - Date.parse(m.createdAt) >= 0 && now - Date.parse(m.createdAt) <= 30 * 60_000).slice(-2);
  const fresh = recent.length > 0 || (now - +s.state.lastActivityAt >= 0 && now - +s.state.lastActivityAt <= 30 * 60_000);
  const policyFollowUp = ["PAYMENT_QUESTION", "PRICING_INQUIRY", "CANCELLATION_INTENT", "RESCHEDULE_INTENT"].includes(i.intent);
  const continuing = scoped && fresh && short && active && !i.needsClarification
    && i.topicShift?.kind !== "NEW_PRIMARY_GOAL" && !changedService
    && (!i.topic || i.topic === s.state.activeTopic || i.topicShift?.kind === "SIDE_QUESTION" || policyFollowUp)
    && (reference || relatedIntent) && !["HUMAN_REQUEST", "COMPLAINT"].includes(i.intent);
  const entity = (key: string) => {
    const resolved = !i.needsClarification ? i.resolvedEntities.find(e => e.key === key && (e.source === "CURRENT_MESSAGE" || continuing)) : undefined;
    return resolved?.normalizedValue ?? resolved?.value ?? (continuing ? s.state.knownEntities[key]?.normalizedValue ?? s.state.knownEntities[key]?.value : undefined);
  };
  const serviceId = !i.needsClarification ? i.customerPurpose?.serviceId ?? entity("serviceId") : undefined;
  const service = context.services.find(item => item.id === serviceId);
  if (service) parts.push(`Service: ${text(service.name, 120)}`);
  for (const key of ["serviceNeed", "reason"]) {
    const value = text(entity(key), 150); if (value) parts.push(`${key}: ${value}`);
  }
  // Prefer validated semantic anchors. Never copy awaiting/options/workflow execution fields.
  if (continuing && !service && !entity("serviceNeed") && !entity("reason")) {
    const operationalValues = Object.entries(s.state.knownEntities)
      .filter(([key]) => !["serviceId", "serviceName", "serviceNeed", "reason", "customerGoal", "serviceResolution"].includes(key))
      .flatMap(([, e]) => [e.value, e.normalizedValue]).filter((v): v is string => typeof v === "string" && v.length > 1);
    // History is a fallback, never a way to reintroduce staff booking questions or known operational values.
    for (const m of recent.filter(m => m.senderType === "CUSTOMER" && !/\p{N}/u.test(m.text)
      && !operationalValues.some(v => m.text.toLowerCase().includes(v.toLowerCase())))) parts.push(`Recent topic: ${text(m.text, 140)}`);
  }
  return parts.join("\n").slice(0, 2000);
}

const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function duplicates(a: KnowledgeGrounding, b: KnowledgeGrounding) {
  if (normalized(a.title) !== normalized(b.title)) return false;
  const x = normalized(a.text), y = normalized(b.text);
  if (x === y) return true;
  // Small formatting/editorial variation must not consume several grounding slots.
  // Preserve distinct numeric claims even when the surrounding prose is identical.
  if (JSON.stringify(x.match(/\d+/g)) !== JSON.stringify(y.match(/\d+/g))) return false;
  const left = new Set(x.split(" ")), right = new Set(y.split(" "));
  const union = new Set([...left, ...right]);
  return union.size > 20 && [...left].filter(word => right.has(word)).length / union.size >= .95;
}

export const conversationKnowledgeRetrievalService = {
  async retrieve(input: Input): Promise<Knowledge> {
    const { businessId, snapshot, context } = input;
    if (!businessId || businessId !== context.business.id || businessId !== snapshot.state.businessId
      || context.conversation.id !== snapshot.state.conversationId || context.triggerMessage.id !== snapshot.currentMessage?.id) {
      throw new AppError(403, "Conversation knowledge scope mismatch", "CONVERSATION_KNOWLEDGE_SCOPE_MISMATCH");
    }
    if (context.demoSessionId) return { knowledgeArticles: context.knowledgeArticles, knowledgeDocumentChunks: context.knowledgeDocumentChunks, approvedKnowledgeFacts: context.approvedKnowledgeFacts };
    const empty: Knowledge = { knowledgeArticles: [], knowledgeDocumentChunks: [], approvedKnowledgeFacts: [] };
    const started = performance.now();
    let status = "RETRIEVAL_UNAVAILABLE";
    const matches: KnowledgeGrounding[] = [];
    try {
      const result = await knowledgeRetrievalService.retrieve({ businessId, query: buildConversationKnowledgeQuery(input), topK: 8 });
      status = result.status;
      if (status === "MATCHES_FOUND") for (const match of result.matches.slice(0, 8)) {
        if (!matches.some(existing => duplicates(existing, match))) matches.push(match);
        if (matches.length === 4) break;
      }
      return {
        knowledgeArticles: matches.filter(m => m.sourceType === "ARTICLE").map(m => ({ id: m.sourceId, title: m.title.slice(0, 200), body: m.text.slice(0, 900), tags: [] })),
        knowledgeDocumentChunks: matches.filter(m => m.sourceType !== "ARTICLE").map(m => ({ id: m.factId ?? m.chunkId ?? m.sourceId, documentId: m.sourceId, documentTitle: m.title.slice(0, 200), chunkText: m.text.slice(0, 900), pageNumber: m.pageNumber })),
        approvedKnowledgeFacts: [], // Retrieved facts are bounded text, not canonical operational facts.
      };
    } catch {
      status = "RETRIEVAL_UNAVAILABLE";
      matches.length = 0;
      return empty;
    } finally {
      console.info("conversation_knowledge.retrieved", { businessId, conversationId: context.conversation.id, sourceMessageId: context.triggerMessage.id, status, matchCount: matches.length, durationMs: Math.round(performance.now() - started) });
    }
  },
};
