import type { AiBusinessContext } from "./ai-context-builder.service";
import type { ConversationContextSnapshot } from "./conversation-context.service";
import type { ConversationInterpretation } from "./conversation-interpretation.schema";
import type { ConversationPlan } from "./conversation-plan.schema";
import { missingAiBookingFields } from "./appointment/appointment-conversation-requirements";
import { checkSlot } from "./appointment/appointment-availability.service";

export const appointmentPlanningBackend = { checkSlot };

export type PlanningInput = { conversationSnapshot: ConversationContextSnapshot; interpretation: ConversationInterpretation; businessContext: AiBusinessContext };
export type WorkflowRequirement = { key: string; required: boolean; satisfied: boolean; priority: number; source: "CONVERSATION_STATE" | "WORKFLOW_PROVIDER" | "BACKEND_STATE"; group?: string };
export type WorkflowPlanningResult = {
  status: "NEEDS_INPUT" | "NEEDS_CLARIFICATION" | "READY_FOR_ACTION" | "NEEDS_CONFIRMATION" | "OPTIONS" | "WAITING" | "HUMAN_REQUIRED";
  requirements: WorkflowRequirement[]; reasonCode: string; targetField?: string; options?: ConversationPlan["options"]; action?: ConversationPlan["workflowRequest"];
};
export interface ConversationWorkflowPlanningAdapter { supports(workflow: string): boolean; inspect(input: PlanningInput): Promise<WorkflowPlanningResult>; }
const value = (input: PlanningInput, key: string) => { const e = input.conversationSnapshot.state.knownEntities[key]; return e?.normalizedValue ?? e?.value; };
const text = (input: PlanningInput, key: string) => typeof value(input, key) === "string" ? value(input, key) as string : undefined;

/** Reads existing catalog configuration; actual validation/availability/creation stays in appointment module. */
export const appointmentConversationAdapter: ConversationWorkflowPlanningAdapter = {
  supports: workflow => workflow === "APPOINTMENT_BOOKING",
  async inspect(input) {
    const context = input.businessContext;
    const known = Object.keys(input.conversationSnapshot.state.knownEntities);
    const requirements: WorkflowRequirement[] = known.map(key => ({ key, required: false, satisfied: true, priority: 100, source: "CONVERSATION_STATE" }));
    const serviceId = text(input, "serviceId");
    const serviceName = text(input, "serviceName") ?? text(input, "service");
    const catalog = context.services ?? [];
    const matches = catalog.filter(s => serviceId ? s.id === serviceId : serviceName ? s.name.toLocaleLowerCase() === serviceName.toLocaleLowerCase() : false);
    const service = matches.length === 1 ? matches[0] : undefined;
    const preferredDate = text(input, "preferredDate"); const preferredTime = text(input, "preferredTime");
    // Reuse the actual booking boundary's minimum requirements. A reason is retained but is not a service ID.
    const missing = missingAiBookingFields({ serviceId: service?.id, preferredDate, preferredTime });
    for (const [priority, key] of ["preferredDate", "preferredTime", "service"].entries()) requirements.push({ key, required: true, satisfied: !missing.includes(key), priority, source: key === "service" ? "WORKFLOW_PROVIDER" : "CONVERSATION_STATE" });
    const missingTemporal = requirements.filter(r => r.required && !r.satisfied && r.key !== "service").sort((a, b) => a.priority - b.priority)[0];
    if (missingTemporal) return { status: "NEEDS_INPUT", requirements, targetField: missingTemporal.key, reasonCode: "BOOKING_INFORMATION_REQUIRED" };
    if (context.demoSessionId) {
      // Temporary website facts are not a production service catalog or availability source.
      return { status: "READY_FOR_ACTION", requirements: requirements.filter(r => r.key !== "service" || r.satisfied), reasonCode: "DEMO_AVAILABILITY_NOT_CONNECTED", action: { type: "CHECK_APPOINTMENT_AVAILABILITY", preferredDate: preferredDate!, preferredTime: preferredTime!, timezone: input.conversationSnapshot.timezone ?? "" } };
    }
    if (!service) return { status: "NEEDS_CLARIFICATION", requirements, targetField: "service", reasonCode: "SERVICE_MAPPING_REQUIRED" };
    if (!service.isBookable || !service.durationMinutes || !input.conversationSnapshot.timezone) return { status: "HUMAN_REQUIRED", requirements, reasonCode: "BOOKING_CONFIGURATION_REQUIRES_REVIEW" };
    if (context.runtimeKnowledgeGuards?.some(g => ["SERVICE", "BUSINESS_AVAILABILITY", "APPOINTMENT_SETTINGS"].includes(g.canonicalEntityType) && (!g.canonicalEntityId || g.canonicalEntityType !== "SERVICE" || g.canonicalEntityId === service.id))) return { status: "HUMAN_REQUIRED", requirements, reasonCode: "BOOKING_KNOWLEDGE_REQUIRES_REVIEW" };
    if (context.safetyInstructions?.canDetectBookingIntent === false) return { status: "HUMAN_REQUIRED", requirements, reasonCode: "BOOKING_CAPABILITY_UNAVAILABLE" };
    const availability = await appointmentPlanningBackend.checkSlot({ businessId: context.business.id, serviceId: service.id, date: preferredDate!, time: preferredTime!, timezone: input.conversationSnapshot.timezone, assignedStaffId: context.lead?.assignedStaffId });
    if (!availability.available) return { status: "NEEDS_CLARIFICATION", requirements, targetField: "preferredTime", reasonCode: availability.reason ?? "APPOINTMENT_SLOT_UNAVAILABLE" };
    return { status: "READY_FOR_ACTION", requirements, reasonCode: "BOOKING_INPUT_READY", action: { type: "CREATE_BOOKING_REQUEST", serviceId: service.id, preferredDate: preferredDate!, preferredTime: preferredTime!, timezone: input.conversationSnapshot.timezone } };
  },
};
export const conversationWorkflowPlanningService = {
  adapters: [appointmentConversationAdapter] as readonly ConversationWorkflowPlanningAdapter[],
  async inspect(workflow: string, input: PlanningInput) {
    const adapter = this.adapters.find(a => a.supports(workflow));
    return adapter ? adapter.inspect(input) : null;
  },
};
