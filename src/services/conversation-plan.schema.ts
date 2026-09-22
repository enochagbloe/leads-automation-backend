import { z } from "zod";
import { AI_REPLY_INTENTS } from "./ai-decision-parser.service";
import { entityKeySchema, optionsSchema, stateDataSchema } from "./conversation-state.schema";

export const conversationPlanSchema = z.object({
  version: z.literal(1), businessId: z.string().min(1).max(128), conversationId: z.string().min(1).max(128), sourceMessageId: z.string().min(1).max(128), demoSessionId: z.string().min(1).max(128).optional(),
  move: z.enum(["ANSWER", "ASK_FOR_FIELD", "ASK_FOR_CONFIRMATION", "ASK_FOR_OPTION", "ASK_FOR_CLARIFICATION", "CONTINUE_WORKFLOW", "START_WORKFLOW", "PAUSE_WORKFLOW", "RESUME_WORKFLOW", "CANCEL_WORKFLOW", "REQUEST_HUMAN", "WAIT_FOR_SYSTEM", "NO_ACTION"]),
  intent: z.enum(AI_REPLY_INTENTS), topic: stateDataSchema.shape.activeTopic.optional(), workflow: entityKeySchema.optional(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/), targetField: entityKeySchema.optional(),
  missingFields: z.array(entityKeySchema).max(32), knownFields: z.array(entityKeySchema).max(32), selectedOptionId: entityKeySchema.optional(),
  workflowRequest: z.object({ type: z.enum(["CREATE_BOOKING_REQUEST", "CHECK_APPOINTMENT_AVAILABILITY"]), serviceId: z.string().min(1).max(128).optional(), preferredDate: z.string().max(10), preferredTime: z.string().max(5), timezone: z.string().max(100) }).strict().optional(),
  options: optionsSchema.optional(),
  suspendedContext: z.object({ workflow: entityKeySchema, stillAwaiting: entityKeySchema.optional() }).strict().optional(),
  responseDirective: z.object({ acknowledgeContext: z.boolean(), askOneQuestion: z.boolean(), purpose: z.enum(["ANSWER_CUSTOMER", "COLLECT_INFORMATION", "CLARIFY", "CONFIRM", "PRESENT_OPTIONS", "ACKNOWLEDGE", "HANDOFF", "WAIT", "WORKFLOW_RESULT"]) }).strict(),
  confidence: z.number().min(0).max(1), requiresHumanReview: z.boolean(), stateRevision: z.number().int().nonnegative(),
}).strict().superRefine((p, ctx) => {
  if ((p.move === "ASK_FOR_FIELD" || p.move === "ASK_FOR_OPTION") && !p.targetField) ctx.addIssue({ code: "custom", message: "A target field is required" });
  if (p.move === "ASK_FOR_OPTION" && !p.options?.length) ctx.addIssue({ code: "custom", message: "Trusted options are required" });
  if (p.options?.length && p.move !== "ASK_FOR_OPTION") ctx.addIssue({ code: "custom", message: "Options belong to an option move" });
  if (p.workflowRequest && (p.move !== "CONTINUE_WORKFLOW" || p.requiresHumanReview)) ctx.addIssue({ code: "custom", message: "Request is incompatible with move" });
  if (p.demoSessionId && p.workflowRequest?.type === "CREATE_BOOKING_REQUEST") ctx.addIssue({ code: "custom", message: "Demo cannot request production mutation" });
});
export type ConversationPlan = z.infer<typeof conversationPlanSchema>;
