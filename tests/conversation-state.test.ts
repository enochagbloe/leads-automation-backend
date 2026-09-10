import { conversationInterpreterService } from "../src/services/conversation-interpreter.service";
import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { conversationStateService as service } from "../src/services/conversation-state.service";
import { conversationContextService } from "../src/services/conversation-context.service";
import { emptyState, entitySchema, optionsSchema } from "../src/services/conversation-state.schema";
import { storeInboundCustomerMessage } from "../src/services/inbound-message-store.service";
import { storeAiReply } from "../src/services/ai-message-store.service";
import { mockMethod } from "./helpers/mock-method";
import { generateContextReply } from "../src/services/ai-reply-runtime.service";
import { aiProvider } from "../src/services/ai-provider.service";
import type { AiBusinessContext } from "../src/services/ai-context-builder.service";

import { fixture, scope } from "./helpers/conversation-state-fixture";
const command = (revision: number, effect: string) => ({ ...scope, expectedRevision: revision, source: "WORKFLOW" as const, sourceEffectId: effect });

test("lazy initialization, reload, workflow, structured entities and pending field persist", async t => {
  fixture(t);
  assert.equal((await service.get(scope)).revision, 0);
  await service.setActiveWorkflow(command(0, "start"), "APPOINTMENT_BOOKING", "APPOINTMENT");
  await service.setEntity(command(1, "time"), "preferredTime", { value: "12 PM", kind: "TIME", normalizedValue: "12:00", confidence: 0.98 });
  await service.setAwaiting(command(2, "date"), { type: "FIELD", field: "preferredDate", question: "What day would you like to come in?" });
  const row = await service.get(scope);
  assert.equal(row.knownEntities.preferredTime?.normalizedValue, "12:00");
  assert.equal(row.activeWorkflow, "APPOINTMENT_BOOKING");
  assert.equal(row.awaiting?.field, "preferredDate");
  assert.equal(row.workflowStatus, "WAITING_FOR_CUSTOMER");
  assert.equal(row.revision, 3);
});

test("options and human messages survive handoff; completion and reset clear transient state without history deletion", async t => {
  const f = fixture(t);
  await service.setActiveWorkflow(command(0, "start"), "APPOINTMENT_BOOKING", "APPOINTMENT");
  await service.setEntity(command(1, "reason"), "reason", { value: "tooth pain" });
  const choices = [{ id: "one", label: "12 PM", value: "12:00", position: 1 }, { id: "two", label: "2 PM", value: "14:00", position: 2 }];
  await service.setOptions(command(2, "options"), choices);
  await service.setAwaiting(command(3, "select"), { type: "OPTION_SELECTION" });
  f.human(); await f.add("We have 12 PM and 2 PM available.", "STAFF");
  const customer = await f.add("The second one.");
  const snapshot = await conversationContextService.getSnapshot({ ...scope, messageId: customer.id });
  assert.equal(snapshot.currentMessage?.text, "The second one.");
  assert.equal(snapshot.state.awaiting?.type, "OPTION_SELECTION");
  assert.deepEqual(snapshot.state.offeredOptions, choices);
  assert.equal(snapshot.recentMessages[0]?.senderType, "STAFF");
  await service.pauseWorkflow(command(4, "pause"));
  assert.deepEqual((await service.get(scope)).offeredOptions, choices);
  await service.completeWorkflow(command(5, "complete"));
  let row = await service.get(scope);
  assert.equal(row.awaiting, null); assert.deepEqual(row.offeredOptions, []); assert.equal(row.activeWorkflow, null);
  assert.equal(row.knownEntities.reason?.value, "tooth pain");
  await service.resetWorkflow(command(6, "reset")); row = await service.get(scope);
  assert.deepEqual(row.knownEntities, {}); assert.equal(row.workflowStatus, "IDLE"); assert.equal(f.messages().length, 2);
});

test("same effect replays once; changed payload conflicts; stale and concurrent writers cannot overwrite", async t => {
  const f = fixture(t);
  const input = command(0, "time");
  await service.setEntity(input, "preferredTime", { value: "12:00" });
  await service.setEntity(input, "preferredTime", { value: "12:00" });
  assert.equal(f.effects().length, 1); assert.equal(f.state().revision, 1);
  await assert.rejects(service.setEntity(input, "preferredTime", { value: "14:00" }), { code: "CONVERSATION_STATE_IDEMPOTENCY_CONFLICT" });
  await assert.rejects(service.pauseWorkflow(command(0, "old")), { code: "CONVERSATION_STATE_CONFLICT" });
  const result = await Promise.allSettled([service.setEntity(command(1, "a"), "a", { value: "A" }), service.setEntity(command(1, "b"), "b", { value: "B" })]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.state().revision, 2);
});

test("business and demo scopes deny reads, mutations, expired sessions and forged source messages", async t => {
  const f = fixture(t);
  await assert.rejects(service.get({ ...scope, businessId: "business-b" }), { code: "CONVERSATION_STATE_FORBIDDEN" });
  await assert.rejects(service.pauseWorkflow({ ...command(0, "bad"), conversationId: "conversation-b" }), { code: "CONVERSATION_STATE_FORBIDDEN" });
  await assert.rejects(service.patch({ ...command(0, "source"), sourceMessageId: "other-tenant-message" }, {}), { code: "CONVERSATION_STATE_FORBIDDEN" });
  await assert.rejects(service.get({ ...scope, demoSessionId: "demo-a" }));
  f.demo();
  await assert.rejects(service.get(scope));
  await assert.rejects(service.get({ ...scope, demoSessionId: "demo-b" }));
  const demoScope = { ...scope, demoSessionId: "demo-a" };
  const snapshot = await conversationContextService.getSnapshot({ ...demoScope, customerMemorySummary: "production memory must not appear" });
  assert.equal(snapshot.customerMemorySummary, null);
  f.expire(); await assert.rejects(service.get(demoScope));
});

test("tooth pain fixture supplies state and bounded history before the next interpretation", async t => {
  const f = fixture(t);
  const first = await f.add("My tooth aches so bad and it is very shaky.");
  await f.add("We can help arrange an appointment.", "AI");
  await service.setActiveWorkflow(command(0, "booking"), "APPOINTMENT_BOOKING", "APPOINTMENT");
  await service.setEntity({ ...command(1, "reason"), sourceMessageId: first.id }, "reason", { value: "painful/shaky tooth" });
  const second = await f.add("I want to book an appointment at 12 in the afternoon.");
  // Explicit normalized workflow command: extraction is a Sprint 2 responsibility.
  await service.setEntity({ ...command(2, "time"), sourceMessageId: second.id }, "preferredTime", { value: "12 in the afternoon", kind: "TIME", normalizedValue: "12:00" });
  await service.setAwaiting(command(3, "date"), { type: "FIELD", field: "preferredDate" });
  await f.add("future message must not enter older trigger snapshot");
  const snapshot = await conversationContextService.getSnapshot({ ...scope, messageId: second.id, maxMessages: 2, customerMemorySummary: "Preferred branch Tema" });
  assert.equal(snapshot.recentMessages.length, 2);
  assert.equal(snapshot.recentMessages[1]?.id, second.id);
  assert.equal(snapshot.state.knownEntities.reason?.value, "painful/shaky tooth");
  assert.equal(snapshot.state.knownEntities.preferredTime?.normalizedValue, "12:00");
  assert.equal(snapshot.state.awaiting?.field, "preferredDate");
  assert.equal(snapshot.customerMemorySummary, "Preferred branch Tema");
});

test("message and state changes commit atomically; failed audit rolls back both; activity invalidates stale AI readers", async t => {
  const f = fixture(t);
  await prisma.$transaction(tx => storeInboundCustomerMessage(tx, { ...scope, leadId: "lead", content: "hello" }));
  assert.equal(f.state().revision, 1); assert.equal(f.effects()[0].sourceMessageId, f.messages()[0].id);
  await prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead", content: "What day?", senderType: "AI", direction: "OUTBOUND", messageType: "TEXT", deliveryStatus: "INTERNAL" }, "OPEN", {}, { stateChange: { expectedRevision: 1, patch: { awaiting: { type: "FIELD", field: "preferredDate" }, lastAssistantQuestion: "What day?", workflowStatus: "WAITING_FOR_CUSTOMER" } } }));
  assert.equal(f.state().lastAssistantQuestion, "What day?"); assert.equal(f.state().revision, 2);
  await assert.rejects(service.patch(command(1, "old-ai"), { lastAssistantQuestion: "stale" }), { code: "CONVERSATION_STATE_CONFLICT" });
  f.fail();
  await assert.rejects(prisma.$transaction(tx => storeInboundCustomerMessage(tx, { ...scope, leadId: "lead", content: "must roll back" })));
  assert.equal(f.messages().length, 2); assert.equal(f.state().revision, 2);
});

test("validation rejects malformed normalization, oversized entities, duplicate options and arbitrary state keys", async t => {
  fixture(t);
  assert.equal(entitySchema.safeParse({ value: "noon", kind: "TIME", normalizedValue: "25:00" }).success, false);
  assert.equal(entitySchema.safeParse({ value: "February", kind: "DATE", normalizedValue: "2026-02-31" }).success, false);
  assert.equal(optionsSchema.safeParse([{ id: "one", label: "A", value: "a", position: 1 }, { id: "one", label: "B", value: "b", position: 2 }]).success, false);
  await assert.rejects(service.patch(command(0, "blob"), { arbitrary: "blob" } as any));
  await assert.rejects(service.setEntity(command(0, "large"), "reason", { value: "x".repeat(1001) }));
});

test("production runtime loads fresh persisted state after cached business context and returns its revision", async t => {
  const f = fixture(t);
  const message = await f.add("East Legon this time.");
  const cached = {
    business: { id: scope.businessId, name: "Clinic" }, conversation: { id: scope.conversationId },
    services: [], runtimeKnowledgeGuards: [], availability: null, policies: [], knowledgeArticles: [], knowledgeDocumentChunks: [], approvedKnowledgeFacts: [],
    recentMessages: [], existingCustomerIssues: [], pendingFollowUpContexts: [], customerMemory: { summary: "Preferred branch Tema" }, readiness: {}, lead: null,
    triggerMessage: { id: message.id, text: message.content, createdAt: message.createdAt.toISOString() }, planCapabilities: { tone: "PROFESSIONAL" }, safetyInstructions: {},
  } as unknown as AiBusinessContext;
  await service.setAwaiting(command(0, "branch"), { type: "FIELD", field: "branch", question: "Which branch?" });
  let received = "";
  mockMethod(t, aiProvider, "generateReply", async (input: any) => { received = `${input.systemPrompt}\n${input.userPrompt}`; return { model: "test" }; });
  mockMethod(t, conversationInterpreterService, "interpret", async () => ({ interpretation: { intent: "GENERAL_QUESTION", resolvedEntities: [], confidence: 1, needsClarification: false }, commands: [], appliedRevision: 1, replayed: false }));
  const result = await generateContextReply(cached, { businessId: scope.businessId, conversationId: scope.conversationId, messageId: message.id });
  assert.equal(result.conversationStateRevision, 1);
  assert.equal(result.conversationSourceMessageId, message.id);
  assert.match(received, /Which branch/); assert.match(received, /East Legon/); assert.match(received, /Preferred branch Tema/);
  assert.match(received, /Explicit current preferences override remembered preferences/);
  assert.equal(cached.conversationSnapshot, undefined);
});
