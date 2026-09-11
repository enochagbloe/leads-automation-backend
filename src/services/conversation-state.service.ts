import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { emptyState, entitySchema, patchSchema, StateData, StatePatch, validateState } from "./conversation-state.schema";

export type ConversationScope = { businessId: string; conversationId: string; demoSessionId?: string };
const sourceSchema = z.object({ source: z.enum(["CUSTOMER_MESSAGE", "AI_INTERPRETATION", "WORKFLOW", "STAFF", "SYSTEM", "DEMO"]), sourceMessageId: z.string().min(1).max(128).optional(), sourceEffectId: z.string().min(1).max(200).optional() }).strict().refine(v => Boolean(v.sourceMessageId || v.sourceEffectId), "A durable source identifier is required");
export type StateMutation = ConversationScope & z.input<typeof sourceSchema> & { expectedRevision: number };
const conflict = (code = "CONVERSATION_STATE_CONFLICT") => new AppError(409, "Conversation state changed; reload before applying this command", code);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function data(row: StateData | Record<string, unknown>) {
  return validateState(Object.fromEntries(Object.keys(emptyState()).map(k => {
    const value = (row as Record<string, unknown>)[k];
    return [k, k === "offeredOptionsCreatedAt" ? value instanceof Date ? value.toISOString() : value ?? null : value];
  })));
}
export async function assertConversationScope(tx: Prisma.TransactionClient, scope: ConversationScope) {
  z.object({ businessId: z.string().min(1).max(128), conversationId: z.string().min(1).max(128), demoSessionId: z.string().min(1).max(128).optional() }).parse(scope);
  const conversation = await tx.conversation.findFirst({ where: { id: scope.conversationId, businessId: scope.businessId, deletedAt: null, business: { deletedAt: null } }, select: { id: true, channel: true, status: true, humanTakeover: true, aiEnabled: true, business: { select: { demoSessionId: true, timezone: true } } } });
  if (!conversation) throw new AppError(403, "Conversation resource forbidden", "CONVERSATION_STATE_FORBIDDEN");
  const demoId = conversation.business.demoSessionId;
  if (demoId ? demoId !== scope.demoSessionId || conversation.channel !== "DEMO" : Boolean(scope.demoSessionId) || conversation.channel === "DEMO") throw new AppError(403, "Conversation scope mismatch", "CONVERSATION_STATE_FORBIDDEN");
  if (demoId && !await tx.demoSession.findFirst({ where: { id: demoId, status: "ACTIVE", expiresAt: { gt: new Date() }, business: { id: scope.businessId } }, select: { id: true } })) throw new AppError(403, "Demo session expired", "CONVERSATION_STATE_FORBIDDEN");
  return conversation;
}
async function initialize(tx: Prisma.TransactionClient, scope: ConversationScope) {
  await assertConversationScope(tx, scope);
  const existing = await tx.conversationState.findFirst({ where: { businessId: scope.businessId, conversationId: scope.conversationId } });
  if (existing) return { ...existing, ...data(existing) };
  await tx.conversationState.createMany({ data: [{ businessId: scope.businessId, conversationId: scope.conversationId }], skipDuplicates: true });
  const row = await tx.conversationState.findFirstOrThrow({ where: { businessId: scope.businessId, conversationId: scope.conversationId } });
  return { ...row, ...data(row) };
}
async function mutate(input: StateMutation, operation: string, payload: StatePatch, transform: (state: StateData, patch: StatePatch) => StateData, tx?: Prisma.TransactionClient) {
  const source = sourceSchema.parse({ source: input.source, sourceMessageId: input.sourceMessageId, sourceEffectId: input.sourceEffectId });
  z.number().int().nonnegative().parse(input.expectedRevision);
  const patch = patchSchema.parse(payload);
  const effectKey = source.sourceEffectId ?? `${source.sourceMessageId}:${operation}`;
  const commandHash = createHash("sha256").update(canonical({ operation, patch, source })).digest("hex");
  let transition: { revisionBefore: number; revisionAfter: number; changedFields: string[] } | undefined;
  const run = async (db: Prisma.TransactionClient) => {
    await initialize(db, input);
    // Serialize journal checks and row changes; CAS still rejects older readers.
    await db.$queryRaw`SELECT "id" FROM "ConversationState" WHERE "businessId" = ${input.businessId} AND "conversationId" = ${input.conversationId} FOR UPDATE`;
    const row = await db.conversationState.findFirstOrThrow({ where: { businessId: input.businessId, conversationId: input.conversationId } });
    const oldEffect = await db.conversationStateEffect.findFirst({ where: { businessId: input.businessId, conversationId: input.conversationId, effectKey } });
    if (oldEffect) {
      if (oldEffect.commandHash !== commandHash) throw conflict("CONVERSATION_STATE_IDEMPOTENCY_CONFLICT");
      return { ...row, ...data(row) };
    }
    if (row.revision !== input.expectedRevision) throw conflict();
    const messageIds = new Set([source.sourceMessageId, ...Object.values(patch.knownEntities ?? {}).map(e => e.sourceMessageId)].filter((v): v is string => Boolean(v)));
    for (const id of messageIds) if (!await db.message.findFirst({ where: { id, businessId: input.businessId, conversationId: input.conversationId, deletedAt: null }, select: { id: true } })) throw new AppError(403, "State source message forbidden", "CONVERSATION_STATE_FORBIDDEN");
    const proposed = transform(data(row), patch);
    const next = validateState({ ...proposed, ...(patch.offeredOptions !== undefined ? { offeredOptionsCreatedAt: patch.offeredOptions.length ? new Date().toISOString() : null } : {}) });
    const now = new Date();
    const changedFields = Object.keys(next).filter(k => canonical(next[k as keyof StateData]) !== canonical(data(row)[k as keyof StateData]));
    const updated = await db.conversationState.updateMany({ where: { id: row.id, businessId: input.businessId, conversationId: input.conversationId, revision: input.expectedRevision }, data: { ...next, awaiting: next.awaiting ?? Prisma.DbNull, knownEntities: next.knownEntities as Prisma.InputJsonObject, offeredOptions: next.offeredOptions as Prisma.InputJsonArray, revision: { increment: 1 }, lastActivityAt: now } });
    if (!updated.count) throw conflict();
    await db.conversationStateEffect.create({ data: { businessId: input.businessId, conversationId: input.conversationId, effectKey, commandHash, source: source.source, sourceMessageId: source.sourceMessageId, revisionBefore: row.revision, revisionAfter: row.revision + 1, changedFields } });
    transition = { revisionBefore: row.revision, revisionAfter: row.revision + 1, changedFields };
    return { ...row, ...next, revision: row.revision + 1, updatedAt: now, lastActivityAt: now };
  };
  const result = tx ? await run(tx) : await prisma.$transaction(run);
  // For caller-owned transactions the durable journal is the commit-aware audit.
  if (!tx && transition) console.info("conversation_state.updated", { businessId: input.businessId, conversationId: input.conversationId, ...transition, source: source.source, sourceMessageId: source.sourceMessageId });
  return result;
}
const merge = (state: StateData, patch: StatePatch) => validateState({ ...state, ...patch });
export const conversationStateService = {
  /** Canonical storage calls this inside the same transaction as the message.
   * Activity merges under a lock; semantic changes must carry the reader's revision.
   */
  async recordMessage(scope: ConversationScope, messageId: string, source: "CUSTOMER_MESSAGE" | "AI_INTERPRETATION" | "STAFF", tx: Prisma.TransactionClient, change?: { expectedRevision: number; patch: StatePatch }) {
    await initialize(tx, scope);
    await tx.$queryRaw`SELECT "id" FROM "ConversationState" WHERE "businessId" = ${scope.businessId} AND "conversationId" = ${scope.conversationId} FOR UPDATE`;
    const current = await tx.conversationState.findFirstOrThrow({ where: { businessId: scope.businessId, conversationId: scope.conversationId } });
    return mutate({ ...scope, expectedRevision: change?.expectedRevision ?? current.revision, source, sourceMessageId: messageId, sourceEffectId: `message:${messageId}` }, "MESSAGE", change?.patch ?? {}, merge, tx);
  },
  get(scope: ConversationScope, tx?: Prisma.TransactionClient) { return tx ? initialize(tx, scope) : prisma.$transaction(db => initialize(db, scope)); },
  initialize(scope: ConversationScope, tx?: Prisma.TransactionClient) { return this.get(scope, tx); },
  patch(input: StateMutation, patch: StatePatch, tx?: Prisma.TransactionClient) { return mutate(input, "PATCH", patch, merge, tx); },
  setEntity(input: StateMutation, key: string, entity: z.input<typeof entitySchema>, tx?: Prisma.TransactionClient) {
    return mutate(input, `ENTITY:${key}`, { knownEntities: { [key]: entity } }, (s, p) => merge(s, { knownEntities: { ...s.knownEntities, ...Object.fromEntries(Object.entries(p.knownEntities ?? {}).map(([k, e]) => [k, { ...e, sourceMessageId: input.sourceMessageId ?? e.sourceMessageId, updatedAt: new Date().toISOString() }])) } }), tx);
  },
  setAwaiting(input: StateMutation, awaiting: NonNullable<StatePatch["awaiting"]>, tx?: Prisma.TransactionClient) { return mutate(input, "AWAITING", { awaiting }, (s, p) => merge(s, { ...p, awaiting: { ...awaiting, createdAt: new Date().toISOString() }, lastAssistantQuestion: awaiting.question ?? null, workflowStatus: awaiting.type === "SYSTEM_RESULT" ? "WAITING_FOR_SYSTEM" : "WAITING_FOR_CUSTOMER" }), tx); },
  clearAwaiting(input: StateMutation, tx?: Prisma.TransactionClient) { return mutate(input, "CLEAR_AWAITING", { awaiting: null, lastAssistantQuestion: null }, (s, p) => merge(s, { ...p, workflowStatus: s.activeWorkflow ? "ACTIVE" : "IDLE" }), tx); },
  setActiveWorkflow(input: StateMutation, workflow: string, topic: StateData["activeTopic"], tx?: Prisma.TransactionClient) { return mutate(input, "WORKFLOW", { activeWorkflow: workflow, activeTopic: topic, workflowStatus: "ACTIVE", awaiting: null, offeredOptions: [], lastAssistantQuestion: null }, (s, p) => merge(s, { ...p, previousTopic: s.activeTopic }), tx); },
  setOptions(input: StateMutation, options: StateData["offeredOptions"], tx?: Prisma.TransactionClient) { return mutate(input, "OPTIONS", { offeredOptions: options }, merge, tx); },
  clearOptions(input: StateMutation, tx?: Prisma.TransactionClient) { return mutate(input, "CLEAR_OPTIONS", { offeredOptions: [] }, merge, tx); },
  completeWorkflow(input: StateMutation, tx?: Prisma.TransactionClient) { return mutate(input, "COMPLETE", { activeWorkflow: null, awaiting: null, offeredOptions: [], lastAssistantQuestion: null, workflowStatus: "COMPLETED" }, merge, tx); },
  pauseWorkflow(input: StateMutation, tx?: Prisma.TransactionClient) { return mutate(input, "PAUSE", { workflowStatus: "PAUSED" }, merge, tx); },
  resetWorkflow(input: StateMutation, tx?: Prisma.TransactionClient) { return mutate(input, "RESET", patchSchema.parse(Object.fromEntries(Object.entries(emptyState()).filter(([key]) => key !== "offeredOptionsCreatedAt"))), (s, p) => merge(s, { ...p, previousTopic: s.activeTopic }), tx); },
};
