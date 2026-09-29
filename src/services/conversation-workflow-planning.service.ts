import { bookingPurposeRequirement, resolvedConversationService } from "./conversation-purpose-policy";
import { ConversationRuntimeTiming } from "./conversation-runtime-timing";
import type { WorkflowExecutionResult } from "./conversation-response.schema";
import type { AiBusinessContext } from "./ai-context-builder.service";
import type { ConversationContextSnapshot } from "./conversation-context.service";
import type { ConversationInterpretation } from "./conversation-interpretation.schema";
import type { ConversationPlan } from "./conversation-plan.schema";
import { missingAiBookingFields } from "./appointment/appointment-conversation-requirements";
import { checkSlot } from "./appointment/appointment-availability.service";

export const appointmentPlanningBackend = { checkSlot };

export type PlanningInput = { timing?: ConversationRuntimeTiming; conversationSnapshot: ConversationContextSnapshot; interpretation: ConversationInterpretation; businessContext: AiBusinessContext; onWorkflowResult?: (result: WorkflowExecutionResult) => void };
export type WorkflowRequirement = { key: string; required: boolean; satisfied: boolean; priority: number; source: "CONVERSATION_STATE" | "WORKFLOW_PROVIDER" | "BACKEND_STATE"; group?: string };
export type WorkflowPlanningResult = {
  status: "NEEDS_INPUT" | "NEEDS_CLARIFICATION" | "READY_FOR_ACTION" | "NEEDS_CONFIRMATION" | "OPTIONS" | "WAITING" | "HUMAN_REQUIRED";
  requirements: WorkflowRequirement[]; reasonCode: string; targetField?: string; options?: ConversationPlan["options"]; action?: ConversationPlan["workflowRequest"];
};
export interface ConversationWorkflowPlanningAdapter { supports(workflow: string): boolean; inspect(input: PlanningInput): Promise<WorkflowPlanningResult>; continuationField?(input: PlanningInput): "preferredDate" | "preferredTime" | undefined; }
const value = (input: PlanningInput, key: string) => { const e = input.conversationSnapshot.state.knownEntities[key]; return e?.normalizedValue ?? e?.value; };
const text = (input: PlanningInput, key: string) => typeof value(input, key) === "string" ? value(input, key) as string : undefined;

/** Reads existing catalog configuration; actual validation/availability/creation stays in appointment module. */
export const appointmentConversationAdapter: ConversationWorkflowPlanningAdapter = {
  supports: workflow => workflow === "APPOINTMENT_BOOKING",
  continuationField(input) {
    // Pure requirements only: a side question must never check slots or execute a workflow.
    const { businessContext: context, conversationSnapshot: snapshot } = input;
    const service = resolvedConversationService(snapshot.state, context);
    if (!service || context.safetyInstructions?.canDetectBookingIntent === false) return undefined;
    if (context.runtimeKnowledgeGuards?.some(g => ["SERVICE", "BUSINESS_AVAILABILITY", "APPOINTMENT_SETTINGS"].includes(g.canonicalEntityType) && (!g.canonicalEntityId || g.canonicalEntityType !== "SERVICE" || g.canonicalEntityId === service.id))) return undefined;
    if (!context.demoSessionId && (!service.isBookable || !service.durationMinutes || !snapshot.timezone)) return undefined;
    const missing = missingAiBookingFields({ serviceId: service.id, preferredDate: text(input, "preferredDate"), preferredTime: text(input, "preferredTime") });
    return ["preferredDate", "preferredTime"].find(key => missing.includes(key) && !snapshot.state.knownEntities[key]) as "preferredDate" | "preferredTime" | undefined;
  },
  async inspect(input) {
    const context = input.businessContext;
    const known = Object.keys(input.conversationSnapshot.state.knownEntities);
    const requirements: WorkflowRequirement[] = known.map(key => ({ key, required: false, satisfied: true, priority: 100, source: "CONVERSATION_STATE" }));
    const purpose = bookingPurposeRequirement(input.conversationSnapshot.state, context, input.interpretation);
    if (purpose) return { status: purpose.move === "ASK_FOR_FIELD" ? "NEEDS_INPUT" : "NEEDS_CLARIFICATION", requirements: [{ key: "serviceNeed", required: true, satisfied: false, priority: 0, source: "WORKFLOW_PROVIDER" }], targetField: "serviceNeed", reasonCode: purpose.reasonCode };
    const service = resolvedConversationService(input.conversationSnapshot.state, context);
    const preferredDate = text(input, "preferredDate"); const preferredTime = text(input, "preferredTime");
    // Reuse the actual booking boundary's minimum requirements. A reason is retained but is not a service ID.
    const missing = missingAiBookingFields({ serviceId: service?.id, preferredDate, preferredTime });
    for (const [priority, key] of ["preferredDate", "preferredTime", "service"].entries()) requirements.push({ key, required: true, satisfied: !missing.includes(key), priority, source: key === "service" ? "WORKFLOW_PROVIDER" : "CONVERSATION_STATE" });
    const missingTemporal = requirements.filter(r => r.required && !r.satisfied && r.key !== "service").sort((a, b) => a.priority - b.priority)[0];
    if (missingTemporal) return { status: "NEEDS_INPUT", requirements, targetField: missingTemporal.key, reasonCode: "BOOKING_INFORMATION_REQUIRED" };
    if (context.demoSessionId) {
      // The canonical website catalog resolves services, but never proves slot availability or authorizes bookings.
      return { status: "READY_FOR_ACTION", requirements: requirements.filter(r => r.key !== "service" || r.satisfied), reasonCode: "DEMO_AVAILABILITY_NOT_CONNECTED", action: { type: "CHECK_APPOINTMENT_AVAILABILITY", ...(service ? { serviceId: service.id } : {}), preferredDate: preferredDate!, preferredTime: preferredTime!, timezone: input.conversationSnapshot.timezone ?? "" } };
    }
    if (!service) return { status: "NEEDS_CLARIFICATION", requirements, targetField: "service", reasonCode: "SERVICE_MAPPING_REQUIRED" };
    if (!service.isBookable || !service.durationMinutes || !input.conversationSnapshot.timezone) return { status: "HUMAN_REQUIRED", requirements, reasonCode: "BOOKING_CONFIGURATION_REQUIRES_REVIEW" };
    if (context.runtimeKnowledgeGuards?.some(g => ["SERVICE", "BUSINESS_AVAILABILITY", "APPOINTMENT_SETTINGS"].includes(g.canonicalEntityType) && (!g.canonicalEntityId || g.canonicalEntityType !== "SERVICE" || g.canonicalEntityId === service.id))) return { status: "HUMAN_REQUIRED", requirements, reasonCode: "BOOKING_KNOWLEDGE_REQUIRES_REVIEW" };
    if (context.safetyInstructions?.canDetectBookingIntent === false) return { status: "HUMAN_REQUIRED", requirements, reasonCode: "BOOKING_CAPABILITY_UNAVAILABLE" };
    const availability = await appointmentPlanningBackend.checkSlot({ businessId: context.business.id, serviceId: service.id, date: preferredDate!, time: preferredTime!, timezone: input.conversationSnapshot.timezone, assignedStaffId: context.lead?.assignedStaffId });
    input.onWorkflowResult?.({ businessId: context.business.id, conversationId: context.conversation.id, sourceMessageId: context.triggerMessage.id, stateRevision: input.conversationSnapshot.state.revision, status: "SUCCEEDED", claims: availability.available ? ["AVAILABILITY"] : [] });
    if (!availability.available) return { status: "NEEDS_CLARIFICATION", requirements, targetField: "preferredTime", reasonCode: availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE" };
    return { status: "READY_FOR_ACTION", requirements, reasonCode: "BOOKING_INPUT_READY", action: { type: "CREATE_BOOKING_REQUEST", serviceId: service.id, preferredDate: preferredDate!, preferredTime: preferredTime!, timezone: input.conversationSnapshot.timezone } };
  },
};
export const conversationWorkflowPlanningService = {
  adapters: [appointmentConversationAdapter] as readonly ConversationWorkflowPlanningAdapter[],
  continuationField(workflow: string, input: PlanningInput) {
    return this.adapters.find(a => a.supports(workflow))?.continuationField?.(input);
  },
  async inspect(workflow: string, input: PlanningInput) {
    const adapter = this.adapters.find(a => a.supports(workflow));
    return adapter ? input.timing ? input.timing.measure("workflowMs", () => adapter.inspect(input)) : adapter.inspect(input) : null;
  },
};
