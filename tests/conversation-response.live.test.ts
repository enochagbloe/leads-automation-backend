import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { conversationStateService as state } from "../src/services/conversation-state.service";
import { conversationContextService } from "../src/services/conversation-context.service";
import { conversationPlannerService } from "../src/services/conversation-planner.service";
import { conversationResponseService } from "../src/services/conversation-response.service";
import type { AiBusinessContext } from "../src/services/ai-context-builder.service";

// Opt-in paid provider smoke tests: synthetic context, in-memory DB, no external business effects.
const live = process.env.RUN_CONVERSATION_RESPONSE_LIVE_TESTS === "true" ? test : test.skip;
for (const scenario of ["pending-date", "corrected-time", "options", "clarification", "confirmation", "unknown-price"]) live(`live response: ${scenario}`, { timeout: 60000 }, async t => {
  const f = fixture(t); let sequence = 0;
  const command = () => ({ ...scope, expectedRevision: f.state()?.revision ?? 0, source: "WORKFLOW" as const, sourceEffectId: `response-live:${++sequence}` });
  await state.setActiveWorkflow(command(), "APPOINTMENT_BOOKING", "APPOINTMENT");
  await state.setEntity(command(), "preferredTime", { kind: "TIME", value: "2 PM", normalizedValue: "14:00" });
  await state.setAwaiting(command(), { type: "FIELD", field: "preferredDate", question: "What day would you like to come in?" });
  let text = "Can I book at 2 PM?";
  if (scenario === "corrected-time") text = "Actually make it 2 in the afternoon.";
  if (scenario === "options" || scenario === "clarification") {
    await state.setOptions(command(), [{ id: "option_1", label: "12 PM", value: "12:00", position: 1 }, { id: "option_2", label: "2 PM", value: "14:00", position: 2 }]);
    await state.setAwaiting(command(), { type: "OPTION_SELECTION", field: "preferredTime" });
    text = scenario === "options" ? "What are the options again?" : "That one.";
  }
  if (scenario === "confirmation") { await state.setAwaiting(command(), { type: "CONFIRMATION", question: "Would you like to continue?" }); text = "Can you repeat the details?"; }
  if (scenario === "unknown-price") text = "How much is cleaning?";
  await f.add("I can help arrange a visit.", "AI");
  const message = await f.add(text);
  const snapshot = await conversationContextService.getSnapshot({ ...scope, messageId: message.id });
  const context = { business: { id: scope.businessId, name: "Smoke evaluation business" }, conversation: { id: scope.conversationId, status: "AI_HANDLING", aiEnabled: true },
    services: [], triggerMessage: { id: message.id, text, createdAt: message.createdAt.toISOString() }, customerMemory: { summary: null }, planCapabilities: { aiReplies: true, tone: "PROFESSIONAL" },
    safetyInstructions: {}, runtimeKnowledgeGuards: [], recentMessages: snapshot.recentMessages, existingCustomerIssues: [], pendingFollowUpContexts: [], policies: [], knowledgeArticles: [], knowledgeDocumentChunks: [], approvedKnowledgeFacts: [],
  } as unknown as AiBusinessContext;
  const plan = await conversationPlannerService.plan({ businessContext: context, conversationSnapshot: snapshot, interpretation: { intent: scenario === "unknown-price" ? "PRICING_INQUIRY" : "BOOKING_INTENT", confidence: .96, needsClarification: scenario === "clarification", ...(scenario === "clarification" ? { clarificationReason: "OPTION_REFERENCE_AMBIGUOUS" } : {}), resolvedEntities: [] } });
  const result = await conversationResponseService.generate({ ...context, conversationPlan: plan, conversationSnapshot: snapshot }, { ...scope, messageId: message.id, signal: AbortSignal.timeout(45000), temperature: 0, maxTokens: 700 });
  // Synthetic fixture text is intentionally visible for manual wording review; production logs omit bodies.
  t.diagnostic(JSON.stringify({ scenario, model: result.model, text: result.validatedResponse.text, requests: result.providerRequestCount, fallback: result.conversationResponse.fallbackUsed, responseConfidence: result.validatedResponse.confidence, semanticConfidence: result.parsedDecision.confidence }));
  assert.equal(result.conversationResponse.fallbackUsed, false, "smoke success must be generated wording, not a template");
  assert.equal(result.parsedDecision.confidence, .96);
  assert.equal(f.state().revision, snapshot.state.revision);
  assert.ok(result.validatedResponse.text && result.validatedResponse.text.length < 400);
  assert.equal(result.validatedResponse.claimsActionCompleted, false);
});
