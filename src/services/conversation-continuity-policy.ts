import type { ConversationInterpretation } from "./conversation-interpretation.schema";
import type { ConversationContextSnapshot } from "./conversation-context.service";

/** Intent categories, never customer-language or industry matching. */
export const isInformationalIntent = (intent: ConversationInterpretation["intent"]) =>
  ["GENERAL_QUESTION", "SERVICE_INQUIRY", "PRICING_INQUIRY", "AVAILABILITY_INQUIRY", "PAYMENT_QUESTION"].includes(intent);

export function hasUnresolvedPurpose(snapshot: ConversationContextSnapshot) {
  return Boolean(snapshot.state.activeWorkflow || snapshot.state.awaiting && snapshot.state.knownEntities.customerGoal);
}

/** A model classification is evidence, not permission to change the active purpose. */
export function topicDriftError(snapshot: ConversationContextSnapshot, meaning: ConversationInterpretation) {
  const shift = meaning.topicShift;
  if (!shift?.kind) return undefined; // Old receipts remain valid; they cannot authorize automatic continuation.
  if (!shift.detected || !shift.evidence?.length || !snapshot.currentMessage ||
      !shift.evidence.every(e => e.messageId === snapshot.currentMessage!.id && snapshot.currentMessage!.text.includes(e.quote))) return "TOPIC_DRIFT_EVIDENCE_INVALID";
  if (shift.from && shift.from !== snapshot.state.activeTopic) return "TOPIC_REFERENCE_MISMATCH";
  if (shift.kind === "SIDE_QUESTION" && (!isInformationalIntent(meaning.intent) || meaning.conversationAct === "GREETING")) return "TOPIC_DRIFT_INTENT_MISMATCH";
  return undefined;
}

export function shouldPreservePurpose(snapshot: ConversationContextSnapshot, meaning: ConversationInterpretation) {
  return hasUnresolvedPurpose(snapshot) && (isInformationalIntent(meaning.intent) ||
    meaning.topicShift?.kind === "NEW_PRIMARY_GOAL" || ["HUMAN_REQUEST", "COMPLAINT"].includes(meaning.intent));
}
