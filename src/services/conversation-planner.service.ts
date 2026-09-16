import { conversationTransactionOptions } from "./conversation-transaction";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { conversationPlanSchema, ConversationPlan } from "./conversation-plan.schema";
import { conversationWorkflowPlanningService, PlanningInput } from "./conversation-workflow-planning.service";
import { assertConversationScope, conversationStateService } from "./conversation-state.service";
import { interpretationSchema } from "./conversation-interpretation.schema";
import { optionsAreFresh } from "./conversation-interpretation-policy";
import { StatePatch } from "./conversation-state.schema";

export async function assertPlanCurrent(plan: ConversationPlan, transaction?: Prisma.TransactionClient): Promise<void> {
  if (!transaction) return prisma.$transaction(tx => assertPlanCurrent(plan, tx), conversationTransactionOptions());
  const tx = transaction;
  conversationPlanSchema.parse(plan);
  const conversation = await assertConversationScope(tx, plan);
  // Demo rows intentionally disable production automation. Scope/expiry were validated above.
  const productionAiDisabled = !plan.demoSessionId && conversation.aiEnabled === false;
  if (plan.move !== "NO_ACTION" && (conversation.humanTakeover || conversation.status === "NEEDS_HUMAN_REVIEW" || productionAiDisabled)) throw new AppError(409, "Conversation control changed; automated plan is no longer eligible", "CONVERSATION_PLAN_CONTROL_CHANGED");
  const source = await tx.message.findFirst({ where: { id: plan.sourceMessageId, businessId: plan.businessId, conversationId: plan.conversationId, senderType: "CUSTOMER", direction: "INBOUND", deletedAt: null }, select: { id: true } });
  if (!source) throw new AppError(403, "Plan source forbidden", "CONVERSATION_STATE_FORBIDDEN");
  const state = await conversationStateService.get(plan, tx);
  if (state.revision !== plan.stateRevision) {
    console.warn("conversation_plan.conflict", { businessId: plan.businessId, conversationId: plan.conversationId, sourceMessageId: plan.sourceMessageId, stateRevision: plan.stateRevision });
    throw new AppError(409, "Conversation changed; reload and re-plan", "CONVERSATION_STATE_CONFLICT");
  }
}

export const conversationPlannerService = {
  async plan(input: PlanningInput): Promise<ConversationPlan> {
    const { conversationSnapshot: snapshot, interpretation: meaning, businessContext: context } = input;
    interpretationSchema.parse(meaning);
    const s = snapshot.state;
    if (s.businessId !== context.business.id || s.conversationId !== context.conversation.id || snapshot.currentMessage?.id !== context.triggerMessage.id) throw new AppError(403, "Plan context scope mismatch", "CONVERSATION_STATE_FORBIDDEN");
    const base: ConversationPlan = { version: 1, businessId: s.businessId, conversationId: s.conversationId, sourceMessageId: context.triggerMessage.id, ...(context.demoSessionId ? { demoSessionId: context.demoSessionId } : {}), move: "ANSWER", intent: meaning.intent, topic: s.activeTopic, ...(s.activeWorkflow ? { workflow: s.activeWorkflow } : {}), reasonCode: "GENERAL_ANSWER", missingFields: [], knownFields: Object.keys(s.knownEntities), responseDirective: { purpose: "ANSWER_CUSTOMER", acknowledgeContext: true, askOneQuestion: false }, confidence: meaning.confidence, requiresHumanReview: false, stateRevision: s.revision, ...(meaning.selectedOption ? { selectedOptionId: meaning.selectedOption.optionId } : {}) };
    await assertPlanCurrent(base);
    const finish = async (move: ConversationPlan["move"], reasonCode: string, purpose: ConversationPlan["responseDirective"]["purpose"], extra: Partial<ConversationPlan> = {}) => {
      const plan = conversationPlanSchema.parse({ ...base, move, reasonCode, responseDirective: { acknowledgeContext: true, askOneQuestion: move.startsWith("ASK_"), purpose }, ...extra });
      await assertPlanCurrent(plan); // An asynchronous adapter may have outlived this revision.
      console.info(move === "ASK_FOR_CLARIFICATION" ? "conversation_plan.clarification" : plan.workflowRequest ? "conversation_plan.workflow_ready" : "conversation_plan.created", { businessId: plan.businessId, conversationId: plan.conversationId, sourceMessageId: plan.sourceMessageId, stateRevision: plan.stateRevision, intent: plan.intent, move, workflow: plan.workflow, targetField: plan.targetField, reasonCode, requiresHumanReview: plan.requiresHumanReview });
      return plan;
    };
    // Safety, ambiguity, explicit intent, interruptions, lifecycle, provider requirements.
    if (context.conversation.humanTakeover || context.conversation.status === "NEEDS_HUMAN_REVIEW" || context.planCapabilities?.aiReplies === false) return finish("NO_ACTION", "HUMAN_OR_POLICY_CONTROL", "WAIT", { requiresHumanReview: true });
    if (meaning.needsClarification) {
      // Ask about one explicitly evidenced uncertain temporal value, without applying it to state.
      const uncertain = meaning.resolvedEntities.filter(e => ["preferredDate", "preferredTime"].includes(e.key) && e.certainty !== "EXACT" && e.evidence.some(q => q.messageId === snapshot.currentMessage?.id && snapshot.currentMessage.text.includes(q.quote)));
      return finish("ASK_FOR_CLARIFICATION", meaning.clarificationReason ?? "INTERPRETATION_AMBIGUOUS", "CLARIFY", uncertain.length === 1 ? { targetField: uncertain[0]!.key } : {});
    }
    if (meaning.intent === "GENERAL_QUESTION" && meaning.conversationAct === "GREETING") return finish("ANSWER", "CUSTOMER_GREETING", "ANSWER_CUSTOMER", { responseDirective: { acknowledgeContext: false, askOneQuestion: true, purpose: "ANSWER_CUSTOMER" } });
    if (meaning.intent === "HUMAN_REQUEST") return finish("REQUEST_HUMAN", "CUSTOMER_REQUESTED_HUMAN", "HANDOFF", { requiresHumanReview: !context.demoSessionId });
    if (meaning.intent === "COMPLAINT") return finish("REQUEST_HUMAN", "EXISTING_COMPLAINT_POLICY", "HANDOFF", { requiresHumanReview: !context.demoSessionId });
    const interrupted = meaning.topicShift?.detected || ["GENERAL_QUESTION", "SERVICE_INQUIRY", "PRICING_INQUIRY", "AVAILABILITY_INQUIRY", "PAYMENT_QUESTION"].includes(meaning.intent);
    if (interrupted) return finish("ANSWER", "CURRENT_QUESTION_FIRST", "ANSWER_CUSTOMER", { ...(s.activeWorkflow ? { suspendedContext: { workflow: s.activeWorkflow, ...(s.awaiting?.field ? { stillAwaiting: s.awaiting.field } : {}) } } : {}) });
    if (meaning.workflow?.action === "CANCEL" || meaning.intent === "CANCELLATION_INTENT") return finish("CANCEL_WORKFLOW", "CUSTOMER_CANCELLED_WORKFLOW", "ACKNOWLEDGE");
    if (meaning.workflow?.action === "PAUSE" || s.workflowStatus === "PAUSED") return finish("PAUSE_WORKFLOW", "WORKFLOW_PAUSED", "ACKNOWLEDGE");
    if (s.workflowStatus === "WAITING_FOR_SYSTEM" || s.awaiting?.type === "SYSTEM_RESULT") return finish("WAIT_FOR_SYSTEM", "BACKEND_RESULT_PENDING", "WAIT");
    if (meaning.confirmation?.type === "NO") return finish("ASK_FOR_CLARIFICATION", "CONFIRMATION_REJECTED", "CLARIFY");
    if (s.awaiting?.type === "CONFIRMATION") return finish("ASK_FOR_CONFIRMATION", "CONFIRMATION_PENDING", "CONFIRM");
    if (s.awaiting?.type === "OPTION_SELECTION" && !meaning.selectedOption) {
      if (optionsAreFresh(s) && s.awaiting.field) return finish("ASK_FOR_OPTION", "OPTION_SELECTION_PENDING", "PRESENT_OPTIONS", { targetField: s.awaiting.field, options: s.offeredOptions });
      return finish("ASK_FOR_CLARIFICATION", "OPTIONS_ABSENT_OR_STALE", "CLARIFY");
    }
    if (s.awaiting?.type === "FIELD" && s.awaiting.field && s.awaiting.field !== "service" && !s.knownEntities[s.awaiting.field]) return finish("ASK_FOR_FIELD", "PENDING_FIELD", "COLLECT_INFORMATION", { targetField: s.awaiting.field, missingFields: [s.awaiting.field] });
    const workflow = s.activeWorkflow ?? (meaning.intent === "BOOKING_INTENT" ? "APPOINTMENT_BOOKING" : undefined);
    if (workflow) {
      let inspection;
      try { inspection = await conversationWorkflowPlanningService.inspect(workflow, input); }
      catch { console.warn("conversation_plan.failed", { businessId: base.businessId, conversationId: base.conversationId, sourceMessageId: base.sourceMessageId, reasonCode: "ADAPTER_UNAVAILABLE" }); return finish("ASK_FOR_CLARIFICATION", "WORKFLOW_PROVIDER_UNAVAILABLE", "CLARIFY"); }
      if (inspection) {
        const missing = inspection.requirements.filter(r => r.required && !r.satisfied).sort((a, b) => a.priority - b.priority);
        const extra = { workflow, topic: workflow === "APPOINTMENT_BOOKING" ? "APPOINTMENT" as const : base.topic, missingFields: [...new Set(missing.map(r => r.key))], knownFields: [...new Set([...base.knownFields, ...inspection.requirements.filter(r => r.satisfied).map(r => r.key)])].slice(0, 32) };
        if (inspection.status === "NEEDS_INPUT") return finish("ASK_FOR_FIELD", inspection.reasonCode, "COLLECT_INFORMATION", { ...extra, targetField: missing[0]?.key ?? inspection.targetField });
        if (inspection.status === "NEEDS_CLARIFICATION") return finish("ASK_FOR_CLARIFICATION", inspection.reasonCode, "CLARIFY", { ...extra, targetField: inspection.targetField });
        if (inspection.status === "HUMAN_REQUIRED") return finish("REQUEST_HUMAN", inspection.reasonCode, "HANDOFF", { ...extra, requiresHumanReview: !context.demoSessionId });
        if (inspection.status === "OPTIONS") return finish("ASK_FOR_OPTION", inspection.reasonCode, "PRESENT_OPTIONS", { ...extra, targetField: inspection.targetField, options: inspection.options });
        if (inspection.status === "NEEDS_CONFIRMATION") return finish("ASK_FOR_CONFIRMATION", inspection.reasonCode, "CONFIRM", extra);
        if (inspection.status === "WAITING") return finish("WAIT_FOR_SYSTEM", inspection.reasonCode, "WAIT", extra);
        return finish("CONTINUE_WORKFLOW", inspection.reasonCode, "ACKNOWLEDGE", { ...extra, workflowRequest: inspection.action });
      }
    }
    if (s.awaiting?.type === "FIELD" && s.awaiting.field && !s.knownEntities[s.awaiting.field]) return finish("ASK_FOR_FIELD", "PENDING_FIELD", "COLLECT_INFORMATION", { targetField: s.awaiting.field, missingFields: [s.awaiting.field] });
    return finish("ANSWER", "GENERAL_ANSWER", "ANSWER_CUSTOMER");
  },
};

/** Derived only from trusted plan; call with the final text inside the message transaction. */
export function assistantPlanPatch(plan: ConversationPlan, text: string): StatePatch {
  conversationPlanSchema.parse(plan);
  const question = text.trim();
  if (plan.move.startsWith("ASK_") && (!question || question.length > 1000)) throw new AppError(422, "Planned question exceeds state bounds", "CONVERSATION_PLAN_REPLY_INVALID");
  const active = { ...(plan.workflow ? { activeWorkflow: plan.workflow, activeTopic: plan.topic ?? null } : {}), workflowStatus: "WAITING_FOR_CUSTOMER" as const };
  if (plan.move === "ASK_FOR_FIELD") return { ...active, awaiting: { type: "FIELD", field: plan.targetField!, question }, lastAssistantQuestion: question, offeredOptions: [] };
  if (plan.move === "ASK_FOR_CONFIRMATION") return { ...active, awaiting: { type: "CONFIRMATION", question }, lastAssistantQuestion: question, offeredOptions: [] };
  if (plan.move === "ASK_FOR_OPTION") return { ...active, awaiting: { type: "OPTION_SELECTION", field: plan.targetField!, question }, lastAssistantQuestion: question, offeredOptions: plan.options! };
  if (plan.move === "WAIT_FOR_SYSTEM") return { workflowStatus: "WAITING_FOR_SYSTEM", awaiting: { type: "SYSTEM_RESULT" }, lastAssistantQuestion: null, offeredOptions: [] };
  if (plan.move === "CANCEL_WORKFLOW") return { activeWorkflow: null, workflowStatus: "CANCELLED", awaiting: null, lastAssistantQuestion: null, offeredOptions: [] };
  // Clarification preserves unresolved typed expectation/options; interruptions preserve all workflow context.
  if (plan.move === "ASK_FOR_CLARIFICATION") return plan.targetField
    ? { ...active, awaiting: { type: "FIELD", field: plan.targetField, question }, lastAssistantQuestion: question, offeredOptions: [] }
    : { ...(!plan.workflow ? { workflowStatus: "IDLE" as const } : {}), lastAssistantQuestion: question };
  return {};
}
