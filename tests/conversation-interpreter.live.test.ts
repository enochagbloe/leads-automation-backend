import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { conversationStateService as state } from "../src/services/conversation-state.service";
import { conversationContextService } from "../src/services/conversation-context.service";
import { conversationInterpreterService } from "../src/services/conversation-interpreter.service";
import type { AiBusinessContext } from "../src/services/ai-context-builder.service";
import { aiProvider } from "../src/services/ai-provider.service";
import { mockMethod } from "./helpers/mock-method";

// Explicitly opt in: uses the configured paid AI provider, but all database work stays in memory.
const live = process.env.RUN_CONVERSATION_INTERPRETER_LIVE_TESTS === "true" ? test : test.skip;
for (const scenario of ["relative-date", "ordinal", "confirmation", "correction", "ambiguous"]) live(`live model: ${scenario}`, { timeout: 60000 }, async t => {
  const f = fixture(t);
  let raw = "";
  const completion = aiProvider.generateCompletion.bind(aiProvider);
  mockMethod(t, aiProvider, "generateCompletion", async input => { const result = await completion(input); raw = result.rawText; return result; });
  let sequence = 0;
  const command = () => ({ ...scope, expectedRevision: f.state()?.revision ?? 0, source: "WORKFLOW" as const, sourceEffectId: `live:${++sequence}` });
  await state.setActiveWorkflow(command(), "APPOINTMENT_BOOKING", "APPOINTMENT");
  let text = "Tomorrow";
  if (scenario === "relative-date") {
    f.setTimezone("America/Los_Angeles");
    await state.setAwaiting(command(), { type: "FIELD", field: "preferredDate", question: "What day would you like to come in?" });
  } else if (scenario === "confirmation") {
    await state.setAwaiting(command(), { type: "CONFIRMATION", question: "Would you like me to continue with 2 PM?" }); text = "Yeah, that works.";
  } else if (scenario === "correction") {
    await state.setEntity(command(), "preferredTime", { value: "12 PM", kind: "TIME", normalizedValue: "12:00" });
    await state.setAwaiting(command(), { type: "FIELD", field: "preferredDate", question: "You chose noon from our afternoon times. What day would you like?" }); text = "Actually make it 2 in the afternoon.";
  } else {
    await state.setOptions(command(), [{ id: "option_1", label: "12 PM", value: "12:00", position: 1 }, { id: "option_2", label: "2 PM", value: "14:00", position: 2 }, { id: "option_3", label: "4 PM", value: "16:00", position: 3 }]);
    await state.setAwaiting(command(), { type: "OPTION_SELECTION", field: "preferredTime", question: "Which of these three times?" }); text = scenario === "ordinal" ? "The second one." : "That one.";
  }
  const message = await f.add(text);
  message.createdAt = new Date("2026-09-11T01:30:00Z");
  const snapshot = await conversationContextService.getSnapshot({ ...scope, messageId: message.id });
  const context = { business: { id: scope.businessId, name: "Evaluation business" }, conversation: { id: scope.conversationId }, services: [], triggerMessage: { id: message.id, text, createdAt: message.createdAt.toISOString() } } as unknown as AiBusinessContext;
  const result = await conversationInterpreterService.interpret({ businessContext: context, conversationSnapshot: snapshot, signal: AbortSignal.timeout(45000) }).catch(error => { t.diagnostic(raw); throw error; });
  if (scenario === "ambiguous") {
    if (!result.interpretation.needsClarification) t.diagnostic(raw);
    assert.equal(result.interpretation.needsClarification, true); assert.equal(f.state().revision, snapshot.state.revision);
  } else {
    if (result.interpretation.needsClarification) t.diagnostic(raw);
    assert.equal(result.interpretation.needsClarification, false, result.interpretation.clarificationReason);
    if (scenario === "relative-date") assert.equal(f.state().knownEntities.preferredDate?.normalizedValue, "2026-09-11");
    if (scenario === "ordinal" || scenario === "correction") assert.equal(f.state().knownEntities.preferredTime?.normalizedValue, "14:00");
    if (scenario === "confirmation") { assert.equal(result.interpretation.confirmation?.type, "YES"); assert.equal(f.state().awaiting, null); }
  }
});
