import { responseOutput } from "./helpers/response-output";
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

test("no active workflow plans an answer without calling adapters or AI", async t => {
  const f = setup(t); const m = await f.add("What are your hours?");
  mockMethod(t, workflows, "inspect", () => { assert.fail("no workflow inspection needed"); });
  mockMethod(t, aiProvider, "generateCompletion", () => { assert.fail("planner must not call AI"); });
  assert.equal((await f.plan(m, meaning({ intent: "GENERAL_QUESTION" }))).move, "ANSWER");
});
test("dental booking asks only missing date, never collected reason or time", async t => {
  const f = setup(t); await f.booking(); const m = await f.add("Can I book at 12?"); const p = await f.plan(m);
  assert.equal(p.move, "ASK_FOR_FIELD"); assert.equal(p.targetField, "preferredDate"); assert.equal(p.responseDirective.askOneQuestion, true);
  assert.ok(p.knownFields.includes("reason")); assert.ok(!p.missingFields.includes("preferredTime"));
  assert.equal(f.state().awaiting, null, "planning alone cannot persist the pending question");
});
test("all required booking inputs request the existing booking boundary without claiming confirmation", async t => {
  const f = setup(t); await f.booking(true); const p = await f.plan(await f.add("Tomorrow"));
  assert.equal(p.move, "CONTINUE_WORKFLOW"); assert.equal(p.workflowRequest?.type, "CREATE_BOOKING_REQUEST"); assert.deepEqual(p.missingFields, []); assert.equal(f.messages().length, 1);
});
test("missing catalog mapping asks a specific clarification, not the known reason", async t => {
  const f = setup(t); await f.booking(); await state.setEntity(f.command(), "preferredDate", { kind: "DATE", value: "2026-09-12", normalizedValue: "2026-09-12" });
  const p = await f.plan(await f.add("Tomorrow")); assert.equal(p.move, "ASK_FOR_CLARIFICATION"); assert.equal(p.targetField, "service"); assert.equal(p.reasonCode, "SERVICE_MAPPING_REQUIRED");
});
test("ambiguity has no request and never inspects a consequential workflow", async t => {
  const f = setup(t); await f.booking(true); mockMethod(t, workflows, "inspect", () => { assert.fail("ambiguity precedes workflow"); });
  const p = await f.plan(await f.add("That one"), meaning({ needsClarification: true, clarificationReason: "OPTION_REFERENCE_AMBIGUOUS" })); assert.equal(p.move, "ASK_FOR_CLARIFICATION"); assert.equal(p.workflowRequest, undefined);
});
for (const intent of ["HUMAN_REQUEST", "COMPLAINT"] as const) test(`${intent} preserves existing review policy`, async t => {
  const f = setup(t); const p = await f.plan(await f.add("Help"), meaning({ intent })); assert.equal(p.move, "REQUEST_HUMAN"); assert.equal(p.requiresHumanReview, true); assert.equal(p.workflowRequest, undefined);
});
test("existing human control outranks an ambiguous interpretation", async t => {
  const f = setup(t); const input = await f.input(await f.add("Maybe"), meaning({ needsClarification: true })); input.businessContext.conversation.humanTakeover = true;
  assert.equal((await planner.plan(input)).move, "NO_ACTION");
});
test("pricing interruption preserves pending booking; next booking answer resumes it", async t => {
  const f = setup(t); await f.booking(); await state.setAwaiting(f.command(), { type: "FIELD", field: "preferredDate" });
  const p = await f.plan(await f.add("How much is cleaning?"), meaning({ intent: "PRICING_INQUIRY", topicShift: { detected: true } }));
  assert.equal(p.move, "ANSWER"); assert.equal(p.suspendedContext?.stillAwaiting, "preferredDate");
  await f.save(p, "The price is not available."); assert.equal(f.state().awaiting.field, "preferredDate");
  assert.equal((await f.plan(await f.add("Continue with booking"))).targetField, "preferredDate");
});
test("explicit cancellation respects already-cancelled state and does not restart booking", async t => {
  const f = setup(t); await f.booking(); await state.resetWorkflow(f.command());
  const p = await f.plan(await f.add("Forget the booking"), meaning({ intent: "CANCELLATION_INTENT", workflow: { action: "CANCEL", name: "APPOINTMENT_BOOKING" } })); assert.equal(p.move, "CANCEL_WORKFLOW"); assert.equal(p.workflowRequest, undefined);
});
test("confident cancellation plus a current question answers after the semantic cancellation", async t => {
  const f = setup(t); await f.booking(); await state.resetWorkflow(f.command());
  const p = await f.plan(await f.add("Forget booking. What are your hours?"), meaning({ intent: "GENERAL_QUESTION", topicShift: { detected: true } })); assert.equal(p.move, "ANSWER"); assert.equal(p.suspendedContext, undefined);
});
test("confirmation and corrected/selected time continue from updated state", async t => {
  const f = setup(t); await f.booking(true); await state.setEntity(f.command(), "preferredTime", { kind: "TIME", value: "2 PM", normalizedValue: "14:00" });
  for (const i of [meaning({ confirmation: { type: "YES", confidence: 1 } }), meaning({ correction: { isCorrection: true, replacesEntity: "preferredTime" } }), meaning({ selectedOption: { optionId: "option_2", confidence: 1 } })]) {
    const p = await f.plan(await f.add("Continue"), i); assert.equal(p.move, "CONTINUE_WORKFLOW"); assert.equal(p.workflowRequest?.preferredTime, "14:00");
  }
});
test("rejected confirmation clarifies rather than submitting booking", async t => {
  const f = setup(t); await f.booking(true); const p = await f.plan(await f.add("No"), meaning({ confirmation: { type: "NO", confidence: 1 } })); assert.equal(p.move, "ASK_FOR_CLARIFICATION"); assert.equal(p.workflowRequest, undefined);
});
test("pending confirmation and system result remain separate expectations", async t => {
  const f = setup(t); await f.booking(); await state.setAwaiting(f.command(), { type: "CONFIRMATION" }); const p = await f.plan(await f.add("Continue"));
  assert.equal(p.move, "ASK_FOR_CONFIRMATION"); await f.save(p, "Would you like to continue?"); assert.equal(f.state().awaiting.type, "CONFIRMATION");
  await state.setAwaiting(f.command(), { type: "SYSTEM_RESULT" }); assert.equal((await f.plan(await f.add("Yes"))).move, "WAIT_FOR_SYSTEM");
});
test("assistant question and expectation commit together; repeat source returns same message", async t => {
  const f = setup(t); await f.booking(); const m = await f.add("Can I book at 12?"); const p = await f.plan(m);
  const first = await f.save(p, "What day would you like to come in?"); const revision = f.state().revision;
  assert.equal(f.state().awaiting.question, first.content); assert.equal(f.state().awaiting.field, "preferredDate");
  const second = await f.save(p, "Contradictory regenerated question"); assert.equal(second.id, first.id); assert.equal(f.state().revision, revision); assert.equal(f.messages().filter(m => m.senderType === "AI").length, 1);
});
test("state failure rolls back the AI message and no expectation appears", async t => {
  const f = setup(t); await f.booking(); const p = await f.plan(await f.add("Can I book?")); const before = structuredClone(f.state()); f.fail();
  await assert.rejects(f.save(p, "What day?")); assert.deepEqual(f.state(), before); assert.equal(f.messages().filter(m => m.senderType === "AI").length, 0);
});
test("trusted adapter options commit with reply and acquire server TTL", async t => {
  const f = setup(t); await f.booking(true);
  mockMethod(t, workflows, "inspect", async () => ({ status: "OPTIONS", reasonCode: "PROVIDER_OPTIONS", requirements: [], targetField: "preferredTime", options: [{ id: "slot_1", label: "12 PM", value: "12:00", position: 1 }, { id: "slot_2", label: "2 PM", value: "14:00", position: 2 }] }));
  const p = await f.plan(await f.add("What times?")); assert.equal(f.state().offeredOptions.length, 0);
  await f.save(p, "We have 12 PM and 2 PM available."); assert.equal(f.state().awaiting.type, "OPTION_SELECTION"); assert.equal(f.state().offeredOptions.length, 2); assert.ok(f.state().offeredOptionsCreatedAt);
});
test("invented reply options are never copied into state; invalid plan blobs are rejected", async t => {
  const f = setup(t); const p = await f.plan(await f.add("Hello"), meaning({ intent: "GENERAL_QUESTION" })); await f.save(p, "Invented options: noon or 2 PM."); assert.deepEqual(f.state().offeredOptions, []);
  assert.throws(() => conversationPlanSchema.parse({ ...p, arbitraryState: {} })); assert.throws(() => conversationPlanSchema.parse({ ...p, move: "ASK_FOR_OPTION", targetField: "preferredTime", options: [] }));
});
test("stale plan cannot persist a reply; stale snapshot cannot be planned", async t => {
  const f = setup(t); await f.booking(); const input = await f.input(await f.add("Tomorrow")); const p = await planner.plan(input);
  await state.setEntity(f.command(), "branch", { value: "New branch" });
  await assert.rejects(planner.plan(input), (e: any) => e.code === "CONVERSATION_STATE_CONFLICT"); await assert.rejects(f.save(p, "Old question"), (e: any) => e.code === "CONVERSATION_STATE_CONFLICT"); assert.equal(f.messages().filter(m => m.senderType === "AI").length, 0);
});
test("adapter failure and concurrent changes do not produce stale actions", async t => {
  const f = setup(t); await f.booking(true); const m = await f.add("Continue");
  mockMethod(t, workflows, "inspect", async () => { throw new Error("Provider unavailable"); }); const p = await f.plan(m); assert.equal(p.workflowRequest, undefined); assert.equal(p.reasonCode, "WORKFLOW_PROVIDER_UNAVAILABLE");
});
test("tenant mismatch, foreign source and expired demo are rejected", async t => {
  const f = setup(t, true); const m = await f.add("Hello"); const input = await f.input(m);
  await assert.rejects(planner.plan({ ...input, businessContext: { ...input.businessContext, business: { ...input.businessContext.business, id: "other" } } }));
  await assert.rejects(planner.plan({ ...input, businessContext: { ...input.businessContext, demoSessionId: undefined } })); f.expire(); await assert.rejects(planner.plan(input));
});
test("demo shares planner but never requests production creation", async t => {
  const f = setup(t, true); await f.booking(true); const p = await f.plan(await f.add("Tomorrow")); assert.equal(p.workflowRequest?.type, "CHECK_APPOINTMENT_AVAILABILITY"); assert.equal(p.reasonCode, "DEMO_AVAILABILITY_NOT_CONNECTED"); await f.save(p, "Actual availability is not connected in this demo.");
  const human = await f.plan(await f.add("Human please"), meaning({ intent: "HUMAN_REQUEST" })); assert.equal(human.move, "REQUEST_HUMAN"); assert.equal(human.requiresHumanReview, false);
});
test("shared runtime makes two calls, supplies plan, and overrides model re-planning", async t => {
  const f = setup(t); await f.booking(); const m = await f.add("Can I book at 12?"); let calls = 0;
  mockMethod(t, conversationInterpreterService, "interpret", async () => { calls++; return { interpretation: meaning(), commands: [], appliedRevision: f.state().revision }; });
  mockMethod(t, aiProvider, "generateReply", async (input: any) => { calls++; assert.match(input.systemPrompt, /authoritative next conversational move/); assert.doesNotMatch(input.systemPrompt, /if service, date, and time are present/); assert.match(input.userPrompt, /ASK_FOR_FIELD/); return { rawText: JSON.stringify(responseOutput(input)), totalTokens: 1, providerRequestCount: 1 }; });
  const result = await generateContextReply(f.context(m), { ...scope, messageId: m.id }); assert.equal(calls, 2); assert.equal(result.parsedDecision!.suggestedAction, "SEND_REPLY"); assert.equal(result.parsedDecision!.appointmentIntent, undefined); assert.equal(result.conversationPlan.targetField, "preferredDate");
});
test("shared booking requirements reject invalid dates and times", () => {
  assert.deepEqual(missingAiBookingFields({ serviceId: "s", preferredDate: "2026-02-30", preferredTime: "25:00" }), ["preferredDate", "preferredTime"]);
});


test("availability rejection asks a specific correction and never submits a booking", async t => {
  const f = setup(t); await f.booking(true);
  mockMethod(t, appointmentPlanningBackend, "checkSlot", async () => ({ available: false, reason: "BUSINESS_CLOSED" }) as any);
  const p = await f.plan(await f.add("Tomorrow")); assert.equal(p.move, "ASK_FOR_CLARIFICATION"); assert.equal(p.targetField, "preferredTime"); assert.equal(p.workflowRequest, undefined);
});
test("revision changing during adapter inspection rejects its action", async t => {
  const f = setup(t); await f.booking(true);
  mockMethod(t, appointmentPlanningBackend, "checkSlot", async () => { await state.setEntity(f.command(), "branch", { value: "Other branch" }); return { available: true, reason: null } as any; });
  await assert.rejects(f.plan(await f.add("Continue")), (e: any) => e.code === "CONVERSATION_STATE_CONFLICT");
});
test("full dental sequence persists planner questions/options and consumes validated meaning", async t => {
  const f = setup(t, true); let providerMode: "normal" | "options" | "confirmation" = "normal";
  const realInspect = workflows.inspect.bind(workflows);
  mockMethod(t, workflows, "inspect", async (workflow, input) => {
    if (providerMode === "options") return { status: "OPTIONS", requirements: [], reasonCode: "TEST_PROVIDER_OPTIONS", targetField: "preferredTime", options: [{ id: "option_1", label: "12 PM", value: "12:00", position: 1 }, { id: "option_2", label: "2 PM", value: "14:00", position: 2 }] };
    if (providerMode === "confirmation") return { status: "NEEDS_CONFIRMATION", requirements: [], reasonCode: "TEST_PROVIDER_CONFIRMATION" };
    return realInspect(workflow, input);
  });
  const interpret = async (m: any, i: ConversationInterpretation) => {
    const snapshot = await conversationContextService.getSnapshot({ ...f.scoped, messageId: m.id });
    const result = await conversationInterpretationCommandService.apply({ ...f.scoped, sourceMessageId: m.id, snapshotRevision: snapshot.state.revision, interpretation: i });
    assert.equal(result.interpretation.needsClarification, false, result.interpretation.clarificationReason);
    return f.plan(m, result.interpretation);
  };
  const entity = (m: any, key: string, value: string, kind: "TEXT" | "TIME" | "DATE" = "TEXT"): any => ({ key, value, kind, ...(kind !== "TEXT" ? { normalizedValue: value } : {}), confidence: .99, certainty: "EXACT", source: "CURRENT_MESSAGE", evidence: [{ messageId: m.id, quote: m.content }] });
  const first = await f.add("My tooth aches badly and it's shaky.");
  await interpret(first, meaning({ workflow: { name: "APPOINTMENT_BOOKING", action: "START" }, topic: "APPOINTMENT", resolvedEntities: [entity(first, "reason", "painful/shaky tooth")] }));
  const time = await f.add("Can I book at 12?"); const datePlan = await interpret(time, meaning({ resolvedEntities: [entity(time, "preferredTime", "12:00", "TIME")] }));
  assert.equal(datePlan.targetField, "preferredDate"); await f.save(datePlan, "What day would you like to come in?");
  const tomorrow = await f.add("Tomorrow."); tomorrow.createdAt = new Date("2026-09-11T12:00:00Z"); providerMode = "options";
  const date = { ...entity(tomorrow, "preferredDate", "2026-09-12", "DATE"), source: "REFERENCE_RESOLUTION", reference: { type: "EXPECTATION" }, dateBasis: { type: "DAY_OFFSET", offsetDays: 1 } };
  const optionsPlan = await interpret(tomorrow, meaning({ resolvedEntities: [date], pendingExpectation: { resolved: true, field: "preferredDate" } }));
  await f.save(optionsPlan, "We have 12 PM and 2 PM available.");
  const ordinal = await f.add("The second one."); providerMode = "confirmation";
  const selection = { ...entity(ordinal, "preferredTime", "14:00", "TIME"), source: "REFERENCE_RESOLUTION", reference: { type: "OPTION", optionId: "option_2" } };
  const confirmPlan = await interpret(ordinal, meaning({ resolvedEntities: [selection], selectedOption: { optionId: "option_2", position: 2, value: "14:00", confidence: .99 }, optionResolution: { basis: "POSITION", candidateOptionIds: ["option_2"] }, pendingExpectation: { resolved: true, field: "preferredTime" } }));
  assert.equal(confirmPlan.move, "ASK_FOR_CONFIRMATION"); await f.save(confirmPlan, "Would you like me to continue with 2 PM?");
  providerMode = "normal"; const yes = await f.add("Yeah, that works.");
  const continuePlan = await interpret(yes, meaning({ confirmation: { type: "YES", confidence: .99 }, pendingExpectation: { resolved: true } })); assert.equal(continuePlan.move, "CONTINUE_WORKFLOW");
  const correction = await f.add("Actually make it 3."); const corrected = await interpret(correction, meaning({ resolvedEntities: [entity(correction, "preferredTime", "15:00", "TIME")], correction: { isCorrection: true, replacesEntity: "preferredTime" } })); assert.equal(corrected.move, "CONTINUE_WORKFLOW");
  const pricing = await f.add("How much is cleaning?"); const interrupted = await interpret(pricing, meaning({ intent: "PRICING_INQUIRY", topicShift: { detected: true, from: "APPOINTMENT", to: "SERVICE_ENQUIRY" } })); assert.equal(interrupted.move, "ANSWER"); await f.save(interrupted, "That price is not available in the demo.");
  const resume = await f.add("Okay, continue with the booking."); const resumed = await interpret(resume, meaning({ workflow: { action: "CONTINUE", name: "APPOINTMENT_BOOKING" } }));
  assert.equal(resumed.move, "CONTINUE_WORKFLOW"); assert.equal(resumed.workflowRequest?.type, "CHECK_APPOINTMENT_AVAILABILITY");
  assert.equal(f.state().knownEntities.reason.value, "painful/shaky tooth"); assert.equal(f.state().knownEntities.preferredDate.normalizedValue, "2026-09-12"); assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "15:00"); assert.deepEqual(resumed.missingFields, []);
  assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING"); assert.ok(f.messages().every(m => !m.content.includes("is confirmed")));
});


test("explicit canonical cancellation plus topic shift clears only the conversational workflow", async t => {
  const f = setup(t); await f.booking(); await state.setAwaiting(f.command(), { type: "FIELD", field: "preferredDate" }); const m = await f.add("Forget the booking. What are your hours?");
  const result = await conversationInterpretationCommandService.apply({ ...scope, sourceMessageId: m.id, snapshotRevision: f.state().revision, interpretation: meaning({ intent: "CANCELLATION_INTENT", workflow: { action: "CANCEL", name: "APPOINTMENT_BOOKING" }, topicShift: { detected: true, from: "APPOINTMENT", to: "GENERAL_ENQUIRY" } }) });
  assert.equal(result.interpretation.needsClarification, false); assert.equal(f.state().activeWorkflow, null); assert.equal(f.state().awaiting, null);
  const p = await f.plan(m, result.interpretation); assert.equal(p.move, "ANSWER"); assert.equal(p.workflowRequest, undefined); assert.equal(p.suspendedContext, undefined);
});


test("human takeover after planning blocks the old reply without resetting state", async t => {
  const f = setup(t); await f.booking(); const p = await f.plan(await f.add("Can I book?")); const before = structuredClone(f.state()); f.human();
  await assert.rejects(f.save(p, "What day?"), (e: any) => e.code === "CONVERSATION_PLAN_CONTROL_CHANGED"); assert.deepEqual(f.state(), before);
});


test("production AI disable after planning still blocks persistence", async t => {
  const f = setup(t);
  const p = await f.plan(await f.add("Hello"));
  f.disableAi();
  await assert.rejects(f.save(p, "Hello"), (e: any) => e.code === "CONVERSATION_PLAN_CONTROL_CHANGED");
});

test("demo production automation stays disabled while replies work; takeover still blocks", async t => {
  const f = setup(t, true);
  const p = await f.plan(await f.add("Hello"));
  await f.save(p, "Hello");
  const next = await f.plan(await f.add("Help"));
  f.human();
  await assert.rejects(f.save(next, "Hello"), (e: any) => e.code === "CONVERSATION_PLAN_CONTROL_CHANGED");
});
