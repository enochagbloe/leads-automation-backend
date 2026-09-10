import { z } from "zod";

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine(v => !["constructor", "prototype", "__proto__"].includes(v));
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);
export const entitySchema = z.object({
  value: scalar,
  kind: z.enum(["TEXT", "TIME", "DATE", "NUMBER", "BOOLEAN"]).default("TEXT"),
  normalizedValue: scalar.optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceMessageId: z.string().max(128).optional(),
  updatedAt: z.string().datetime().optional(),
}).strict().superRefine((e, ctx) => {
  if (e.kind === "TIME" && (typeof e.normalizedValue !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.normalizedValue))) ctx.addIssue({ code: "custom", message: "TIME requires normalized HH:mm" });
  if (e.kind === "DATE" && (typeof e.normalizedValue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.normalizedValue) || !Number.isFinite(Date.parse(e.normalizedValue)) || new Date(e.normalizedValue).toISOString().slice(0, 10) !== e.normalizedValue)) ctx.addIssue({ code: "custom", message: "DATE requires a valid normalized YYYY-MM-DD" });
  if (e.kind === "NUMBER" && typeof e.normalizedValue !== "number") ctx.addIssue({ code: "custom", message: "NUMBER requires a normalized number" });
  if (e.kind === "BOOLEAN" && typeof e.normalizedValue !== "boolean") ctx.addIssue({ code: "custom", message: "BOOLEAN requires a normalized boolean" });
});
export const awaitingSchema = z.object({ type: z.enum(["FIELD", "CONFIRMATION", "OPTION_SELECTION", "FREE_TEXT", "SYSTEM_RESULT"]), field: key.optional(), question: z.string().max(1000).optional(), createdAt: z.string().datetime().optional() }).strict().refine(v => v.type !== "FIELD" || Boolean(v.field), "FIELD requires field");
export const optionsSchema = z.array(z.object({ id: key, label: z.string().min(1).max(200), value: scalar, position: z.number().int().min(1).max(12) }).strict()).max(12).refine(v => new Set(v.map(x => x.id)).size === v.length && new Set(v.map(x => x.position)).size === v.length, "Options require unique IDs and positions");
export const stateDataSchema = z.object({
  activeTopic: z.enum(["GENERAL_ENQUIRY", "SERVICE_ENQUIRY", "APPOINTMENT", "FOLLOW_UP", "COMPLAINT", "QUOTATION", "PAYMENT", "HUMAN_HANDOFF"]).nullable(),
  previousTopic: z.string().max(64).nullable(), activeWorkflow: key.nullable(),
  workflowStatus: z.enum(["IDLE", "ACTIVE", "WAITING_FOR_CUSTOMER", "WAITING_FOR_SYSTEM", "COMPLETED", "CANCELLED", "PAUSED"]),
  awaiting: awaitingSchema.nullable(),
  knownEntities: z.record(key, entitySchema).refine(v => Object.keys(v).length <= 32),
  offeredOptions: optionsSchema,
  lastAssistantQuestion: z.string().max(1000).nullable(), lastResolvedIntent: key.nullable(),
}).strict();
export const patchSchema = stateDataSchema.partial().strict();
export type StateData = z.infer<typeof stateDataSchema>;
export type StatePatch = z.input<typeof patchSchema>;
export const emptyState = (): StateData => ({ activeTopic: null, previousTopic: null, activeWorkflow: null, workflowStatus: "IDLE", awaiting: null, knownEntities: {}, offeredOptions: [], lastAssistantQuestion: null, lastResolvedIntent: null });
export function validateState(value: unknown) {
  const parsed = stateDataSchema.parse(value);
  if (["COMPLETED", "CANCELLED"].includes(parsed.workflowStatus) && (parsed.awaiting || parsed.activeWorkflow || parsed.offeredOptions.length || parsed.lastAssistantQuestion)) throw new Error("Finished workflows cannot retain transient expectations or options");
  if (Buffer.byteLength(JSON.stringify(parsed)) > 24000) throw new Error("Conversation state exceeds 24KB");
  return parsed;
}
