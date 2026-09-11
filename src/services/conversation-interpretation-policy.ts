import { env } from "../config/env";
import { entitySchema, StateData, StatePatch } from "./conversation-state.schema";
import { ConversationContextSnapshot } from "./conversation-context.service";
import { ConversationInterpretation, localClock, offsetLocalDate } from "./conversation-interpretation.schema";

export type InterpretationCommand =
  | { type: "SET_ENTITY"; key: string }
  | { type: "CLEAR_AWAITING" }
  | { type: "SET_WORKFLOW"; name: string; action: string }
  | { type: "SET_INTENT"; intent: string };
export const semanticConfidenceThreshold = () => Math.max(env.AI_MIN_CONFIDENCE, env.AI_AUTO_CONFIRM_MIN_CONFIDENCE);
export function optionsAreFresh(state: StateData, now = Date.now()) {
  const issued = state.offeredOptionsCreatedAt ? Date.parse(state.offeredOptionsCreatedAt) : NaN;
  return state.offeredOptions.length > 0 && Number.isFinite(issued) && issued <= now && now - issued <= env.CONVERSATION_OPTIONS_TTL_MINUTES * 60_000;
}
const workflowTopic: Record<string, StateData["activeTopic"]> = {
  APPOINTMENT_BOOKING: "APPOINTMENT", APPOINTMENT_RESCHEDULE: "APPOINTMENT", APPOINTMENT_CANCEL: "APPOINTMENT",
  COMPLAINT_INTAKE: "COMPLAINT", GENERAL_ENQUIRY: "GENERAL_ENQUIRY", SERVICE_ENQUIRY: "SERVICE_ENQUIRY", HUMAN_HANDOFF: "HUMAN_HANDOFF",
};
const workflowIntent: Record<string, string> = {
  APPOINTMENT_BOOKING: "BOOKING_INTENT", APPOINTMENT_RESCHEDULE: "RESCHEDULE_INTENT", APPOINTMENT_CANCEL: "CANCELLATION_INTENT",
  COMPLAINT_INTAKE: "COMPLAINT", GENERAL_ENQUIRY: "GENERAL_QUESTION", SERVICE_ENQUIRY: "SERVICE_INQUIRY", HUMAN_HANDOFF: "HUMAN_REQUEST",
};
export const continuationIntent = (workflow: string | null) => workflowIntent[workflow ?? ""] ?? null;
/** Pure validator. It builds a bounded patch; no AI-provided command or whole-state replacement is accepted. */
export function planInterpretation(snapshot: ConversationContextSnapshot, proposed: ConversationInterpretation, now = Date.now()) {
  const interpretation = structuredClone(proposed);
  const ambiguous = (reason: string) => ({ interpretation: { ...interpretation, needsClarification: true, clarificationReason: reason }, patch: {} as StatePatch, commands: [] as InterpretationCommand[] });
  if (interpretation.needsClarification) return ambiguous(interpretation.clarificationReason ?? "INTERPRETATION_AMBIGUOUS");
  const high = semanticConfidenceThreshold();
  if (interpretation.confidence < high) return ambiguous(interpretation.confidence < env.AI_MIN_CONFIDENCE ? "LOW_CONFIDENCE" : "CONFIDENCE_REQUIRES_CLARIFICATION");
  if (interpretation.intent === "UNKNOWN") return ambiguous("CONTEXT_INSUFFICIENT");
  const state = snapshot.state;
  const message = snapshot.currentMessage;
  if (!message) return ambiguous("SOURCE_MESSAGE_MISSING");
  const clock = localClock(message.createdAt, snapshot.timezone);
  const known = { ...state.knownEntities };
  const commands: InterpretationCommand[] = [];
  const patch: StatePatch = { lastResolvedIntent: interpretation.intent };
  const pending = state.awaiting;
  // A model may resolve the target value without repeating its option ID. Match only one exact,
  // current offered value; never infer a time, position or entity target from language here.
  if (!interpretation.selectedOption && pending?.type === "OPTION_SELECTION" && pending.field && optionsAreFresh(state, now)) {
    const target = interpretation.resolvedEntities.find(e => e.key === pending.field && e.source !== "CONVERSATION_CONTEXT" && e.certainty === "EXACT" && e.confidence >= high);
    const matches = target ? state.offeredOptions.filter(o => o.value === (target.normalizedValue ?? target.value)) : [];
    if (matches.length === 1) interpretation.selectedOption = { optionId: matches[0]!.id, position: matches[0]!.position, value: matches[0]!.value, confidence: target!.confidence };
  }
  const selection = interpretation.selectedOption;
  let selected = selection ? state.offeredOptions.find(o => o.id === selection.optionId) : undefined;
  if (interpretation.optionResolution?.basis === "AMBIGUOUS") return ambiguous("OPTION_REFERENCE_AMBIGUOUS");
  if (selection) {
    if (selection.confidence < high) return ambiguous("OPTION_REFERENCE_AMBIGUOUS");
    if (!selected || !optionsAreFresh(state, now)) return ambiguous("OPTIONS_ABSENT_OR_STALE");
    if (selection.value === selected.label) selection.value = selected.value;
    if (selection.position !== undefined && selection.position !== selected.position || selection.value !== undefined && selection.value !== selected.value) return ambiguous("OPTION_REFERENCE_MISMATCH");
    if (pending?.type !== "OPTION_SELECTION" || !pending.field) return ambiguous("OPTION_TARGET_UNKNOWN");
    const resolution = interpretation.optionResolution;
    if (!resolution || !resolution.candidateOptionIds.includes(selected.id) || resolution.candidateOptionIds.some(id => !state.offeredOptions.some(o => o.id === id))) return ambiguous("OPTION_REFERENCE_AMBIGUOUS");
    if (resolution.anchorMessageId && resolution.basis !== "CONTEXT_FOCUS") return ambiguous("OPTION_REFERENCE_BASIS_CONFLICT");
    let candidates = state.offeredOptions.filter(o => resolution.candidateOptionIds.includes(o.id));
    // Apply the model's structured selector to actual records. This resolves no natural language.
    if (resolution.basis === "POSITION" && selection.position !== undefined) candidates = candidates.filter(o => o.position === selection.position);
    if (resolution.basis === "EXACT_VALUE" && selection.value !== undefined) candidates = candidates.filter(o => o.value === selection.value);
    if (resolution.basis === "CONTEXT_FOCUS") {
      const anchor = snapshot.recentMessages.find(m => m.id === resolution.anchorMessageId && m.id !== message.id && (m.senderType === "AI" || m.senderType === "STAFF"));
      const mentioned = anchor ? state.offeredOptions.filter(o => anchor.text.includes(o.label) || typeof o.value === "string" && anchor.text.includes(o.value)) : [];
      if (mentioned.length !== 1 || mentioned[0]?.id !== selected.id) return ambiguous("OPTION_FOCUS_MISSING");
      candidates = candidates.filter(o => o.id === mentioned[0]!.id);
    }
    if (candidates.length !== 1 || candidates[0]!.id !== selected.id) return ambiguous("OPTION_REFERENCE_AMBIGUOUS");
    resolution.candidateOptionIds = [selected.id];
    interpretation.selectedOption = { optionId: selected.id, position: selected.position, value: selected.value, confidence: selection.confidence };
  }
  for (const entity of interpretation.resolvedEntities) {
    if (entity.confidence < high || entity.certainty !== "EXACT") return ambiguous("ENTITY_REQUIRES_CLARIFICATION");
    const evidenceMessages = [message, ...snapshot.recentMessages];
    if (!entity.evidence.every(e => evidenceMessages.some(m => m.id === e.messageId && m.text.includes(e.quote)))) return ambiguous("ENTITY_EVIDENCE_INVALID");
    if (entity.source !== "CONVERSATION_CONTEXT" && !entity.evidence.some(e => e.messageId === message.id)) return ambiguous("CURRENT_MESSAGE_EVIDENCE_REQUIRED");
    if (entity.source === "CONVERSATION_CONTEXT" && known[entity.key] && (known[entity.key]!.normalizedValue ?? known[entity.key]!.value) !== (entity.normalizedValue ?? entity.value)) return ambiguous("CONTEXT_CANNOT_OVERRIDE_CURRENT_STATE");
    // Normalize a proven selected option into its typed target; no language guessing is involved.
    if (selected && pending?.field === entity.key && (entity.normalizedValue ?? entity.value) === selected.value && entity.source !== "CONVERSATION_CONTEXT" && (!entity.reference || entity.reference.type === "EXPECTATION")) {
      entity.source = "REFERENCE_RESOLUTION";
      entity.reference = { type: "OPTION", optionId: selected.id };
    }
    if (entity.source === "REFERENCE_RESOLUTION" || entity.reference) {
      const reference = entity.reference;
      if (!reference) return ambiguous("REFERENCE_TARGET_MISSING");
      entity.source = "REFERENCE_RESOLUTION";
      if (reference.type === "EXPECTATION" && (!pending || pending.field !== entity.key)) return ambiguous("EXPECTATION_MISMATCH");
      if (reference.type === "ENTITY" && (!known[reference.key] || (known[reference.key]!.normalizedValue ?? known[reference.key]!.value) !== (entity.normalizedValue ?? entity.value))) return ambiguous("ENTITY_REFERENCE_MISMATCH");
      if (reference.type === "OPTION" && (!selected || reference.optionId !== selected.id || pending?.field !== entity.key || (entity.normalizedValue ?? entity.value) !== selected.value)) return ambiguous("OPTION_ENTITY_MISMATCH");
      if (reference.type === "HISTORY" && !snapshot.recentMessages.some(m => m.id === reference.messageId && m.id !== message.id && entity.evidence.some(e => e.messageId === m.id))) return ambiguous("HISTORY_REFERENCE_MISSING");
    }
    const fieldKind = ({ preferredDate: "DATE", preferredTime: "TIME" } as Record<string, string>)[entity.key] ?? (known[entity.key]?.kind !== "TEXT" ? known[entity.key]?.kind : undefined);
    // A normalized scalar can arrive labelled TEXT. Promote only through the canonical field's
    // validator, never by interpreting the utterance or inventing a missing normalized value.
    if (fieldKind && entity.kind === "TEXT" && entity.normalizedValue !== undefined) {
      const typed = entitySchema.safeParse({ value: entity.value, kind: fieldKind, normalizedValue: entity.normalizedValue });
      if (typed.success) entity.kind = typed.data.kind;
    }
    if (fieldKind && fieldKind !== entity.kind) return ambiguous("ENTITY_KIND_MISMATCH");
    if (entity.kind === "DATE") {
      if (!clock || !entity.dateBasis) return ambiguous("DATE_TIMEZONE_OR_BASIS_MISSING");
      if (entity.dateBasis.type === "EXPLICIT" && (typeof entity.normalizedValue !== "string" || !entity.evidence.some(e => e.quote.includes(entity.normalizedValue as string)))) return ambiguous("EXPLICIT_DATE_EVIDENCE_MISSING");
      if (entity.dateBasis.type === "DAY_OFFSET" && entity.normalizedValue !== offsetLocalDate(clock.date, entity.dateBasis.offsetDays)) return ambiguous("RELATIVE_DATE_MISMATCH");
    }
    const parsed = entitySchema.safeParse({ value: entity.value, kind: entity.kind, normalizedValue: entity.normalizedValue, confidence: entity.confidence, sourceMessageId: message.id, updatedAt: new Date(now).toISOString() });
    if (!parsed.success) return ambiguous("ENTITY_NORMALIZATION_INVALID");
    known[entity.key] = parsed.data;
    commands.push({ type: "SET_ENTITY", key: entity.key });
  }
  if (selected && pending?.field) {
    const resolved = interpretation.resolvedEntities.find(e => e.key === pending.field);
    // A choice needs an explicitly typed target. Never assume options are appointment times.
    if (!resolved || (resolved.normalizedValue ?? resolved.value) !== selected.value || resolved.source !== "REFERENCE_RESOLUTION" || resolved.reference?.type !== "OPTION") return ambiguous("OPTION_ENTITY_MISMATCH");
  }
  if (interpretation.correction?.isCorrection) {
    const key = interpretation.correction.replacesEntity;
    if (!key || !state.knownEntities[key] || !interpretation.resolvedEntities.some(e => e.key === key && e.source !== "CONVERSATION_CONTEXT")) return ambiguous("CORRECTION_TARGET_INVALID");
  }
  // Some JSON models emit the inactive optional branch as UNCLEAR/0. It conveys no confirmation.
  if (pending?.type !== "CONFIRMATION" && interpretation.confirmation?.type === "UNCLEAR" && interpretation.confirmation.confidence === 0) delete interpretation.confirmation;
  if (interpretation.confirmation) {
    if (interpretation.confirmation.type === "UNCLEAR" || interpretation.confirmation.confidence < high) return ambiguous("CONFIRMATION_AMBIGUOUS");
    if (pending?.type !== "CONFIRMATION") return ambiguous("CONFIRMATION_NOT_PENDING");
  }
  const interruption = interpretation.topicShift?.detected === true;
  if (!interruption && pending?.type === "CONFIRMATION" && interpretation.confirmation && interpretation.confirmation.type !== "UNCLEAR") {
    if (interpretation.pendingExpectation?.field !== undefined && interpretation.pendingExpectation.field !== pending.field) return ambiguous("EXPECTATION_FIELD_MISMATCH");
    interpretation.pendingExpectation = { resolved: true, ...(pending.field ? { field: pending.field } : {}) };
  }
  if (!interruption && pending?.type === "OPTION_SELECTION" && !selected && interpretation.resolvedEntities.length === 0 && interpretation.intent === continuationIntent(state.activeWorkflow)) return ambiguous("OPTION_REFERENCE_AMBIGUOUS");

  if (interruption && interpretation.topicShift?.from && interpretation.topicShift.from !== state.activeTopic) return ambiguous("TOPIC_REFERENCE_MISMATCH");
  if (interpretation.pendingExpectation?.resolved && !interruption) {
    if (!pending || pending.type === "SYSTEM_RESULT") return ambiguous("EXPECTATION_NOT_CUSTOMER_RESOLVABLE");
    if (interpretation.pendingExpectation.field === undefined && pending.field && interpretation.resolvedEntities.some(e => e.key === pending.field && e.source !== "CONVERSATION_CONTEXT")) interpretation.pendingExpectation.field = pending.field;
    if (pending.field !== interpretation.pendingExpectation.field) return ambiguous("EXPECTATION_FIELD_MISMATCH");
    if (pending.type === "FIELD" && !interpretation.resolvedEntities.some(e => e.key === pending.field && e.source !== "CONVERSATION_CONTEXT")) return ambiguous("EXPECTATION_VALUE_MISSING");
    if (pending.type === "OPTION_SELECTION" && !selected) return ambiguous("OPTION_REFERENCE_MISSING");
    if (pending.type === "CONFIRMATION" && !interpretation.confirmation) return ambiguous("CONFIRMATION_MISSING");
    if (pending.type === "FREE_TEXT") return ambiguous("FREE_TEXT_REQUIRES_PLANNER");
    Object.assign(patch, { awaiting: null, lastAssistantQuestion: null, workflowStatus: state.activeWorkflow ? "ACTIVE" : "IDLE" });
    if (selected) patch.offeredOptions = [];
    commands.push({ type: "CLEAR_AWAITING" });
  }
  const workflow = interpretation.workflow;
  if (workflow && workflow.action !== "NONE" && (!interruption || workflow.action === "CANCEL" && interpretation.intent === "CANCELLATION_INTENT")) {
    if (workflow.action === "START") {
      if (!workflow.name || state.activeWorkflow && state.activeWorkflow !== workflow.name) return ambiguous("ACTIVE_WORKFLOW_MUST_BE_PRESERVED");
      if (interpretation.topic && workflowTopic[workflow.name] !== interpretation.topic) return ambiguous("WORKFLOW_TOPIC_MISMATCH");
      // Starting requires current-message evidence, not memory or an isolated reference.
      if (!interpretation.resolvedEntities.some(e => e.source === "CURRENT_MESSAGE")) return ambiguous("WORKFLOW_START_EVIDENCE_MISSING");
      Object.assign(patch, { activeTopic: workflowTopic[workflow.name], activeWorkflow: workflow.name, workflowStatus: "ACTIVE", previousTopic: state.activeTopic });
    } else {
      if (!state.activeWorkflow || workflow.name && workflow.name !== state.activeWorkflow) return ambiguous("WORKFLOW_REFERENCE_MISMATCH");
      if (workflow.action === "CONFIRM" && (pending?.type !== "CONFIRMATION" || interpretation.confirmation?.type !== "YES")) return ambiguous("WORKFLOW_CONFIRMATION_MISSING");
      if (workflow.action === "CANCEL" && interpretation.intent !== "CANCELLATION_INTENT") return ambiguous("CANCELLATION_INTENT_REQUIRED");
      if (workflow.action === "CANCEL") Object.assign(patch, { activeWorkflow: null, workflowStatus: "CANCELLED", awaiting: null, lastAssistantQuestion: null, offeredOptions: [] });
      if (workflow.action === "PAUSE") patch.workflowStatus = "PAUSED";
      if (workflow.action === "RESUME") {
        if (state.workflowStatus !== "PAUSED") return ambiguous("WORKFLOW_NOT_PAUSED");
        patch.workflowStatus = pending ? pending.type === "SYSTEM_RESULT" ? "WAITING_FOR_SYSTEM" : "WAITING_FOR_CUSTOMER" : "ACTIVE";
      }
    }
    commands.push({ type: "SET_WORKFLOW", name: workflow.name ?? state.activeWorkflow!, action: workflow.action });
  }
  if (interpretation.resolvedEntities.length) patch.knownEntities = known;
  commands.push({ type: "SET_INTENT", intent: interpretation.intent });
  return { interpretation, patch, commands };
}
