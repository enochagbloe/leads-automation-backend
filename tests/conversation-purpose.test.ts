import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { mockMethod } from "./helpers/mock-method";
import { responseOutput } from "./helpers/response-output";
import { prisma } from "../src/config/prisma";
import { aiProvider } from "../src/services/ai-provider.service";
import { generateContextReply } from "../src/services/ai-reply-runtime.service";
import { conversationStateService as state } from "../src/services/conversation-state.service";
import { conversationInterpretationCommandService as commands } from "../src/services/conversation-interpretation-command.service";
import { conversationContextService } from "../src/services/conversation-context.service";
import { appointmentPlanningBackend, appointmentConversationAdapter } from "../src/services/conversation-workflow-planning.service";
import { storeAiReply } from "../src/services/ai-message-store.service";
import { AiBusinessContext } from "../src/services/ai-context-builder.service";
import { CustomerPurpose } from "../src/services/conversation-purpose.schema";
import { ConversationInterpretation } from "../src/services/conversation-interpretation.schema";
import { adaptDemoRuntimeContext } from "../src/services/demo-runtime-context.adapter";
import { emptyDemoFacts } from "../src/services/demo-extraction.service";
import { conversationResponsePolicyService } from "../src/services/conversation-response-policy.service";
import { responseFacts } from "../src/services/conversation-response.service";

const catalogs = {
  consultancy: [{ name: "Strategy consultation", description: "Advice on business strategy and planning" }],
  repair: [{ name: "AC Inspection", description: "Diagnose air conditioners that run without cooling" }, { name: "AC Installation", description: "Install new air conditioning units" }, { name: "Preventive Maintenance", description: "Scheduled preventative servicing" }],
  plumbing: [{ name: "Plumbing inspection", description: "Inspect and repair leaking sinks and pipes" }],
  photography: [{ name: "Residential Photography", description: "Photograph homes and properties" }, { name: "Wedding Photography", description: "Photograph weddings" }, { name: "Corporate Photography", description: "Business events and corporate portraits" }],
};
type Catalog = keyof typeof catalogs;
async function setup(t: TestContext, catalog: Catalog, demo = false) {
  const f = fixture(t); if (demo) f.demo();
  const scoped = { ...scope, ...(demo ? { demoSessionId: "demo-a" } : {}) };
  const facts = emptyDemoFacts(); facts.services = catalogs[catalog].map(s => ({ ...s, price: null, duration: null }));
  const normalized = await adaptDemoRuntimeContext({ actorType: "DEMO", isDemo: true, businessId: scope.businessId, demoSessionId: "demo-a" }, { businessName: "Fixture business", facts, sourceWebsite: "https://example.com/", crawlStatus: "COMPLETE", extractionStatus: "COMPLETE", startedAt: new Date().toISOString(), completedAt: null, pagesAttempted: 1, pagesFetched: 1, errorCode: null, sources: [], bookingLinks: [], contactLinks: [], unknowns: [] });
  const services = demo ? normalized.services : catalogs[catalog].map((s, i) => ({ ...s, id: `service-${i}`, isBookable: true, durationMinutes: 30 }));
  const context = (m: any): AiBusinessContext => ({ ...normalized, services, ...scoped, business: { ...normalized.business, timezone: "Africa/Accra" }, readiness: { isAiReady: true, readinessStatus: "READY", completionPercentage: 100, missingItems: [], warnings: [] }, conversation: { id: scope.conversationId, status: "OPEN", channel: demo ? "DEMO" : "WHATSAPP", aiEnabled: !demo }, recentMessages: [], existingCustomerIssues: [], pendingFollowUpContexts: [], lead: null, customerMemory: { leadId: "lead-a", summary: null, activeGoal: null, serviceInterests: [], preferences: [], objections: [], timingStatements: [], missingDetails: [], unresolvedRequests: [], appointmentContext: null, leadContext: {}, lastImportantCustomerAction: null, lastStaffAction: null, humanTakeover: { active: false, aiEnabled: true, needsHumanReview: false }, memoryRevision: 0, memoryEnabled: false, memoryVersion: null }, planCapabilities: { plan: "BASIC", aiReplies: true, teamRouting: false, safeAutoConfirm: false, tone: "PROFESSIONAL" }, triggerMessage: { id: m.id, text: m.content, createdAt: m.createdAt.toISOString() } });
  let next: ConversationInterpretation; let reply = "Sure — what do you need help with?"; let fail = false;
  const requests: any[] = [];
  const interpretation = mockMethod(t, aiProvider, "generateCompletion", async (input: any) => { requests.push(input); if (fail) throw new Error("provider unavailable"); assert.deepEqual(JSON.parse(input.userPrompt).business.services.map((s: any) => s.id), services.map(s => s.id)); return { rawText: JSON.stringify(next), providerRequestCount: 1, provider: "OPENROUTER", model: "test" }; });
  const response = mockMethod(t, aiProvider, "generateReply", async (input: any) => { requests.push(input); return { rawText: JSON.stringify(responseOutput(input, reply)), providerRequestCount: 1, provider: "OPENROUTER", model: "test" }; });
  const slots = mockMethod(t, appointmentPlanningBackend, "checkSlot", async () => { assert.equal(demo, false); return { available: true, reason: null }; });
  const effects = [prisma.service, prisma.appointment, prisma.customerMemoryItem, prisma.followUpJob, prisma.businessNotification].map(delegate => mockMethod(t, delegate, "create", () => { assert.fail("No production writes from conversation understanding"); }));
  let seq = 0;
  const command = () => ({ ...scoped, expectedRevision: f.state()?.revision ?? 0, source: "WORKFLOW" as const, sourceEffectId: `purpose-test:${++seq}` });
  const meaning = (m: any, resolution: CustomerPurpose["resolution"], goal: CustomerPurpose["goal"] = "ARRANGE_SERVICE", selected = 0, need: string | null = m.content): ConversationInterpretation => ({
    intent: goal === "ARRANGE_SERVICE" ? "BOOKING_INTENT" : "SERVICE_INQUIRY", confidence: .98, needsClarification: false, resolvedEntities: [],
    ...(goal === "ARRANGE_SERVICE" ? { topic: "APPOINTMENT", workflow: { name: "APPOINTMENT_BOOKING", action: "START" } } : {}),
    customerPurpose: { goal, need, resolution, serviceId: ["EXACT", "INFERRED"].includes(resolution) ? services[selected]!.id : null, candidateServiceIds: resolution === "AMBIGUOUS" ? services.map(s => s.id).slice(0, 3) : [], confidence: .98, evidence: [{ messageId: m.id, quote: m.content }], catalogEvidence: resolution === "INFERRED" ? [{ serviceId: services[selected]!.id, quote: services[selected]!.description! }] : [] },
  });
  const run = async (m: any, i: ConversationInterpretation, text: string) => { next = i; reply = text; return generateContextReply(context(m), { ...scope, messageId: m.id }); };
  const save = (r: Awaited<ReturnType<typeof run>>) => prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", messageType: "TEXT", content: r.validatedResponse.text!, deliveryStatus: "INTERNAL" }, "OPEN", {}, { demoSessionId: scoped.demoSessionId, plan: r.conversationPlan, response: { text: r.validatedResponse.text, metadata: r.conversationResponse } }));
  t.after(() => { for (const spy of effects) assert.equal(spy.mock.callCount(), 0); });
  return { ...f, services, scoped, command, context, meaning, run, save, requests, interpretation, response, slots, failProvider: () => { fail = true; } };
}
function temporal(m: any, key: "preferredDate" | "preferredTime", value: string): ConversationInterpretation["resolvedEntities"][number] {
  return { key, kind: key === "preferredDate" ? "DATE" : "TIME", value, normalizedValue: value, confidence: .98, certainty: "EXACT", source: "CURRENT_MESSAGE", evidence: [{ messageId: m.id, quote: m.content }], ...(key === "preferredDate" ? { dateBasis: { type: "DAY_OFFSET", offsetDays: 1 } } : {}) };
}

for (const demo of [false, true]) {
  const mode = demo ? "demo" : "production BASIC";
  for (const catalog of ["consultancy", "repair"] as const) test(`${mode} ${catalog}: generic booking asks purpose even with one service or an old date question`, async t => {
    const f = await setup(t, catalog, demo);
    await state.setAwaiting(f.command(), { type: "FIELD", field: "preferredDate" });
    const m = await f.add("I want to book an appointment");
    const r = await f.run(m, f.meaning(m, "UNSPECIFIED", "ARRANGE_SERVICE", 0, null), "Sure — what would you like the appointment for?");
    assert.equal(r.conversationPlan.targetField, "serviceNeed"); assert.equal(r.conversationPlan.workflowRequest, undefined);
    assert.equal(f.state().knownEntities.customerGoal.value, "ARRANGE_SERVICE"); assert.equal(f.state().activeWorkflow, null);
    await f.save(r); assert.equal(f.state().awaiting.field, "serviceNeed");
    assert.equal(f.slots.mock.callCount(), 0); assert.equal(r.providerRequestCount, 2);
  });
  for (const [catalog, message] of [["repair", "My AC turns on but doesn't cool. Can someone check it?"], ["plumbing", "My sink keeps leaking and I need someone to come look at it"]] as const) test(`${mode} ${catalog}: maps a need without demanding catalog wording`, async t => {
    const f = await setup(t, catalog, demo); const m = await f.add(message);
    const r = await f.run(m, f.meaning(m, "INFERRED"), "What day would you like to arrange this for?");
    assert.equal(f.state().knownEntities.serviceNeed.value, message); assert.equal(f.state().knownEntities.serviceId.value, f.services[0]!.id);
    assert.notEqual(f.state().knownEntities.serviceNeed.value, f.state().knownEntities.serviceName.value);
    assert.equal(f.state().knownEntities.serviceResolution.value, "INFERRED"); assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
    assert.equal(r.conversationPlan.targetField, "preferredDate"); assert.equal(r.providerRequestCount, 2);
  });
  test(`${mode}: ambiguous photography need asks one useful question and retains the need`, async t => {
    const f = await setup(t, "photography", demo); const m = await f.add("I need a photographer");
    const r = await f.run(m, f.meaning(m, "AMBIGUOUS", "SEEK_SERVICE"), "Is this for a home, a wedding, or a business shoot?");
    assert.equal(r.conversationPlan.move, "ASK_FOR_CLARIFICATION"); assert.equal(r.conversationPlan.targetField, "serviceNeed");
    assert.equal(r.conversationPlan.serviceClarification!.candidates.length, 3);
    assert.equal(f.state().knownEntities.serviceNeed.value, m.content); assert.equal(f.state().knownEntities.serviceId, undefined);
    assert.equal(f.state().activeWorkflow, null); assert.equal(r.validatedResponse.questionCount, 1); assert.equal(r.providerRequestCount, 2);
  });
  test(`${mode}: exact service reference resolves without inventing a booking intent`, async t => {
    const f = await setup(t, "consultancy", demo); const m = await f.add("I want the strategy consultation");
    const r = await f.run(m, f.meaning(m, "EXACT", "SEEK_SERVICE"), "We offer advice on business strategy and planning.");
    assert.equal(f.state().knownEntities.serviceId.value, f.services[0]!.id); assert.equal(f.state().activeWorkflow, null);
    assert.equal(r.conversationPlan.move, "ANSWER"); assert.equal(f.slots.mock.callCount(), 0);
  });
  test(`${mode}: complete request preserves service, goal, business-local date and contextually clear time`, async t => {
    const f = await setup(t, "consultancy", demo); await f.add("Afternoon consultations are offered.", "AI");
    const m = await f.add("Can I book the strategy consultation tomorrow at 2?"); m.createdAt = new Date("2026-09-22T10:00:00Z");
    const i = f.meaning(m, "EXACT"); i.resolvedEntities = [temporal(m, "preferredDate", "2026-09-23"), temporal(m, "preferredTime", "14:00")];
    const r = await f.run(m, i, demo ? "Live availability and appointment booking are not connected in this demo." : "I have those details.");
    assert.equal(f.state().knownEntities.preferredDate.normalizedValue, "2026-09-23"); assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "14:00");
    assert.equal(r.conversationPlan.targetField, undefined); assert.deepEqual(r.conversationPlan.missingFields, []);
    assert.equal(r.conversationPlan.workflowRequest!.serviceId, f.services[0]!.id); assert.equal(f.slots.mock.callCount(), demo ? 0 : 1);
  });
  test(`${mode}: unsupported booking never invents a service or collects a date`, async t => {
    const f = await setup(t, "consultancy", demo); const m = await f.add("I want to book a plumbing repair");
    const r = await f.run(m, f.meaning(m, "UNSUPPORTED"), "Plumbing repair is not listed in our services. What other help do you need?");
    assert.equal(r.conversationPlan.reasonCode, "SERVICE_UNSUPPORTED"); assert.equal(r.conversationPlan.targetField, "serviceNeed");
    assert.equal(f.state().knownEntities.serviceId, undefined); assert.equal(f.state().activeWorkflow, null); assert.equal(f.slots.mock.callCount(), 0);
  });
  test(`${mode}: non-booking service question stays an inquiry`, async t => {
    const f = await setup(t, "photography", demo); const m = await f.add("Do you guys do wedding photography?");
    const r = await f.run(m, f.meaning(m, "EXACT", "INQUIRE_SERVICE", 1), "Yes, we offer wedding photography.");
    assert.equal(r.parsedDecision.intent, "SERVICE_INQUIRY"); assert.equal(f.state().knownEntities.customerGoal.value, "INQUIRE_SERVICE");
    assert.equal(f.state().activeWorkflow, null); assert.equal(r.conversationPlan.workflowRequest, undefined); assert.equal(r.providerRequestCount, 2);
  });
}

test("purpose clarification continues the stored booking goal and does not re-ask supplied date/time", async t => {
  const f = await setup(t, "consultancy", true); const m = await f.add("Can I book tomorrow at 2pm?"); m.createdAt = new Date("2026-09-22T10:00:00Z");
  const i = f.meaning(m, "UNSPECIFIED", "ARRANGE_SERVICE", 0, null); i.resolvedEntities = [temporal(m, "preferredDate", "2026-09-23"), temporal(m, "preferredTime", "14:00")];
  const first = await f.run(m, i, "Sure — what do you need help with?"); await f.save(first);
  const next = await f.add("The strategy consultation");
  const second = await f.run(next, f.meaning(next, "EXACT"), "Live availability and appointment booking are not connected in this demo.");
  const prompt = JSON.parse(f.requests[2].userPrompt); assert.equal(prompt.continuationIntentCandidate, "BOOKING_INTENT");
  assert.equal(second.conversationPlan.targetField, undefined); assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "14:00");
  assert.equal(f.state().awaiting, null); assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
});

for (const invalid of ["foreign-id", "fabricated-evidence", "invented-catalog-quote", "inquiry-starts-booking"]) test(`purpose rejects ${invalid} without semantic state mutation`, async t => {
  const f = await setup(t, "repair"); const m = await f.add("My AC is running but not cooling. Please come inspect it.");
  const i = f.meaning(m, "INFERRED");
  if (invalid === "foreign-id") i.customerPurpose!.serviceId = "foreign-service";
  if (invalid === "fabricated-evidence") i.customerPurpose!.evidence[0]!.quote = "fabricated customer statement";
  if (invalid === "invented-catalog-quote") i.customerPurpose!.catalogEvidence[0]!.quote = "service not in this catalog";
  if (invalid === "inquiry-starts-booking") { i.intent = "SERVICE_INQUIRY"; i.customerPurpose!.goal = "INQUIRE_SERVICE"; }
  const snapshot = await conversationContextService.getSnapshot({ ...f.scoped, messageId: m.id });
  const result = await commands.apply({ ...f.scoped, sourceMessageId: m.id, snapshotRevision: snapshot.state.revision, interpretation: i, businessContext: f.context(m) });
  assert.equal(result.interpretation.needsClarification, true); assert.equal(result.commands.length, 0); assert.deepEqual(f.state().knownEntities, {});
});

test("low mapping confidence retains the need, but does not choose a service", async t => {
  const f = await setup(t, "repair"); const m = await f.add("Something is wrong with my AC, can someone check?"); const i = f.meaning(m, "INFERRED"); i.customerPurpose!.confidence = .4;
  const r = await f.run(m, i, "Could you tell me more about the problem you need help with?");
  assert.equal(f.state().knownEntities.customerGoal.value, "ARRANGE_SERVICE"); assert.equal(f.state().knownEntities.serviceNeed.value, m.content);
  assert.equal(f.state().knownEntities.serviceId, undefined); assert.equal(r.conversationPlan.targetField, "serviceNeed");
});

test("purpose replay, conflicts, scope, provider failure and atomic rollback use existing protections", async t => {
  const f = await setup(t, "consultancy", true); const m = await f.add("Can I book the strategy consultation?");
  const snapshot = await conversationContextService.getSnapshot({ ...f.scoped, messageId: m.id });
  const input = { ...f.scoped, sourceMessageId: m.id, snapshotRevision: snapshot.state.revision, interpretation: f.meaning(m, "EXACT"), businessContext: f.context(m) };
  const first = await commands.apply(input); const revision = f.state().revision;
  const replay = await commands.apply(input); assert.equal(replay.replayed, true); assert.equal(first.appliedRevision, replay.appliedRevision); assert.equal(f.state().revision, revision);
  const next = await f.add("Can I book the strategy consultation?");
  await assert.rejects(commands.apply({ ...input, sourceMessageId: next.id, businessContext: f.context(next), interpretation: f.meaning(next, "EXACT") }), { code: "CONVERSATION_STATE_CONFLICT" });
  await assert.rejects(commands.apply({ ...input, businessContext: { ...f.context(m), demoSessionId: "foreign" } }), { code: "CONVERSATION_STATE_FORBIDDEN" });
  const before = structuredClone(f.state()); f.failProvider(); await assert.rejects(f.run(next, f.meaning(next, "EXACT"), "What day?")); assert.deepEqual(f.state(), before);
  f.fail(); await assert.rejects(commands.apply({ ...input, snapshotRevision: revision, sourceMessageId: next.id, businessContext: f.context(next), interpretation: f.meaning(next, "EXACT") })); assert.deepEqual(f.state(), before);
});

test("workflow adapter and response validation independently guard purpose before schedule", async t => {
  const f = await setup(t, "consultancy"); const m = await f.add("I want to book an appointment");
  const r = await f.run(m, f.meaning(m, "UNSPECIFIED", "ARRANGE_SERVICE", 0, null), "Sure — what do you need help with?");
  const snapshot = await conversationContextService.getSnapshot({ ...f.scoped, messageId: m.id });
  const inspected = await appointmentConversationAdapter.inspect({ businessContext: f.context(m), conversationSnapshot: snapshot, interpretation: r.interpretation });
  assert.equal(inspected.targetField, "serviceNeed"); assert.equal(f.slots.mock.callCount(), 0);
  const context = { ...f.context(m), conversationPlan: r.conversationPlan, conversationSnapshot: snapshot };
  const generated = { ...responseOutput({ userPrompt: f.requests[1].userPrompt }), text: "What day and time would you like?" };
  const validation = conversationResponsePolicyService.validate({ plan: r.conversationPlan, state: snapshot.state, recentMessages: [], facts: responseFacts(context), generatedResponse: generated });
  assert.equal(validation.valid, false); assert.ok(validation.issues.includes("PURPOSE_BEFORE_SCHEDULE"));
});


test("purpose ambiguity preserves supplied details and a later service answer resolves the pending need", async t => {
  const f = await setup(t, "photography", true); const m = await f.add("I need a photographer tomorrow at 2pm"); m.createdAt = new Date("2026-09-22T10:00:00Z");
  const i = f.meaning(m, "AMBIGUOUS"); i.needsClarification = true; i.clarificationReason = "SERVICE_NEED_AMBIGUOUS";
  i.resolvedEntities = [temporal(m, "preferredDate", "2026-09-23"), temporal(m, "preferredTime", "14:00")];
  const first = await f.run(m, i, "Is this for a home, a wedding, or a business shoot?"); await f.save(first);
  assert.equal(f.state().awaiting.field, "serviceNeed"); assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "14:00");
  const next = await f.add("Wedding photography");
  const second = await f.run(next, f.meaning(next, "EXACT", "ARRANGE_SERVICE", 1), "Live availability and appointment booking are not connected in this demo.");
  assert.equal(f.state().knownEntities.serviceId.value, f.services[1]!.id); assert.equal(f.state().awaiting, null);
  assert.equal(second.conversationPlan.targetField, undefined); assert.equal(f.slots.mock.callCount(), 0);
});

test("invalid temporal value rejects the entire purpose batch", async t => {
  const f = await setup(t, "consultancy"); const m = await f.add("Can I book the strategy consultation tomorrow?");
  const i = f.meaning(m, "EXACT"); i.resolvedEntities = [temporal(m, "preferredDate", "2026-02-30")];
  const snapshot = await conversationContextService.getSnapshot({ ...f.scoped, messageId: m.id });
  const result = await commands.apply({ ...f.scoped, sourceMessageId: m.id, snapshotRevision: snapshot.state.revision, interpretation: i, businessContext: f.context(m) });
  assert.equal(result.interpretation.needsClarification, true); assert.equal(result.commands.length, 0);
  assert.deepEqual(f.state().knownEntities, {}); assert.equal(f.state().activeWorkflow, null);
});

test("an established purpose survives a generic booking continuation", async t => {
  const f = await setup(t, "consultancy", true); const m = await f.add("Can I book the strategy consultation?");
  const first = await f.run(m, f.meaning(m, "EXACT"), "What day would you like?"); await f.save(first);
  const next = await f.add("I want an appointment"); const i = f.meaning(next, "UNSPECIFIED", "ARRANGE_SERVICE", 0, null);
  i.workflow = { name: "APPOINTMENT_BOOKING", action: "CONTINUE" };
  const second = await f.run(next, i, "What day would you like?");
  assert.equal(f.state().knownEntities.serviceId.value, f.services[0]!.id); assert.equal(second.conversationPlan.targetField, "preferredDate");
});

test("a removed catalog service requires purpose clarification before scheduling", async t => {
  const f = await setup(t, "consultancy"); await state.setEntity(f.command(), "serviceId", { value: "removed-service" });
  await state.setEntity(f.command(), "serviceNeed", { value: "existing need" });
  const m = await f.add("Can I book?");
  const i: ConversationInterpretation = { intent: "BOOKING_INTENT", confidence: .98, needsClarification: false, resolvedEntities: [] };
  const r = await f.run(m, i, "Could you tell me more about the help you need?");
  assert.equal(r.conversationPlan.targetField, "serviceNeed"); assert.equal(f.slots.mock.callCount(), 0);
});


test("booking after a resolved service inquiry retains purpose without asking for it again", async t => {
  const f = await setup(t, "consultancy", true); const first = await f.add("Do you offer strategy consultation?");
  await f.run(first, f.meaning(first, "EXACT", "INQUIRE_SERVICE"), "Yes, we offer strategy consultation.");
  const originalService = structuredClone(f.state().knownEntities.serviceId);
  const next = await f.add("Can I book an appointment?");
  const r = await f.run(next, f.meaning(next, "UNSPECIFIED", "ARRANGE_SERVICE", 0, null), "What day would you like?");
  assert.equal(f.state().knownEntities.customerGoal.value, "ARRANGE_SERVICE");
  assert.deepEqual(f.state().knownEntities.serviceId, originalService);
  assert.equal(r.conversationPlan.targetField, "preferredDate"); assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
});
