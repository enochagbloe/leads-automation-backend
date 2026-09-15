import { z } from "zod";
import { conversationPlanSchema } from "./conversation-plan.schema";
import { entityKeySchema } from "./conversation-state.schema";

export const responseClaims = ["APPOINTMENT_CONFIRMED", "AVAILABILITY", "HANDOFF", "PAYMENT", "REFUND", "QUOTE", "STAFF_ASSIGNED"] as const;
export const workflowExecutionResultSchema = z.object({
  businessId: z.string().min(1), conversationId: z.string().min(1), sourceMessageId: z.string().min(1), stateRevision: z.number().int().nonnegative(),
  status: z.enum(["REQUESTED", "SUCCEEDED", "FAILED", "NOT_EXECUTED"]),
  claims: z.array(z.enum(responseClaims)).max(7),
}).strict();
export type WorkflowExecutionResult = z.infer<typeof workflowExecutionResultSchema>;
// Existing complaint extraction remains supplemental; canonical intent and routing belong to the backend.
export const responseComplaintSchema = z.object({
  category: z.enum(["DELAY", "POOR_SERVICE", "QUALITY_ISSUE", "STAFF_BEHAVIOR", "MISCOMMUNICATION", "PAYMENT_ISSUE", "APPOINTMENT_ISSUE", "DELIVERY_OR_SITE_ISSUE", "MISSING_ITEM_OR_MISSING_WORK", "FOLLOW_UP_REQUIRED", "OTHER"]),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]), summary: z.string().min(1).max(500),
  requiresInternalAction: z.boolean(), suggestedStaffSpecialtyTags: z.array(z.string().min(1).max(80)).max(12),
  matchType: z.enum(["NEW", "CONTINUATION", "FOLLOW_UP_TO_RESOLVED"]), matchedIssueId: z.string().min(1).max(80).nullable(),
}).strict();
export const conversationResponseSchema = z.object({
  complaints: z.array(responseComplaintSchema).max(5).default([]),
  text: z.string().trim().min(1).max(1000).nullable(),
  acknowledgedContext: z.boolean(), fulfilledPurpose: conversationPlanSchema.innerType().shape.responseDirective.shape.purpose,
  askedField: entityKeySchema.nullable(), questionCount: z.number().int().min(0).max(4),
  referencedOptionIds: z.array(entityKeySchema).max(12), referencedFactIds: z.array(z.string().min(1).max(128)).max(12),
  claimsActionCompleted: z.boolean(), claims: z.array(z.enum(responseClaims)).max(7),
  confidence: z.number().min(0).max(1), requiresHumanReview: z.boolean(),
}).strict();
export type ConversationResponse = z.infer<typeof conversationResponseSchema>;
const string = { type: "string" }; const boolean = { type: "boolean" };
export const responseOutputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    complaints: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      category: { type: "string", enum: responseComplaintSchema.shape.category.options }, severity: { type: "string", enum: responseComplaintSchema.shape.severity.options },
      summary: string, requiresInternalAction: boolean, suggestedStaffSpecialtyTags: { type: "array", items: string },
      matchType: { type: "string", enum: responseComplaintSchema.shape.matchType.options }, matchedIssueId: { anyOf: [string, { type: "null" }] },
    }, required: ["category", "severity", "summary", "requiresInternalAction", "suggestedStaffSpecialtyTags", "matchType", "matchedIssueId"] } },
    text: { anyOf: [string, { type: "null" }] }, acknowledgedContext: boolean,
    fulfilledPurpose: { type: "string", enum: ["ANSWER_CUSTOMER", "COLLECT_INFORMATION", "CLARIFY", "CONFIRM", "PRESENT_OPTIONS", "ACKNOWLEDGE", "HANDOFF", "WAIT", "WORKFLOW_RESULT"] },
    askedField: { anyOf: [string, { type: "null" }] }, questionCount: { type: "integer" },
    referencedOptionIds: { type: "array", items: string }, referencedFactIds: { type: "array", items: string }, claimsActionCompleted: boolean,
    claims: { type: "array", items: { type: "string", enum: responseClaims } }, confidence: { type: "number" }, requiresHumanReview: boolean,
  },
  required: ["complaints", "text", "acknowledgedContext", "fulfilledPurpose", "askedField", "questionCount", "referencedOptionIds", "referencedFactIds", "claimsActionCompleted", "claims", "confidence", "requiresHumanReview"],
};
export type ResponseValidationMetadata = { validationVersion: 1; source: "MODEL" | "PLAN_FALLBACK" | "WORKFLOW_RESULT"; fulfilledPurpose: ConversationResponse["fulfilledPurpose"]; askedField: string | null; referencedOptionIds: string[]; claimsActionCompleted: boolean; regenerationCount: number; fallbackUsed: boolean };
