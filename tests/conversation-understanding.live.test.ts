import { aiSafetyService } from "../src/services/ai-safety.service";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { conversationStateService as state } from "../src/services/conversation-state.service";
import { generateContextReply } from "../src/services/ai-reply-runtime.service";
import { storeAiReply } from "../src/services/ai-message-store.service";
import { prisma } from "../src/config/prisma";
import type { AiBusinessContext } from "../src/services/ai-context-builder.service";
import { emptyDemoFacts } from "../src/services/demo-extraction.service";
import { offsetLocalDate, localClock } from "../src/services/conversation-interpretation.schema";

// Opt-in real model, synthetic data and in-memory database only. No business effects.
const live = process.env.RUN_CONVERSATION_UNDERSTANDING_LIVE_TESTS === "true" ? test : test.skip;
const tooth = "right its a typo my teeth hurts and i want to check on it\ni dont know what is actually wrong but when can i come in";
for (const industry of ["dental", "consultancy"]) live(`live noisy multi-turn demo: ${industry}`, { timeout: 240000 }, async t => {
  const f = fixture(t); f.demo();
  const scoped = { ...scope, demoSessionId: "demo-a" }; let serial = 0;
  t.after(() => { for (const log of f.logs.filter(l => /failed|ambiguous/.test(l[0]))) t.diagnostic(JSON.stringify(log)); });
  const command = () => ({ ...scoped, expectedRevision: f.state()?.revision ?? 0, source: "WORKFLOW" as const, sourceEffectId: `noisy-live:${++serial}` });
  async function send(text: string) {
    const message = await f.add(text);
    const facts = emptyDemoFacts(); facts.description = industry === "dental" ? "Dental practice offering consultations." : "Management consultancy offering consultations.";
    const context = { demoSessionId: "demo-a", demoFacts: { facts, unknowns: ["live availability"] }, business: { id: scope.businessId, name: industry === "dental" ? "Synthetic Dental Practice" : "Synthetic Consultancy" }, conversation: { id: scope.conversationId, status: "OPEN", aiEnabled: true, humanTakeover: false },
      services: [], triggerMessage: { id: message.id, text, createdAt: message.createdAt.toISOString() }, customerMemory: { summary: null }, planCapabilities: { aiReplies: true, tone: "PROFESSIONAL" },
      safetyInstructions: {}, runtimeKnowledgeGuards: [], recentMessages: [], existingCustomerIssues: [], pendingFollowUpContexts: [], policies: [], knowledgeArticles: [], knowledgeDocumentChunks: [], approvedKnowledgeFacts: [],
    } as unknown as AiBusinessContext;
    const r = await generateContextReply(context, { ...scope, messageId: message.id, signal: AbortSignal.timeout(90000), temperature: 0 });
    t.diagnostic(JSON.stringify({ industry, text, intent: r.interpretation.intent, ambiguity: r.interpretation.clarificationReason, move: r.conversationPlan.move, field: r.conversationPlan.targetField, entities: r.interpretation.resolvedEntities.map(e => ({ key: e.key, value: e.normalizedValue, certainty: e.certainty })), reply: r.validatedResponse.text, requests: r.providerRequestCount, fallback: r.conversationResponse.fallbackUsed }));
    const safety = aiSafetyService.evaluate({ decision: r.parsedDecision, businessReady: true, humanTakeover: false, replyOnlyDemo: true, validatedConversationClarification: r.conversationPlan.move === "ASK_FOR_CLARIFICATION" });
    assert.equal(safety.allowed, true, safety.blockedReason);
    assert.ok(r.providerRequestCount <= 3, "only interpreter, response, optional existing corrective retry");
    assert.equal(r.validatedResponse.claimsActionCompleted, false); assert.deepEqual(r.validatedResponse.claims, []);
    assert.doesNotMatch(r.validatedResponse.text!, /which option|which choice|first one|second option/i);
    assert.notEqual(r.conversationPlan.workflowRequest?.type, "CREATE_BOOKING_REQUEST");
    await prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", content: r.validatedResponse.text!, messageType: "TEXT", deliveryStatus: "INTERNAL" }, "OPEN", {}, { demoSessionId: "demo-a", plan: r.conversationPlan, response: { text: r.validatedResponse.text, metadata: r.conversationResponse } }));
    return { r, message };
  }
  for (const text of ["hello", "hrllo"]) {
    const { r } = await send(text);
    assert.equal(r.interpretation.intent, "GENERAL_QUESTION"); assert.equal(r.interpretation.needsClarification, false);
    assert.equal(r.conversationPlan.reasonCode, "CUSTOMER_GREETING"); assert.doesNotMatch(r.validatedResponse.text!, /hrllo|clarif|typo/i);
  }
  const { r } = await send(industry === "dental" ? tooth : "right its a typo our projects keep slipping i dont know whats wrong but when can i come in for advice");
  assert.equal(r.interpretation.intent, "BOOKING_INTENT"); assert.equal(r.interpretation.needsClarification, false);
  assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING"); assert.equal(f.state().activeTopic, "APPOINTMENT"); assert.ok(f.state().knownEntities.reason);
  assert.equal(r.conversationPlan.move, "ASK_FOR_FIELD"); assert.equal(r.conversationPlan.targetField, "preferredDate");
  // Explicit afternoon context makes bare 2 resolvable without assuming AM/PM from a typo.
  await f.add("We are discussing afternoon times. What day and time would you prefer?", "AI");
  const booked = await send("i wnt to book tomorow at 2");
  assert.equal(booked.r.interpretation.intent, "BOOKING_INTENT"); assert.equal(booked.r.interpretation.needsClarification, false);
  assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "14:00");
  assert.equal(f.state().knownEntities.preferredDate.normalizedValue, offsetLocalDate(localClock(booked.message.createdAt.toISOString(), "Africa/Accra")!.date, 1));
  await state.setAwaiting(command(), { type: "FIELD", field: "preferredTime", question: "Would you prefer noon or an afternoon time?" });
  await f.add("Would you prefer noon or an afternoon time?", "AI");
  const noon = await send("can i com at 12");
  assert.equal(noon.r.interpretation.intent, "BOOKING_INTENT");
  if (noon.r.interpretation.needsClarification) assert.equal(noon.r.conversationPlan.targetField, "preferredTime");
  else assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "12:00");
});
