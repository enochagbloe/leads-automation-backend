
import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { mockMethod } from "./helpers/mock-method";
import { prisma } from "../src/config/prisma";
import { conversationStateService as state } from "../src/services/conversation-state.service";
import { conversationContextService } from "../src/services/conversation-context.service";
import { conversationPlannerService as planner, assistantPlanPatch } from "../src/services/conversation-planner.service";
import { conversationWorkflowPlanningService as workflows, appointmentPlanningBackend } from "../src/services/conversation-workflow-planning.service";
import { conversationPlanSchema, ConversationPlan } from "../src/services/conversation-plan.schema";
import { ConversationInterpretation } from "../src/services/conversation-interpretation.schema";
import { conversationInterpretationCommandService } from "../src/services/conversation-interpretation-command.service";
import { AiBusinessContext, aiPromptContextFormatter } from "../src/services/ai-context-builder.service";
import { storeAiReply } from "../src/services/ai-message-store.service";
import { aiProvider } from "../src/services/ai-provider.service";
import { conversationInterpreterService } from "../src/services/conversation-interpreter.service";
import { generateContextReply } from "../src/services/ai-reply-runtime.service";
import { missingAiBookingFields } from "../src/services/appointment/appointment-conversation-requirements";

const meaning = (overrides: Partial<ConversationInterpretation> = {}): ConversationInterpretation => ({ intent: "BOOKING_INTENT", confidence: .99, needsClarification: false, resolvedEntities: [], ...overrides });
function setup(t: TestContext, demo = false) {
  const f = fixture(t); mockMethod(t, appointmentPlanningBackend, "checkSlot", async () => ({ available: true, reason: null }) as any); if (demo) f.demo();
  const scoped = { ...scope, ...(demo ? { demoSessionId: "demo-a" } : {}) }; let sequence = 0;
  const command = () => ({ ...scoped, expectedRevision: f.state()?.revision ?? 0, source: "WORKFLOW" as const, sourceEffectId: `planner-fixture:${++sequence}` });
  const context = (m: any): AiBusinessContext => ({ business: { id: scope.businessId, name: "Fixture business" }, conversation: { id: scope.conversationId, status: "AI_HANDLING", aiEnabled: true }, ...scoped, services: [{ id: "service-a", name: "Dental examination", isBookable: true, durationMinutes: 30 }], triggerMessage: { id: m.id, text: m.content, createdAt: m.createdAt.toISOString() }, customerMemory: { summary: null }, planCapabilities: { aiReplies: true, tone: "PROFESSIONAL" }, safetyInstructions: { canDetectBookingIntent: true }, runtimeKnowledgeGuards: [], recentMessages: [], existingCustomerIssues: [], pendingFollowUpContexts: [], policies: [], knowledgeArticles: [], knowledgeDocumentChunks: [], approvedKnowledgeFacts: [] } as unknown as AiBusinessContext);
  const input = async (m: any, interpreted = meaning()) => ({ businessContext: context(m), interpretation: interpreted, conversationSnapshot: await conversationContextService.getSnapshot({ ...scoped, messageId: m.id }) });
  const save = (plan: ConversationPlan, content: string) => prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", content, messageType: "TEXT", deliveryStatus: "INTERNAL" }, "AI_HANDLING", {}, { demoSessionId: scoped.demoSessionId, plan }));
  const booking = async (complete = false) => {
    await state.setActiveWorkflow(command(), "APPOINTMENT_BOOKING", "APPOINTMENT");
    await state.setEntity(command(), "reason", { value: "painful/shaky tooth" });
    await state.setEntity(command(), "preferredTime", { value: "12 PM", kind: "TIME", normalizedValue: "12:00" });
    if (complete) { await state.setEntity(command(), "preferredDate", { value: "tomorrow", kind: "DATE", normalizedValue: "2026-09-12" }); await state.setEntity(command(), "serviceId", { value: "service-a" }); }
  };
  return { ...f, command, context, input, save, booking, scoped, plan: async (m: any, i = meaning()) => planner.plan(await input(m, i)) };
}

import { conversationResponseService as responses, responseFacts } from "../src/services/conversation-response.service";
import { conversationResponsePolicyService as policy } from "../src/services/conversation-response-policy.service";
import { ConversationResponse } from "../src/services/conversation-response.schema";
import { responseOutput } from "./helpers/response-output";
import { aiSafetyService } from "../src/services/ai-safety.service";

async function prepared(t: TestContext, demo = false) {
  const f = setup(t, demo); await f.booking(); const m = await f.add("Actually make it 2.");
  await state.setEntity(f.command(), "preferredTime", { kind: "TIME", value: "2 PM", normalizedValue: "14:00" });
  const input = await f.input(m); const plan = await planner.plan(input);
  const context = { ...input.businessContext, conversationSnapshot: input.conversationSnapshot, conversationPlan: plan };
  const output = (overrides: Partial<ConversationResponse> = {}): ConversationResponse => ({ complaints: [], text: "Sure. What day would you like to come in around 2 PM?", acknowledgedContext: false, fulfilledPurpose: plan.responseDirective.purpose, askedField: plan.targetField ?? null, questionCount: 1, referencedOptionIds: [], referencedFactIds: [], claimsActionCompleted: false, claims: [], confidence: 1, requiresHumanReview: false, ...overrides });
  const check = (r: unknown, extras: any = {}) => policy.validate({ plan, state: input.conversationSnapshot.state, recentMessages: [], facts: [], generatedResponse: r, ...extras });
  const run = () => responses.generate(context, { businessId: scope.businessId, conversationId: scope.conversationId, messageId: m.id });
  const save = (result: Awaited<ReturnType<typeof run>>, text = result.validatedResponse.text!) => prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", content: text, messageType: "TEXT", deliveryStatus: "INTERNAL" }, "AI_HANDLING", {}, { demoSessionId: f.scoped.demoSessionId, plan, response: { text: result.validatedResponse.text, metadata: result.conversationResponse } }));
  return { ...f, m, input, plan, context, output, check, run, persist: save };
}

test("corrected time and one planned date question pass", async t => {
  const f = await prepared(t); assert.equal(f.check(f.output()).valid, true);
  assert.equal(f.check(f.output({ text: "What day would you like to come in around 12 PM?" })).valid, false);
});
for (const [name, patch] of Object.entries({
  "wrong metadata": { askedField: "service" },
  "dishonest field metadata": { text: "Which service do you want?" },
  "several logical questions under one question mark": { text: "What day, what time and which branch do you prefer?" },
  "multiple punctuation questions": { text: "What day? Which date?" },
  "missing response": { text: null },
  "wrong purpose": { fulfilledPurpose: "ANSWER_CUSTOMER" },
  "unbounded text": { text: "x".repeat(1001) },
  "unplanned service menu": { text: "We offer cleaning, whitening and examinations. What day would you like?" },
  "form language": { text: "Thank you for providing your date. What day?" },
  "jargon": { text: "Your requested entity has been stored. What day?" },
  "independent action": { suggestedAction: "CREATE_BOOKING_REQUEST" },
  "invented fact ID": { referencedFactIds: ["invented"] },
})) test(name, async t => { const f = await prepared(t); assert.equal(f.check({ ...f.output(), ...patch }).valid, false); });

test("known date cannot be requested again", async t => {
  const f = await prepared(t); const snapshot = structuredClone(f.input.conversationSnapshot.state); snapshot.knownEntities.preferredDate = { kind: "DATE", value: "2026-09-16" };
  assert.equal(f.check(f.output(), { state: snapshot }).valid, false);
});
test("greeting and repeated empathy are rejected after prior assistant turns", async t => {
  const f = await prepared(t); const recentMessages = [{ senderType: "AI", text: "That sounds uncomfortable. I can help arrange a visit." }];
  assert.equal(f.check(f.output({ text: "Hello! What day would you like to come?" }), { recentMessages }).valid, false);
  assert.equal(f.check(f.output({ text: "That sounds uncomfortable. What day?", acknowledgedContext: true }), { recentMessages }).valid, false);
  assert.equal(f.check(f.output(), { recentMessages }).valid, true);
});
test("exact options required and invented options rejected", async t => {
  const f = await prepared(t); const options = [{ id: "one", label: "12 PM", value: "12:00", position: 1 }, { id: "two", label: "2 PM", value: "14:00", position: 2 }];
  const plan = { ...f.plan, move: "ASK_FOR_OPTION", options, targetField: "preferredTime", responseDirective: { ...f.plan.responseDirective, purpose: "PRESENT_OPTIONS" } };
  const r = f.output({ text: "12 PM or 2 PM. Which time works best?", askedField: "preferredTime", fulfilledPurpose: "PRESENT_OPTIONS", referencedOptionIds: ["one", "two"] });
  assert.equal(f.check(r, { plan }).valid, true);
  for (const patch of [{ text: "12 PM or 3 PM. Which time works best?" }, { referencedOptionIds: ["one", "fake"] }, { referencedOptionIds: ["one"] }]) assert.equal(f.check({ ...r, ...patch }, { plan }).valid, false);
});
test("clarification may restate options but cannot choose for the customer", async t => {
  const f = await prepared(t); const plan = { ...f.plan, move: "ASK_FOR_CLARIFICATION", targetField: undefined, responseDirective: { ...f.plan.responseDirective, purpose: "CLARIFY" } };
  const r = f.output({ text: "Could you clarify which option you mean?", askedField: null, fulfilledPurpose: "CLARIFY" });
  assert.equal(f.check(r, { plan }).valid, true);
  assert.equal(f.check({ ...r, text: "I'll go with 2 PM. Is that okay?" }, { plan }).valid, false);
});
for (const text of ["Your appointment is confirmed.", "Booked!", "2 PM is available.", "I have passed this to the team.", "Payment received.", "Refund processed.", "Quote sent.", "A staff member is assigned.", "I'm not sure but your booking is confirmed."]) test(`unsupported outcome: ${text}`, async t => {
  const f = await prepared(t); const plan = { ...f.plan, move: "ANSWER", responseDirective: { ...f.plan.responseDirective, purpose: "ANSWER_CUSTOMER", askOneQuestion: false } };
  assert.equal(f.check(f.output({ text, askedField: null, fulfilledPurpose: "ANSWER_CUSTOMER", questionCount: 0 }), { plan }).valid, false);
});
test("outcome claims require successful matching scope, revision and claim category", async t => {
  const f = await prepared(t); const plan = { ...f.plan, move: "ANSWER", responseDirective: { ...f.plan.responseDirective, purpose: "WORKFLOW_RESULT", askOneQuestion: false } };
  const r = f.output({ text: "Your appointment is confirmed.", askedField: null, fulfilledPurpose: "WORKFLOW_RESULT", questionCount: 0, claimsActionCompleted: true, claims: ["APPOINTMENT_CONFIRMED"] });
  const result = { ...scope, sourceMessageId: f.m.id, stateRevision: f.plan.stateRevision, status: "SUCCEEDED", claims: ["APPOINTMENT_CONFIRMED"] };
  assert.equal(f.check(r, { plan, trustedWorkflowResult: result }).valid, true);
  for (const patch of [{ status: "REQUESTED" }, { status: "FAILED" }, { status: "NOT_EXECUTED" }, { businessId: "another" }, { sourceMessageId: "another" }, { stateRevision: 999 }, { claims: ["PAYMENT"] }]) assert.equal(f.check(r, { plan, trustedWorkflowResult: { ...result, ...patch } }).valid, false);
});
test("price requires cited governed evidence and an answer must not resume collection", async t => {
  const f = await prepared(t); const plan = { ...f.plan, move: "ANSWER", responseDirective: { ...f.plan.responseDirective, purpose: "ANSWER_CUSTOMER", askOneQuestion: false } };
  const r = f.output({ text: "Cleaning costs GHS 300.", askedField: null, fulfilledPurpose: "ANSWER_CUSTOMER", questionCount: 0, referencedFactIds: ["cleaning"] }); const facts = [{ id: "cleaning", value: "Cleaning GHS 300" }];
  assert.equal(f.check(r, { plan, facts }).valid, true);
  for (const patch of [{ text: "Cleaning costs GHS 500." }, { text: "Cleaning costs USD 300." }, { referencedFactIds: [] }, { text: "Cleaning costs GHS 300. What day would you like?" }]) assert.equal(f.check({ ...r, ...patch }, { plan, facts }).valid, false);
});
test("one corrective regeneration, summed usage, then atomic persistence and replay", async t => {
  const f = await prepared(t); let calls = 0;
  mockMethod(t, aiProvider, "generateReply", async () => ({ rawText: JSON.stringify(f.output(++calls === 1 ? { text: "Which service?" } : {})), providerRequestCount: 1, totalTokens: 7 }) as any);
  const result = await f.run(); assert.equal(calls, 2); assert.equal(result.totalTokens, 14); assert.equal(result.conversationResponse.regenerationCount, 1);
  const saved = await f.persist(result); assert.equal(f.state().awaiting.field, "preferredDate"); assert.equal(f.state().lastAssistantQuestion, saved.content);
  assert.deepEqual((saved.metadata as any).conversationResponse, result.conversationResponse);
  const revision = f.state().revision; assert.equal((await f.persist(result)).id, saved.id); assert.equal(f.state().revision, revision);
});
test("two invalid responses use a small validated fallback, never a third attempt", async t => {
  const f = await prepared(t); let calls = 0; mockMethod(t, aiProvider, "generateReply", async () => { calls++; return { rawText: "bad JSON", providerRequestCount: 1 } as any; });
  const r = await f.run(); assert.equal(calls, 2); assert.equal(r.conversationResponse.fallbackUsed, true); assert.equal(r.validatedResponse.text, "What day would you like to come in?");
});
test("provider failure leaves canonical inbound and state intact", async t => {
  const f = await prepared(t); const before = structuredClone(f.state()); let calls = 0;
  mockMethod(t, aiProvider, "generateReply", async () => { calls++; throw new Error("provider unavailable"); });
  await assert.rejects(f.run(), { code: "CONVERSATION_RESPONSE_UNAVAILABLE" }); assert.equal(calls, 1); assert.deepEqual(f.state(), before); assert.equal(f.messages().length, 1);
});
test("revision change during response blocks both persistence and stale retry", async t => {
  const f = await prepared(t); let calls = 0;
  mockMethod(t, aiProvider, "generateReply", async () => { calls++; await state.setEntity(f.command(), "branch", { value: "Updated branch" }); return { rawText: JSON.stringify(f.output()), providerRequestCount: 1, totalTokens: 5 } as any; });
  await assert.rejects(f.run(), (e: any) => e.code === "CONVERSATION_STATE_CONFLICT" && e.context.conversationResponseUsage.tokens === 5); assert.equal(calls, 1); assert.equal(f.messages().length, 1);
});
test("changing validated text cannot commit message or awaiting", async t => {
  const f = await prepared(t); mockMethod(t, aiProvider, "generateReply", async () => ({ rawText: JSON.stringify(f.output()), providerRequestCount: 1 }) as any);
  const r = await f.run(); const before = structuredClone(f.state()); await assert.rejects(f.persist(r, "Different question?"), { code: "CONVERSATION_RESPONSE_TEXT_MISMATCH" }); assert.deepEqual(f.state(), before); assert.equal(f.messages().length, 1);
});
for (const tier of ["BASIC", "PLUS", "PREMIUM"]) test(`${tier} uses shared interpreter, planner and response stage with two calls`, async t => {
  const f = await prepared(t); (f.context.planCapabilities as any).plan = tier; let calls = 0;
  mockMethod(t, conversationInterpreterService, "interpret", async () => { calls++; return { interpretation: meaning(), commands: [], appliedRevision: f.state().revision, usage: { providerRequestCount: 1, totalTokens: 3 } } as any; });
  mockMethod(t, aiProvider, "generateReply", async (input: any) => { calls++; assert.equal(input.maxAttempts, 1); assert.ok(input.responseSchema); assert.match(input.systemPrompt, /Same conversational quality for all tiers/); return { rawText: JSON.stringify(responseOutput(input)), providerRequestCount: 1, totalTokens: 4 } as any; });
  const r = await generateContextReply(f.context, { businessId: scope.businessId, conversationId: scope.conversationId, messageId: f.m.id }); assert.equal(calls, 2); assert.equal(r.totalTokens, 7); assert.equal(r.conversationPlan.targetField, "preferredDate");
});
test("demo uses same generator and saves only demo state", async t => {
  const f = await prepared(t, true); mockMethod(t, aiProvider, "generateReply", async (input: any) => { assert.match(input.systemPrompt, /Reply-only demo/); return { rawText: JSON.stringify(f.output()), providerRequestCount: 1 } as any; });
  const r = await f.run(); await f.persist(r); assert.equal(f.plan.demoSessionId, "demo-a"); assert.equal(f.state().awaiting.field, "preferredDate");
  await assert.rejects(state.get(scope), { code: "CONVERSATION_STATE_FORBIDDEN" });
});
test("validated ambiguity can ask a question without bypassing human review", () => {
  const decision: any = { intent: "UNKNOWN", confidence: 1, shouldReply: true, suggestedAction: "SEND_REPLY", replyText: "Which option do you mean?", requiresHumanReview: false };
  assert.equal(aiSafetyService.evaluate({ decision, businessReady: true, humanTakeover: false }).allowed, false);
  assert.equal(aiSafetyService.evaluate({ decision, businessReady: true, humanTakeover: false, validatedConversationClarification: true }).allowed, true);
  assert.equal(aiSafetyService.evaluate({ decision: { ...decision, requiresHumanReview: true }, businessReady: true, humanTakeover: false, validatedConversationClarification: true }).allowed, false);
});

test("exact dental sequence validates visible replies and preserves interrupted booking", async t => {
  const f = setup(t, true); let providerMode: "normal" | "options" | "confirmation" = "normal";
  const realInspect = workflows.inspect.bind(workflows);
  mockMethod(t, workflows, "inspect", async (workflow, input) => {
    if (providerMode === "options") return { status: "OPTIONS", requirements: [], reasonCode: "TEST_PROVIDER_OPTIONS", targetField: "preferredTime", options: [{ id: "option_1", label: "12 PM", value: "12:00", position: 1 }, { id: "option_2", label: "2 PM", value: "14:00", position: 2 }] };
    if (providerMode === "confirmation") return { status: "NEEDS_CONFIRMATION", requirements: [], reasonCode: "TEST_PROVIDER_CONFIRMATION" };
    return realInspect(workflow, input);
  });
  let responseText = ""; let responseCalls = 0;
  mockMethod(t, aiProvider, "generateReply", async (input: any) => { responseCalls++; return { rawText: JSON.stringify(responseOutput(input, responseText)), providerRequestCount: 1 } as any; });
  const speak = async (plan: ConversationPlan, text: string) => {
    responseText = text; const m = f.messages().find(m => m.id === plan.sourceMessageId)!;
    const context = { ...f.context(m), conversationPlan: plan, conversationSnapshot: await conversationContextService.getSnapshot({ ...f.scoped, messageId: m.id }) };
    const r = await responses.generate(context, { businessId: scope.businessId, conversationId: scope.conversationId, messageId: m.id });
    assert.equal(r.conversationResponse.fallbackUsed, false); assert.equal(r.conversationResponse.regenerationCount, 0);
    assert.equal(r.validatedResponse.text, text); assert.ok(text.length < 150); assert.doesNotMatch(text, /confirmed|booked|workflow|entity|Thank you for providing|Please provide your preferred/);
    await prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", content: text, messageType: "TEXT", deliveryStatus: "INTERNAL" }, "AI_HANDLING", {}, { demoSessionId: f.scoped.demoSessionId, plan, response: { text: r.validatedResponse.text, metadata: r.conversationResponse } }));
  };
  const interpret = async (m: any, i: ConversationInterpretation) => {
    const snapshot = await conversationContextService.getSnapshot({ ...f.scoped, messageId: m.id });
    const result = await conversationInterpretationCommandService.apply({ ...f.scoped, sourceMessageId: m.id, snapshotRevision: snapshot.state.revision, interpretation: i });
    assert.equal(result.interpretation.needsClarification, false, result.interpretation.clarificationReason);
    return f.plan(m, result.interpretation);
  };
  const entity = (m: any, key: string, value: string, kind: "TEXT" | "TIME" | "DATE" = "TEXT"): any => ({ key, value, kind, ...(kind !== "TEXT" ? { normalizedValue: value } : {}), confidence: .99, certainty: "EXACT", source: "CURRENT_MESSAGE", evidence: [{ messageId: m.id, quote: m.content }] });
  const first = await f.add("My tooth aches badly and it's shaky.");
  const firstPlan = await interpret(first, meaning({ workflow: { name: "APPOINTMENT_BOOKING", action: "START" }, topic: "APPOINTMENT", resolvedEntities: [entity(first, "reason", "painful/shaky tooth")] }));
  await speak(firstPlan, "That sounds uncomfortable. What day would you like to come in?");
  const time = await f.add("Can I book at 12?"); const datePlan = await interpret(time, meaning({ resolvedEntities: [entity(time, "preferredTime", "12:00", "TIME")] }));
  assert.equal(datePlan.targetField, "preferredDate"); await speak(datePlan, "What day would you like to come in?");
  const tomorrow = await f.add("Tomorrow."); tomorrow.createdAt = new Date("2026-09-11T12:00:00Z"); providerMode = "options";
  const date = { ...entity(tomorrow, "preferredDate", "2026-09-12", "DATE"), source: "REFERENCE_RESOLUTION", reference: { type: "EXPECTATION" }, dateBasis: { type: "DAY_OFFSET", offsetDays: 1 } };
  const optionsPlan = await interpret(tomorrow, meaning({ resolvedEntities: [date], pendingExpectation: { resolved: true, field: "preferredDate" } }));
  await speak(optionsPlan, "12 PM or 2 PM. Which time works best for you?");
  const ordinal = await f.add("The second option."); providerMode = "confirmation";
  const selection = { ...entity(ordinal, "preferredTime", "14:00", "TIME"), source: "REFERENCE_RESOLUTION", reference: { type: "OPTION", optionId: "option_2" } };
  const confirmPlan = await interpret(ordinal, meaning({ resolvedEntities: [selection], selectedOption: { optionId: "option_2", position: 2, value: "14:00", confidence: .99 }, optionResolution: { basis: "POSITION", candidateOptionIds: ["option_2"] }, pendingExpectation: { resolved: true, field: "preferredTime" } }));
  assert.equal(confirmPlan.move, "ASK_FOR_CONFIRMATION"); await speak(confirmPlan, "Would you like me to continue with 2 PM?");
  providerMode = "normal"; const yes = await f.add("Yeah that works.");
  const continuePlan = await interpret(yes, meaning({ confirmation: { type: "YES", confidence: .99 }, pendingExpectation: { resolved: true } })); assert.equal(continuePlan.move, "CONTINUE_WORKFLOW"); await speak(continuePlan, "Let me check that for you.");
  const correction = await f.add("Actually make it 3."); const corrected = await interpret(correction, meaning({ resolvedEntities: [entity(correction, "preferredTime", "15:00", "TIME")], correction: { isCorrection: true, replacesEntity: "preferredTime" } })); assert.equal(corrected.move, "CONTINUE_WORKFLOW"); await speak(corrected, "Let me check 3 PM for you.");
  const pricing = await f.add("How much is cleaning?"); const interrupted = await interpret(pricing, meaning({ intent: "PRICING_INQUIRY", topicShift: { detected: true, from: "APPOINTMENT", to: "SERVICE_ENQUIRY" } })); assert.equal(interrupted.move, "ANSWER"); await speak(interrupted, "That price is not available in the demo.");
  assert.equal(responseCalls, 7);
  const resume = await f.add("Okay, continue with the booking."); const resumed = await interpret(resume, meaning({ workflow: { action: "CONTINUE", name: "APPOINTMENT_BOOKING" } }));
  assert.equal(resumed.move, "CONTINUE_WORKFLOW"); assert.equal(resumed.workflowRequest?.type, "CHECK_APPOINTMENT_AVAILABILITY");
  assert.equal(f.state().knownEntities.reason.value, "painful/shaky tooth"); assert.equal(f.state().knownEntities.preferredDate.normalizedValue, "2026-09-12"); assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "15:00"); assert.deepEqual(resumed.missingFields, []);
  assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING"); assert.ok(f.messages().every(m => !m.content.includes("is confirmed")));
});

test("invalid factual answers fail after two attempts without inventing a template answer", async t => {
  const f = await prepared(t); const input = { ...f.input, interpretation: meaning({ intent: "GENERAL_QUESTION" }) }; f.context.conversationPlan = await planner.plan(input); let calls = 0;
  mockMethod(t, aiProvider, "generateReply", async () => { calls++; return { rawText: "not JSON", providerRequestCount: 1, totalTokens: 3 } as any; });
  await assert.rejects(f.run(), (e: any) => e.code === "CONVERSATION_RESPONSE_INVALID" && e.context.conversationResponseUsage.requests === 2 && e.context.conversationResponseUsage.tokens === 6); assert.equal(calls, 2); assert.equal(f.messages().length, 1);
});
test("audit failure rolls back both validated response and expectation", async t => {
  const f = await prepared(t); mockMethod(t, aiProvider, "generateReply", async () => ({ rawText: JSON.stringify(f.output()), providerRequestCount: 1 }) as any); const result = await f.run();
  const before = structuredClone(f.state()); f.fail(); await assert.rejects(f.persist(result), /audit unavailable/); assert.deepEqual(f.state(), before); assert.equal(f.messages().length, 1);
});
test("supplemental complaint data cannot change canonical intent or reference another tenant issue", async t => {
  const f = await prepared(t); const complaint = { category: "DELAY", severity: "LOW", summary: "Service was late", requiresInternalAction: true, suggestedStaffSpecialtyTags: [], matchType: "CONTINUATION", matchedIssueId: "issue-a" };
  const r = { ...f.output(), complaints: [complaint] };
  assert.equal(f.check(r, { existingIssueIds: ["issue-a"] }).valid, false);
  const plan = { ...f.plan, intent: "COMPLAINT" };
  assert.equal(f.check(r, { plan, existingIssueIds: ["issue-a"] }).valid, true);
  assert.equal(f.check(r, { plan, existingIssueIds: ["issue-b"] }).valid, false);
});
test("demo cannot authorize completion claims even with a forged success result", async t => {
  const f = await prepared(t, true); const plan = { ...f.plan, move: "ANSWER", responseDirective: { ...f.plan.responseDirective, purpose: "ANSWER_CUSTOMER", askOneQuestion: false } };
  const r = f.output({ text: "Your booking is confirmed.", askedField: null, questionCount: 0, fulfilledPurpose: "ANSWER_CUSTOMER", claimsActionCompleted: true, claims: ["APPOINTMENT_CONFIRMED"] });
  assert.equal(f.check(r, { plan, trustedWorkflowResult: { ...scope, sourceMessageId: f.m.id, stateRevision: plan.stateRevision, status: "SUCCEEDED", claims: ["APPOINTMENT_CONFIRMED"] } }).valid, false);
});
test("only actual appointment availability checks provide grounded availability metadata", async t => {
  const f = setup(t); await f.booking(true); const m = await f.add("Continue");
  mockMethod(t, conversationInterpreterService, "interpret", async () => ({ interpretation: meaning(), commands: [], appliedRevision: f.state().revision }) as any);
  mockMethod(t, aiProvider, "generateReply", async (input: any) => {
    const prompt = JSON.parse(input.userPrompt); assert.equal(prompt.trustedWorkflowResult.status, "SUCCEEDED"); assert.deepEqual(prompt.trustedWorkflowResult.claims, ["AVAILABILITY"]);
    return { rawText: JSON.stringify({ ...responseOutput(input, "12 PM is available."), claims: ["AVAILABILITY"] }), providerRequestCount: 1 } as any;
  });
  const r = await generateContextReply(f.context(m), { businessId: scope.businessId, conversationId: scope.conversationId, messageId: m.id });
  assert.deepEqual(r.trustedWorkflowResult.claims, ["AVAILABILITY"]); assert.equal(f.messages().length, 1, "reply stage cannot create appointments or messages");
});
test("NO_ACTION validates ownership and makes no response-provider request", async t => {
  const f = await prepared(t); f.context.conversationPlan = { ...f.plan, move: "NO_ACTION", responseDirective: { ...f.plan.responseDirective, purpose: "WAIT", askOneQuestion: false } };
  mockMethod(t, aiProvider, "generateReply", () => assert.fail("no response call allowed"));
  const r = await f.run(); assert.equal(r.validatedResponse.text, null); assert.equal(r.providerRequestCount, 0); assert.equal(r.conversationResponse.source, "NO_ACTION"); assert.equal(r.conversationResponse.fallbackUsed, false);
  f.context.conversationPlan.businessId = "other-tenant"; await assert.rejects(f.run(), { code: "CONVERSATION_STATE_FORBIDDEN" });
});

test("low wording confidence cannot block a semantically confident planned question", async t => {
  const f = await prepared(t); f.plan.confidence = .96;
  mockMethod(t, aiProvider, "generateReply", async () => ({ rawText: JSON.stringify(f.output({ confidence: .40 })), providerRequestCount: 1 }) as any);
  const result = await f.run();
  assert.equal(result.validatedResponse.confidence, .40, "retain response quality telemetry");
  assert.equal(result.parsedDecision.confidence, .96);
  assert.equal(result.conversationResponse.fallbackUsed, false);
  const safety = aiSafetyService.evaluate({ decision: result.parsedDecision, businessReady: true, humanTakeover: false, minConfidence: .8 });
  assert.equal(safety.allowed, true); assert.equal(safety.status, "SUCCESS");
});
test("perfect wording confidence cannot override ambiguous interpretation or planner restrictions", async t => {
  const f = await prepared(t); const before = structuredClone(f.state());
  mockMethod(t, conversationInterpreterService, "interpret", async () => ({ interpretation: meaning({ confidence: .40, needsClarification: true, clarificationReason: "OPTION_REFERENCE_AMBIGUOUS" }), commands: [], appliedRevision: f.state().revision }) as any);
  mockMethod(t, aiProvider, "generateReply", async (input: any) => ({ rawText: JSON.stringify({ ...responseOutput(input), confidence: 1 }), providerRequestCount: 1 }) as any);
  const result = await generateContextReply(f.context, { ...scope, messageId: f.m.id });
  assert.equal(result.validatedResponse.confidence, 1); assert.equal(result.parsedDecision.confidence, .40);
  assert.equal(result.conversationPlan.move, "ASK_FOR_CLARIFICATION"); assert.equal(result.parsedDecision.intent, "UNKNOWN");
  assert.equal(result.conversationPlan.workflowRequest, undefined); assert.equal(result.parsedDecision.appointmentIntent, undefined);
  assert.equal(result.parsedDecision.suggestedAction, "SEND_REPLY"); assert.deepEqual(f.state(), before);
  const safety = aiSafetyService.evaluate({ decision: result.parsedDecision, businessReady: true, humanTakeover: false, validatedConversationClarification: true, minConfidence: .8 });
  assert.equal(safety.allowed, false); assert.equal(safety.status, "BLOCKED_LOW_CONFIDENCE");
});

test("unknown pricing falls back after two invalid outputs and preserves pending booking", async t => {
  const f = await prepared(t); await state.setAwaiting(f.command(), { type: "FIELD", field: "preferredDate" });
  const snapshot = await conversationContextService.getSnapshot({ ...scope, messageId: f.m.id });
  const plan = await planner.plan({ ...f.input, conversationSnapshot: snapshot, interpretation: meaning({ intent: "PRICING_INQUIRY" }) });
  f.context.conversationPlan = plan; f.context.conversationSnapshot = snapshot; let calls = 0;
  mockMethod(t, aiProvider, "generateReply", async () => { calls++; return { rawText: "invalid JSON", providerRequestCount: 1 } as any; });
  const r = await f.run(); assert.equal(calls, 2); assert.equal(r.conversationResponse.source, "PLAN_FALLBACK");
  assert.equal(r.validatedResponse.text, "I don't have a confirmed price for that right now.");
  assert.equal(r.validatedResponse.askedField, null); assert.deepEqual(r.validatedResponse.claims, []);
  assert.equal(r.parsedDecision.confidence, plan.confidence);
  await prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", content: r.validatedResponse.text!, messageType: "TEXT", deliveryStatus: "INTERNAL" }, "AI_HANDLING", {}, { plan, response: { text: r.validatedResponse.text, metadata: r.conversationResponse } }));
  assert.equal(f.state().awaiting.field, "preferredDate"); assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
});
for (const priceType of ["FIXED", "FREE"] as const) test(`${priceType} price prevents the unknown-price fallback`, async t => {
  const f = await prepared(t); f.context.services = [{ ...f.context.services[0]!, basePrice: priceType === "FREE" ? null : 300, currency: "GHS", priceType }];
  f.context.conversationPlan = await planner.plan({ ...f.input, interpretation: meaning({ intent: "PRICING_INQUIRY" }) });
  mockMethod(t, aiProvider, "generateReply", async () => ({ rawText: "invalid JSON", providerRequestCount: 1 }) as any);
  await assert.rejects(f.run(), { code: "CONVERSATION_RESPONSE_INVALID" });
});
test("clarification without a target requires null askedField despite a pending field", async t => {
  const f = await prepared(t); await state.setAwaiting(f.command(), { type: "FIELD", field: "preferredDate" });
  const snapshot = await conversationContextService.getSnapshot({ ...scope, messageId: f.m.id });
  const plan = await planner.plan({ ...f.input, conversationSnapshot: snapshot, interpretation: meaning({ needsClarification: true, clarificationReason: "OPTION_REFERENCE_AMBIGUOUS" }) });
  f.context.conversationPlan = plan; f.context.conversationSnapshot = snapshot; let calls = 0;
  mockMethod(t, aiProvider, "generateReply", async (input: any) => {
    assert.match(input.systemPrompt, /askedField MUST be JSON null/);
    return { rawText: JSON.stringify({ ...responseOutput(input), askedField: ++calls === 1 ? "preferredDate" : null }), providerRequestCount: 1 } as any;
  });
  const r = await f.run(); assert.equal(calls, 2); assert.equal(r.validatedResponse.askedField, null); assert.equal(r.conversationResponse.fallbackUsed, false);
});
