import type { AiBusinessContext } from "./ai-context-builder.service";
import type { ConversationContextSnapshot } from "./conversation-context.service";
import type { ConversationInterpretation } from "./conversation-interpretation.schema";
import type { StateData } from "./conversation-state.schema";
import { entitySchema } from "./conversation-state.schema";
import type { CustomerPurpose } from "./conversation-purpose.schema";
import { env } from "../config/env";

export const purposeEntityKeys = new Set(["customerGoal", "serviceNeed", "serviceResolution", "serviceId", "serviceName", "service"]);
export const entityText = (state: StateData, key: string) => {
  const e = state.knownEntities[key]; const value = e?.normalizedValue ?? e?.value;
  return typeof value === "string" ? value : undefined;
};
const folded = (value: string) => value.trim().toLocaleLowerCase();
/** Eligibility only; catalog and current-message evidence still require purpose validation. */
export function isActiveBookingServiceSwitch(snapshot: ConversationContextSnapshot, meaning: ConversationInterpretation, context?: AiBusinessContext) {
  const purpose = meaning.customerPurpose;
  const current = context && resolvedConversationService(snapshot.state, context);
  return Boolean(current && snapshot.state.activeWorkflow === "APPOINTMENT_BOOKING" &&
    ["ACTIVE", "WAITING_FOR_CUSTOMER"].includes(snapshot.state.workflowStatus) &&
    meaning.topicShift?.detected && meaning.topicShift.kind === "NEW_PRIMARY_GOAL" &&
    meaning.intent === "BOOKING_INTENT" && !meaning.needsClarification && meaning.confidence >= env.AI_MIN_CONFIDENCE &&
    purpose?.goal === "ARRANGE_SERVICE" && purpose.confidence >= env.AI_MIN_CONFIDENCE &&
    ["EXACT", "INFERRED"].includes(purpose.resolution) && purpose.serviceId && purpose.serviceId !== current.id &&
    purpose.candidateServiceIds.every(id => id === purpose.serviceId));
}
/** One catalog lookup shared by the planner and workflow adapter. No language matching here. */
export function resolvedConversationService(state: StateData, context: Pick<AiBusinessContext, "services">) {
  const resolution = entityText(state, "serviceResolution");
  if (resolution && !["EXACT", "INFERRED"].includes(resolution)) return undefined;
  const id = entityText(state, "serviceId");
  const name = entityText(state, "serviceName") ?? entityText(state, "service");
  const matches = context.services.filter(s => id ? s.id === id : name ? folded(s.name) === folded(name) : false);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The model proposes a meaning; IDs and evidence must belong to the scoped context/message. */
export function validateCustomerPurpose(snapshot: ConversationContextSnapshot, meaning: ConversationInterpretation, context?: AiBusinessContext): { purpose?: CustomerPurpose; error?: string } {
  if (!meaning.customerPurpose) return {};
  const purpose = structuredClone(meaning.customerPurpose);
  if (!context || context.business.id !== snapshot.state.businessId || context.conversation.id !== snapshot.state.conversationId || context.triggerMessage.id !== snapshot.currentMessage?.id) return { error: "PURPOSE_SCOPE_INVALID" };
  const message = snapshot.currentMessage!;
  if (!purpose.evidence.every(e => e.messageId === message.id && message.text.includes(e.quote))) return { error: "PURPOSE_EVIDENCE_INVALID" };
  if (meaning.resolvedEntities.some(e => purposeEntityKeys.has(e.key))) return { error: "DUPLICATE_PURPOSE_REPRESENTATION" };
  const find = (id: string) => context.services.filter(s => s.id === id);
  const referenced = [...purpose.candidateServiceIds, ...(purpose.serviceId ? [purpose.serviceId] : [])];
  if (referenced.some(id => find(id).length !== 1)) return { error: "SERVICE_REFERENCE_INVALID" };
  if (!purpose.catalogEvidence.every(e => referenced.includes(e.serviceId) && find(e.serviceId).some(s => [s.name, s.description ?? ""].some(text => text.includes(e.quote))))) return { error: "SERVICE_EVIDENCE_INVALID" };
  if (purpose.goal === "ARRANGE_SERVICE" && meaning.intent !== "BOOKING_INTENT") return { error: "CUSTOMER_GOAL_INTENT_MISMATCH" };
  if (meaning.intent === "BOOKING_INTENT" && purpose.goal !== "ARRANGE_SERVICE") return { error: "CUSTOMER_GOAL_INTENT_MISMATCH" };
  if (purpose.goal !== "ARRANGE_SERVICE" && meaning.workflow?.name === "APPOINTMENT_BOOKING" && meaning.workflow.action === "START") return { error: "CUSTOMER_GOAL_INTENT_MISMATCH" };
  const resolved = ["EXACT", "INFERRED"].includes(purpose.resolution);
  if (resolved && (!purpose.serviceId || !purpose.need)) return { error: "SERVICE_RESOLUTION_INCOMPLETE" };
  if (!resolved && purpose.serviceId) return { error: "UNRESOLVED_SERVICE_SELECTED" };
  if (purpose.resolution === "EXACT" && !purpose.evidence.some(e => folded(e.quote).includes(folded(find(purpose.serviceId!)[0]!.name)))) return { error: "EXACT_SERVICE_EVIDENCE_MISSING" };
  if (purpose.resolution === "INFERRED" && !purpose.catalogEvidence.some(e => e.serviceId === purpose.serviceId)) return { error: "SERVICE_MAPPING_EVIDENCE_MISSING" };
  if (purpose.resolution === "AMBIGUOUS" && purpose.candidateServiceIds.length < 2) return { error: "SERVICE_CANDIDATES_MISSING" };
  if (resolved && purpose.confidence < env.AI_MIN_CONFIDENCE) { purpose.resolution = "UNRESOLVED"; purpose.serviceId = null; }
  // Only the narrow active-booking switch can replace an established purpose.
  const current = resolvedConversationService(snapshot.state, context);
  if (snapshot.state.activeWorkflow && current) {
    if (purpose.resolution === "UNSPECIFIED" && !purpose.need) return { purpose };
    if ((meaning.topicShift?.detected || purpose.serviceId !== current.id) && !isActiveBookingServiceSwitch(snapshot, meaning, context)) return { error: "PURPOSE_CHANGE_REQUIRES_CLARIFICATION" };
  }
  return { purpose };
}

export function purposeEntities(state: StateData, purpose: CustomerPurpose, context: AiBusinessContext, messageId: string, now: number) {
  const known = { ...state.knownEntities };
  const retainService = purpose.resolution === "UNSPECIFIED" && !purpose.need && resolvedConversationService(state, context);
  if (!retainService) for (const key of purposeEntityKeys) delete known[key];
  const put = (key: string, value: string) => { known[key] = entitySchema.parse({ value, kind: "TEXT", confidence: purpose.confidence, sourceMessageId: messageId, updatedAt: new Date(now).toISOString() }); };
  put("customerGoal", purpose.goal);
  if (retainService) return known; // Keep the original service/need provenance when only the goal changes.
  put("serviceResolution", purpose.resolution);
  if (purpose.need) put("serviceNeed", purpose.need);
  if (purpose.serviceId) { put("serviceId", purpose.serviceId); put("serviceName", context.services.find(s => s.id === purpose.serviceId)!.name); }
  return known;
}

/** Sufficient purpose must be backed by the current catalog, including old validated service state. */
export function bookingPurposeRequirement(state: StateData, context: AiBusinessContext, meaning: ConversationInterpretation) {
  if (resolvedConversationService(state, context)) return null;
  const need = entityText(state, "serviceNeed") ?? entityText(state, "reason") ?? null;
  const status = entityText(state, "serviceResolution");
  const ids = meaning.customerPurpose?.candidateServiceIds ?? [];
  const candidates = context.services.filter(s => ids.includes(s.id)).slice(0, 3).map(s => ({ id: s.id, name: s.name.slice(0, 180), description: s.description?.slice(0, 300) ?? null }));
  return {
    move: need ? "ASK_FOR_CLARIFICATION" as const : "ASK_FOR_FIELD" as const,
    reasonCode: status === "UNSUPPORTED" ? "SERVICE_UNSUPPORTED" : need ? "SERVICE_NEED_UNRESOLVED" : "CUSTOMER_PURPOSE_REQUIRED",
    clarification: { need, candidates },
  };
}
