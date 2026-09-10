import { z } from "zod";
import { AI_REPLY_INTENTS } from "./ai-decision-parser.service";
import { entityKeySchema, entityScalarSchema, stateDataSchema } from "./conversation-state.schema";

const confidence = z.number().min(0).max(1);
export const workflowNames = ["APPOINTMENT_BOOKING", "APPOINTMENT_RESCHEDULE", "APPOINTMENT_CANCEL", "COMPLAINT_INTAKE", "GENERAL_ENQUIRY", "SERVICE_ENQUIRY", "HUMAN_HANDOFF"] as const;
export const interpretationSchema = z.object({
  intent: z.enum(AI_REPLY_INTENTS),
  topic: stateDataSchema.shape.activeTopic.nullish().transform(v => v ?? undefined),
  workflow: z.object({ name: z.enum(workflowNames).nullish().transform(v => v ?? undefined), action: z.enum(["START", "CONTINUE", "UPDATE", "CONFIRM", "CANCEL", "PAUSE", "RESUME", "NONE"]) }).strict().nullish().transform(v => v ?? undefined),
  resolvedEntities: z.array(z.object({
    key: entityKeySchema,
    value: entityScalarSchema,
    kind: z.enum(["TEXT", "TIME", "DATE", "NUMBER", "BOOLEAN"]),
    normalizedValue: entityScalarSchema.nullish().transform(v => v ?? undefined),
    confidence,
    certainty: z.enum(["EXACT", "APPROXIMATE", "AMBIGUOUS"]),
    source: z.enum(["CURRENT_MESSAGE", "REFERENCE_RESOLUTION", "CONVERSATION_CONTEXT"]),
    evidence: z.array(z.object({ messageId: z.string().min(1).max(128), quote: z.string().min(1).max(300) }).strict()).min(1).max(3),
    reference: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ENTITY"), key: entityKeySchema }).strict(),
      z.object({ type: z.literal("OPTION"), optionId: entityKeySchema }).strict(),
      z.object({ type: z.literal("EXPECTATION") }).strict(),
      z.object({ type: z.literal("HISTORY"), messageId: z.string().min(1).max(128) }).strict(),
    ]).nullish().transform(v => v ?? undefined),
    dateBasis: z.discriminatedUnion("type", [
      z.object({ type: z.literal("EXPLICIT") }).strict(),
      z.object({ type: z.literal("DAY_OFFSET"), offsetDays: z.number().int().min(-3660).max(3660) }).strict(),
    ]).nullish().transform(v => v ?? undefined),
  }).strict()).max(16).refine(v => new Set(v.map(e => e.key)).size === v.length, "Duplicate entity keys"),
  pendingExpectation: z.object({ resolved: z.boolean(), field: entityKeySchema.nullish().transform(v => v ?? undefined) }).strict().nullish().transform(v => v ?? undefined),
  selectedOption: z.object({ optionId: entityKeySchema, position: z.number().int().min(1).max(12).nullish().transform(v => v ?? undefined), value: entityScalarSchema.nullish().transform(v => v ?? undefined), confidence }).strict().nullish().transform(v => v ?? undefined),
  optionResolution: z.object({ basis: z.enum(["POSITION", "EXACT_VALUE", "ORDER", "CONTEXT_FOCUS", "AMBIGUOUS"]), candidateOptionIds: z.array(entityKeySchema).max(12).refine(ids => new Set(ids).size === ids.length), anchorMessageId: z.string().min(1).max(128).nullish().transform(v => v ?? undefined) }).strict().nullish().transform(v => v ?? undefined),
  confirmation: z.object({ type: z.enum(["YES", "NO", "UNCLEAR"]), confidence }).strict().nullish().transform(v => v ?? undefined),
  correction: z.object({ isCorrection: z.boolean(), replacesEntity: entityKeySchema.nullish().transform(v => v ?? undefined) }).strict().nullish().transform(v => v ?? undefined),
  topicShift: z.object({ detected: z.boolean(), from: stateDataSchema.shape.activeTopic.nullish().transform(v => v ?? undefined), to: stateDataSchema.shape.activeTopic.nullish().transform(v => v ?? undefined) }).strict().nullish().transform(v => v ?? undefined),
  confidence,
  needsClarification: z.boolean(),
  clarificationReason: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullish().transform(v => v ?? undefined),
}).strict();
export type ConversationInterpretation = z.infer<typeof interpretationSchema>;
export function parseInterpretation(raw: string) {
  if (Buffer.byteLength(raw) > 24000) throw new Error("INTERPRETATION_TOO_LARGE");
  return interpretationSchema.parse(JSON.parse(raw));
}

/** Calendar arithmetic on the business-local date, not on a UTC interpretation of language. */
export function localClock(instant: string, timezone: string | null | undefined) {
  if (!timezone || !Number.isFinite(Date.parse(instant))) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { timezone, date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}`, weekday: values.weekday };
  } catch { return null; }
}
export function offsetLocalDate(localDate: string, offsetDays: number) {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
