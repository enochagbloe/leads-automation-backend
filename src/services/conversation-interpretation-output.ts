import { AI_REPLY_INTENTS } from "./ai-decision-parser.service";
import { workflowNames } from "./conversation-interpretation.schema";

// Provider transport schema. Semantic constraints and all size/range checks remain in Zod/policy.
// All properties are required and optional meanings use null, for strict structured-output compatibility.
const text = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const enumeration = (values: readonly string[]) => ({ type: "string", enum: values });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const scalar = { anyOf: [text, number, boolean] };
const topic = enumeration(["GENERAL_ENQUIRY", "SERVICE_ENQUIRY", "APPOINTMENT", "FOLLOW_UP", "COMPLAINT", "QUOTATION", "PAYMENT", "HUMAN_HANDOFF"]);
export const interpretationOutputSchema = object({
  intent: enumeration(AI_REPLY_INTENTS),
  conversationAct: nullable(enumeration(["GREETING"])),
  topic: nullable(topic),
  workflow: nullable(object({ name: nullable(enumeration(workflowNames)), action: enumeration(["START", "CONTINUE", "UPDATE", "CONFIRM", "CANCEL", "PAUSE", "RESUME", "NONE"]) })),
  optionResolution: { anyOf: [
    { type: "null" },
    object({ basis: enumeration(["POSITION", "EXACT_VALUE", "ORDER", "AMBIGUOUS"]), candidateOptionIds: { type: "array", items: text }, anchorMessageId: { type: "null" } }),
    object({ basis: enumeration(["CONTEXT_FOCUS"]), candidateOptionIds: { type: "array", items: text }, anchorMessageId: text }),
  ] },
  selectedOption: nullable(object({ optionId: text, position: nullable({ type: "integer" }), value: nullable(scalar), confidence: number })),
  resolvedEntities: { type: "array", items: object({
    key: text, value: scalar, kind: enumeration(["TEXT", "TIME", "DATE", "NUMBER", "BOOLEAN"]), normalizedValue: nullable(scalar),
    confidence: number, certainty: enumeration(["EXACT", "APPROXIMATE", "AMBIGUOUS"]), source: enumeration(["CURRENT_MESSAGE", "REFERENCE_RESOLUTION", "CONVERSATION_CONTEXT"]),
    evidence: { type: "array", items: object({ messageId: text, quote: text }) },
    reference: { anyOf: [
      { type: "null" }, object({ type: enumeration(["EXPECTATION"]) }),
      object({ type: enumeration(["ENTITY"]), key: text }), object({ type: enumeration(["OPTION"]), optionId: text }), object({ type: enumeration(["HISTORY"]), messageId: text }),
    ] },
    dateBasis: { anyOf: [{ type: "null" }, object({ type: enumeration(["EXPLICIT"]) }), object({ type: enumeration(["DAY_OFFSET"]), offsetDays: { type: "integer" } })] },
  }) },
  pendingExpectation: nullable(object({ resolved: boolean, field: nullable(text) })),
  confirmation: nullable(object({ type: enumeration(["YES", "NO", "UNCLEAR"]), confidence: number })),
  correction: nullable(object({ isCorrection: boolean, replacesEntity: nullable(text) })),
  topicShift: nullable(object({ detected: boolean, from: nullable(topic), to: nullable(topic) })),
  confidence: number, needsClarification: { ...boolean, description: "True only for unresolved meaning or ambiguous supplied values. False for a clear booking request with missing date/time, or a clear correction that leaves another field unanswered. Missing workflow fields are collected by the planner." }, clarificationReason: nullable(text),
});
