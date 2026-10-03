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

import { appointmentPlanningBackend } from "../src/services/conversation-workflow-planning.service";
import { storeAiReply } from "../src/services/ai-message-store.service";
import { AiBusinessContext } from "../src/services/ai-context-builder.service";
import { CustomerPurpose } from "../src/services/conversation-purpose.schema";
import { ConversationInterpretation } from "../src/services/conversation-interpretation.schema";
import { adaptDemoRuntimeContext } from "../src/services/demo-runtime-context.adapter";
import { emptyDemoFacts } from "../src/services/demo-extraction.service";


import { aiReplyEngine, bookingCompletionPatch, executeAiBookingRequest } from "../src/services/ai-reply-engine.service";
import { appointmentInternalService } from "../src/services/appointment.service";
import { knowledgeRuntimeGovernanceService } from "../src/services/knowledge-document/knowledge-runtime-governance.service";
import { Prisma } from "@prisma/client";
import { AppError } from "../src/utils/errors";
import { env } from "../src/config/env";
import { processDemoReplyForMessage } from "../src/services/demo-ai-processing.service";

const catalogs = {
  clinic: [{ name: "Routine examination", description: "General health examination" }],
  salon: [{ name: "Hair styling", description: "Hair styling appointments" }],
  consultancy: [{ name: "Strategy consultation", description: "Advice on business strategy and planning" }],
  repair: [{ name: "AC Inspection", description: "Diagnose air conditioners that run without cooling" }, { name: "AC Installation", description: "Install new air conditioning units" }, { name: "Preventive Maintenance", description: "Scheduled preventative servicing" }],
  plumbing: [{ name: "Plumbing inspection", description: "Inspect and repair leaking sinks and pipes" }],
  photography: [{ name: "Residential Photography", description: "Photograph homes and properties" }, { name: "Wedding Photography", description: "Photograph weddings" }, { name: "Corporate Photography", description: "Business events and corporate portraits" }],
};
type Catalog = keyof typeof catalogs;
async function setup(t: TestContext, catalog: Catalog, demo = false) {
  const f = fixture(t); if (demo) f.demo();
  const scoped = { ...scope, ...(demo ? { demoSessionId: "demo-a" } : {}) };
  const facts = emptyDemoFacts(); facts.services = catalogs[catalog].map(s => ({ ...s, price: "GHS 150", duration: null })); facts.openingHours = [{day:"Sunday",hours:"10am to 4pm"}]; facts.contacts.address = "East Legon";
  const normalized = await adaptDemoRuntimeContext({ actorType: "DEMO", isDemo: true, businessId: scope.businessId, demoSessionId: "demo-a" }, { businessName: "Fixture business", facts, sourceWebsite: "https://example.com/", crawlStatus: "COMPLETE", extractionStatus: "COMPLETE", startedAt: new Date().toISOString(), completedAt: null, pagesAttempted: 1, pagesFetched: 1, errorCode: null, sources: [], bookingLinks: [], contactLinks: [], unknowns: [] });
  const services = demo ? normalized.services : catalogs[catalog].map((s, i) => ({ ...s, id: `service-${i}`, isBookable: true, durationMinutes: 30, basePrice: 150, currency: "GHS", priceType: "FIXED" as const }));
  const context = (m: any): AiBusinessContext => ({ ...normalized, services, ...scoped, business: { ...normalized.business, timezone: "Africa/Accra" }, readiness: { isAiReady: true, readinessStatus: "READY", completionPercentage: 100, missingItems: [], warnings: [] }, conversation: { id: scope.conversationId, status: "OPEN", channel: demo ? "DEMO" : "WHATSAPP", aiEnabled: !demo }, recentMessages: [], existingCustomerIssues: [], pendingFollowUpContexts: [], lead: null, customerMemory: { leadId: "lead-a", summary: null, activeGoal: null, serviceInterests: [], preferences: [], objections: [], timingStatements: [], missingDetails: [], unresolvedRequests: [], appointmentContext: null, leadContext: {}, lastImportantCustomerAction: null, lastStaffAction: null, humanTakeover: { active: false, aiEnabled: true, needsHumanReview: false }, memoryRevision: 0, memoryEnabled: false, memoryVersion: null }, planCapabilities: { plan: "BASIC", aiReplies: true, teamRouting: false, safeAutoConfirm: false, tone: "PROFESSIONAL" }, triggerMessage: { id: m.id, text: m.content, createdAt: m.createdAt.toISOString() } });
  let next: ConversationInterpretation; let reply = "Sure — what do you need help with?"; let fail = false;
  const requests: any[] = [];
  const interpretation = mockMethod(t, aiProvider, "generateCompletion", async (input: any) => { requests.push(input); if (fail) throw new Error("provider unavailable"); assert.deepEqual(JSON.parse(input.userPrompt).business.services.map((s: any) => s.id), services.map(s => s.id)); return { rawText: JSON.stringify(next), providerRequestCount: 1, provider: "OPENROUTER", model: "test" }; });
  const response = mockMethod(t, aiProvider, "generateReply", async (input: any) => { requests.push(input); return { rawText: JSON.stringify(responseOutput(input, reply)), providerRequestCount: 1, provider: "OPENROUTER", model: "test" }; });
  const slots = mockMethod(t, appointmentPlanningBackend, "checkSlot", async () => { return { available: true, reason: null }; });
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


function side(m: any, intent: ConversationInterpretation["intent"] = "PRICING_INQUIRY"): ConversationInterpretation {
  return { intent, confidence: .98, needsClarification: false, resolvedEntities: [], topicShift: { detected: true, kind: "SIDE_QUESTION", from: "APPOINTMENT", to: "SERVICE_ENQUIRY", evidence: [{messageId:m.id,quote:m.content}] } };
}


// Controlled provider outputs test orchestration, not live model language quality.
const base = (extra: Partial<ConversationInterpretation> = {}): ConversationInterpretation => ({ intent: "BOOKING_INTENT", confidence: .98, needsClarification: false, resolvedEntities: [], ...extra });
const evidence = (m: any) => [{ messageId: m.id, quote: m.content }];
async function begin(t: TestContext, catalog: Catalog, demo = false) {
  const f = await setup(t, catalog, demo);
  const m = await f.add(`I need help with ${f.services[0]!.description}. Can someone help?`);
  const r = await f.run(m, f.meaning(m, "INFERRED"), "What day would work for you?");
  await f.save(r);
  assert.equal(r.conversationPlan.targetField, "preferredDate");
  assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
  assert.equal(f.state().knownEntities.serviceId.value, f.services[0]!.id);
  assert.equal(f.state().awaiting.field, "preferredDate");
  assert.equal(r.providerRequestCount, 2);
  return f;
}
type Harness = Awaited<ReturnType<typeof begin>>;
async function dateTurn(f: Harness) {
  const m = await f.add("Tomorrow"); m.createdAt = new Date("2030-01-01T10:00:00Z");
  const r = await f.run(m, base({ resolvedEntities: [temporal(m, "preferredDate", "2030-01-02")], pendingExpectation: { resolved: true, field: "preferredDate" } }), "What time would work for you?");
  await f.save(r);
  assert.equal(r.conversationPlan.targetField, "preferredTime");
  assert.equal(f.state().knownEntities.preferredDate.normalizedValue, "2030-01-02");
  assert.equal(f.state().awaiting.field, "preferredTime");
  return r;
}
function executionFixture(t: TestContext, f: Harness, status = "CONFIRMED") {
  const appointments: any[] = []; const reservations = new Map<string, any>();
  let failure: string | null = null; let attempts = 0;
  mockMethod(t, prisma.aiInteractionLog, "findUnique", async ({ where }: any) => reservations.get(where.bookingIdempotencyKey) ?? null);
  mockMethod(t, prisma.aiInteractionLog, "create", async ({ data }: any) => {
    if (reservations.has(data.bookingIdempotencyKey)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    const row = { ...data, appointmentId: null }; reservations.set(data.bookingIdempotencyKey, row); return row;
  });
  mockMethod(t, prisma.aiInteractionLog, "updateMany", async ({ where, data }: any) => {
    const row = reservations.get(where.bookingIdempotencyKey);
    if (!row || !Object.entries(where).every(([k, v]) => row[k] === v)) return { count: 0 };
    Object.assign(row, data); return { count: 1 };
  });
  mockMethod(t, prisma.aiInteractionLog, "update", async ({ where, data }: any) => {
    const row = reservations.get(where.bookingIdempotencyKey); Object.assign(row, data); return row;
  });
  mockMethod(t, prisma.appointment, "findFirst", async ({ where }: any) => appointments.find(a => a.id === where.id && a.businessId === where.businessId) ?? null);
  mockMethod(t, prisma.businessMember, "findFirst", async () => ({ id: "owner", userId: "user", role: "BUSINESS_OWNER" }) as any);
  mockMethod(t, knowledgeRuntimeGovernanceService, "assertOperationalFieldSafe", async () => []);
  mockMethod(t, appointmentInternalService, "createAppointmentFromValidatedInput", async (_actor: any, input: any) => {
    assert.equal(f.scoped.demoSessionId, undefined, "Demo cannot enter appointment persistence"); attempts++;
    if (failure) throw new AppError(422, "Synthetic backend failure", failure);
    const appointment = { id: `appointment-${appointments.length}`, businessId: scope.businessId, status, service: { name: f.services[0]!.name }, startTime: new Date("2030-01-02T14:00:00Z"), timezone: "Africa/Accra" };
    appointments.push(appointment);
    // The real appointment adapter owns this atomic receipt write; simulated at its boundary.
    Object.assign(reservations.get(input.bookingIdempotencyKey), { appointmentId: appointment.id, status: "BOOKING_REQUEST_CREATED", bookingRequestCreated: true });
    return appointment;
  });
  const input = (m: any, r: Awaited<ReturnType<Harness["run"]>>) => ({ context: f.context(m), businessAccountId: "account", conversationId: scope.conversationId, leadId: "lead-a", messageId: m.id, decision: r.parsedDecision, conversationPlan: r.conversationPlan });
  return { appointments, reservations, attempts: () => attempts, fail: (code: string | null) => { failure = code; }, input };
}

for (const [catalog, status] of [["consultancy", "CONFIRMED"], ["repair", "PENDING_BUSINESS_CONFIRMATION"], ["salon", "NEEDS_HUMAN_CONFIRMATION"]] as const) test(`matrix: ${catalog} need → date → time → trusted ${status} → replay`, async t => {
  const f = await begin(t, catalog); const db = executionFixture(t, f, status); await dateTurn(f);
  const m = await f.add("2pm");
  const r = await f.run(m, base({ resolvedEntities: [temporal(m, "preferredTime", "14:00")], pendingExpectation: { resolved: true, field: "preferredTime" } }), "I have the details for your request.");
  assert.equal(r.conversationPlan.workflowRequest?.type, "CREATE_BOOKING_REQUEST");
  assert.equal(r.trustedWorkflowResult?.status, "REQUESTED");
  assert.deepEqual(r.trustedWorkflowResult?.claims, []);
  assert.equal(db.appointments.length, 0);
  const input = db.input(m, r); const result = await executeAiBookingRequest(input);
  assert.equal(result.trustedWorkflowResult.status, "SUCCEEDED");
  assert.deepEqual(result.trustedWorkflowResult.claims, status === "CONFIRMED" ? ["APPOINTMENT_CONFIRMED"] : []);
  if (status !== "CONFIRMED") { assert.match(result.replyText, /saved.*review/); assert.doesNotMatch(result.replyText, /is confirmed/); }
  const save = () => prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", content: result.replyText, messageType: "TEXT", deliveryStatus: "INTERNAL" }, "OPEN", {}, { plan: r.conversationPlan, stateChange: { expectedRevision: r.conversationPlan.stateRevision, patch: bookingCompletionPatch(result.trustedWorkflowResult, result.appointment)! } }));
  const stored = await save(); const revision = f.state().revision;
  assert.equal(f.state().workflowStatus, "COMPLETED"); assert.equal(f.state().activeWorkflow, null);
  assert.equal((await executeAiBookingRequest(input)).appointment?.id, result.appointment?.id);
  assert.equal((await save()).id, stored.id); assert.equal(f.state().revision, revision);
  assert.equal(db.attempts(), 1); assert.equal(db.appointments.length, 1);
  assert.equal(f.messages().filter(m => m.senderType === "AI").length, 3);
  assert.equal(f.messages().length, 6);
});

for (const demo of [false, true]) test(`matrix: options → yes → date/time corrections → service switch, demo=${demo}`, async t => {
  const f = await begin(t, "repair", demo); const original = structuredClone(f.state().knownEntities);
  // A workflow supplies choices through the existing state API; no fixture planner replaces the real planner.
  await state.setOptions(f.command(), [{ id: "one", label: "12 PM", value: "12:00", position: 1 }, { id: "two", label: "2 PM", value: "14:00", position: 2 }]);
  await state.setAwaiting(f.command(), { type: "OPTION_SELECTION", field: "preferredTime" });
  let m = await f.add("The second one");
  const option = { ...temporal(m, "preferredTime", "14:00"), source: "REFERENCE_RESOLUTION" as const, reference: { type: "OPTION" as const, optionId: "two" } };
  let r = await f.run(m, base({ selectedOption: { optionId: "two", position: 2, value: "14:00", confidence: .99 }, optionResolution: { basis: "POSITION", candidateOptionIds: ["two"] }, resolvedEntities: [option], pendingExpectation: { resolved: true, field: "preferredTime" } }), "What day works for you?"); await f.save(r);
  assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "14:00"); assert.deepEqual(f.state().offeredOptions, []);
  await state.setAwaiting(f.command(), { type: "CONFIRMATION", question: "Continue with this time?" });
  m = await f.add("yes"); r = await f.run(m, base({ confirmation: { type: "YES", confidence: .99 }, pendingExpectation: { resolved: true } }), "What day works for you?"); await f.save(r);
  assert.equal(r.conversationPlan.targetField, "preferredDate"); assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
  // Keep the workflow in progress: do not execute the complete request while exercising edits.
  await state.setEntity(f.command(), "preferredDate", { value: "2030-01-02", normalizedValue: "2030-01-02", kind: "DATE" });
  m = await f.add("Actually make it Friday"); m.createdAt = new Date("2030-01-01T10:00:00Z");
  const correctedDate = { ...temporal(m, "preferredDate", "2030-01-04"), dateBasis: { type: "DAY_OFFSET" as const, offsetDays: 3 } };
  r = await f.run(m, base({ correction: { isCorrection: true, replacesEntity: "preferredDate" }, resolvedEntities: [correctedDate] }), "I have the updated details."); await f.save(r);
  assert.equal(f.state().knownEntities.preferredDate.normalizedValue, "2030-01-04"); assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "14:00");
  m = await f.add("Make that 4pm instead"); r = await f.run(m, base({ correction: { isCorrection: true, replacesEntity: "preferredTime" }, resolvedEntities: [temporal(m, "preferredTime", "16:00")] }), "I have the updated details."); await f.save(r);
  assert.equal(f.state().knownEntities.preferredTime.normalizedValue, "16:00"); assert.equal(f.state().knownEntities.preferredDate.normalizedValue, "2030-01-04");
  assert.deepEqual(f.state().knownEntities.serviceId, original.serviceId); assert.deepEqual(f.state().knownEntities.customerGoal, original.customerGoal);
  assert.equal(r.conversationPlan.workflowRequest?.preferredTime, "16:00");
  await state.setOptions(f.command(), [{ id: "stale", label: "4 PM", value: "16:00", position: 1 }]);
  m = await f.add("Actually I want AC Installation instead"); const switchMeaning = f.meaning(m, "EXACT", "ARRANGE_SERVICE", 1);
  switchMeaning.topicShift = { detected: true, kind: "NEW_PRIMARY_GOAL", from: "APPOINTMENT", to: "APPOINTMENT", evidence: evidence(m) };
  r = await f.run(m, switchMeaning, "What day would work for you?"); await f.save(r);
  assert.equal(f.state().knownEntities.serviceId.value, f.services[1]!.id); assert.equal(f.state().knownEntities.preferredDate, undefined); assert.equal(f.state().knownEntities.preferredTime, undefined);
  assert.deepEqual(f.state().offeredOptions, []); assert.equal(f.state().offeredOptionsCreatedAt, null);
  assert.equal(f.state().awaiting.field, "preferredDate"); assert.equal(r.conversationPlan.targetField, "preferredDate");
});

for (const demo of [false, true]) test(`matrix: side question → pause → ambiguous return → resume → cancellation, demo=${demo}`, async t => {
  const f = await begin(t, "photography", demo); const purpose = structuredClone(f.state().knownEntities);
  let m = await f.add("How much is it?"); let r = await f.run(m, side(m), "It's GHS 150. What day would work for you?"); await f.save(r);
  assert.equal(r.conversationPlan.move, "ANSWER"); assert.equal(r.conversationPlan.continuation?.field, "preferredDate");
  assert.equal(r.validatedResponse.answerText, "It's GHS 150."); assert.deepEqual(f.state().knownEntities, purpose);
  const pending = structuredClone(f.state().awaiting);
  m = await f.add("Tell me about corporate portraits instead"); const pause = side(m, "SERVICE_INQUIRY"); pause.topicShift!.kind = "NEW_PRIMARY_GOAL";
  pause.workflow = { name: "APPOINTMENT_BOOKING", action: "PAUSE", evidence: evidence(m) };
  r = await f.run(m, pause, "We offer corporate portraits."); await f.save(r);
  assert.equal(f.state().workflowStatus, "PAUSED"); assert.deepEqual(f.state().awaiting, pending); assert.deepEqual(f.state().knownEntities, purpose);
  m = await f.add("continue"); r = await f.run(m, base({ confidence: .4, needsClarification: true }), "Could you clarify what you mean?"); await f.save(r);
  assert.equal(r.conversationPlan.move, "ASK_FOR_CLARIFICATION"); assert.equal(f.state().workflowStatus, "PAUSED"); assert.deepEqual(f.state().awaiting, pending);
  m = await f.add("Let's continue the booking"); r = await f.run(m, base({ workflow: { name: "APPOINTMENT_BOOKING", action: "RESUME", evidence: evidence(m) } }), "What day works for you?"); await f.save(r);
  assert.equal(f.state().workflowStatus, "WAITING_FOR_CUSTOMER"); assert.equal(r.conversationPlan.targetField, "preferredDate");
  await dateTurn(f);
  m = await f.add("Maybe forget it"); r = await f.run(m, base({ intent: "CANCELLATION_INTENT", confidence: .3, needsClarification: true, workflow: { name: "APPOINTMENT_BOOKING", action: "CANCEL", evidence: evidence(m) } }), "Could you clarify what you mean?"); await f.save(r);
  assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
  m = await f.add("Forget the booking"); const cancel = base({ intent: "CANCELLATION_INTENT", workflow: { name: "APPOINTMENT_BOOKING", action: "CANCEL", evidence: evidence(m) } });
  const revision = f.state().revision;
  r = await f.run(m, cancel, "We can leave that booking request here."); const saved = await f.save(r);
  assert.equal(r.conversationPlan.move, "CANCEL_WORKFLOW"); assert.equal(f.state().workflowStatus, "CANCELLED"); assert.equal(f.state().activeWorkflow, null);
  assert.equal(f.state().knownEntities.preferredDate, undefined); assert.equal(f.state().knownEntities.preferredTime, undefined); assert.deepEqual(f.state().offeredOptions, []); assert.equal(f.state().awaiting, null);
  const count = f.messages().length; const committedRevision = f.state().revision;
  const replay = await commands.apply({ ...f.scoped, sourceMessageId: m.id, snapshotRevision: revision, interpretation: cancel, businessContext: f.context(m) });
  assert.equal(replay.replayed, true); assert.equal((await f.save(r)).id, saved.id); assert.equal(f.messages().length, count); assert.equal(f.state().revision, committedRevision);
});

for (const demo of [false, true]) for (const intent of ["HUMAN_REQUEST", "COMPLAINT"] as const) test(`matrix: ${intent} interrupts booking without execution, demo=${demo}`, async t => {
  const f = await begin(t, "clinic", demo); await dateTurn(f); const before = structuredClone(f.state().knownEntities);
  const m = await f.add(intent === "HUMAN_REQUEST" ? "Let me speak to a person" : "I am unhappy with the service");
  const r = await f.run(m, base({ intent }), "I understand you need help from the team."); await f.save(r);
  assert.equal(r.conversationPlan.move, "REQUEST_HUMAN"); assert.equal(r.conversationPlan.workflowRequest, undefined); assert.equal(r.conversationPlan.requiresHumanReview, !demo);
  assert.deepEqual(f.state().knownEntities, before); assert.equal(f.slots.mock.callCount(), 0); assert.equal(f.messages().length, 6);
});

for (const code of ["APPOINTMENT_SLOT_UNAVAILABLE", "BACKEND_FAILURE", "STALE_PLAN"] as const) test(`matrix: collected booking → ${code} → safe persistence/retry`, async t => {
  const f = await begin(t, "consultancy"); const db = executionFixture(t, f); await dateTurn(f);
  const m = await f.add("2pm"); const r = await f.run(m, base({ resolvedEntities: [temporal(m, "preferredTime", "14:00")] }), "I have the details for your request."); const input = db.input(m, r);
  if (code === "STALE_PLAN") {
    await state.setEntity(f.command(), "preferredTime", { value: "16:00", normalizedValue: "16:00", kind: "TIME" });
    const count = f.messages().length;
    await assert.rejects(f.save(r), { code: "CONVERSATION_STATE_CONFLICT" }); await assert.rejects(executeAiBookingRequest(input), { code: "CONVERSATION_STATE_CONFLICT" });
    assert.equal(f.messages().length, count); assert.equal(db.appointments.length, 0); assert.equal(db.attempts(), 0); return;
  }
  db.fail(code); const failed = await executeAiBookingRequest(input);
  assert.equal(failed.trustedWorkflowResult.status, "FAILED"); assert.deepEqual(failed.trustedWorkflowResult.claims, []); assert.equal(bookingCompletionPatch(failed.trustedWorkflowResult, failed.appointment), undefined);
  assert.doesNotMatch(failed.replyText, /is confirmed/); assert.notEqual(f.state().workflowStatus, "COMPLETED"); assert.equal(db.appointments.length, 0);
  assert.equal([...db.reservations.values()][0].appointmentId, null); assert.equal([...db.reservations.values()][0].status, "BOOKING_REQUEST_FAILED");
  if (code === "APPOINTMENT_SLOT_UNAVAILABLE") assert.match(failed.replyText, /other time/);
  db.fail(null); const success = await executeAiBookingRequest(input); assert.equal(success.trustedWorkflowResult.status, "SUCCEEDED"); assert.equal(db.appointments.length, 1);
  assert.equal((await executeAiBookingRequest(input)).appointment?.id, success.appointment?.id); assert.equal(db.appointments.length, 1);
});

for (const catalog of ["consultancy", "repair", "salon"] as const) test(`matrix: demo ${catalog} complete request never books`, async t => {
  const f = await begin(t, catalog, true); const db = executionFixture(t, f); await dateTurn(f);
  const m = await f.add("2pm"); const r = await f.run(m, base({ resolvedEntities: [temporal(m, "preferredTime", "14:00")] }), "I have the details for your request."); await f.save(r);
  assert.equal(r.conversationPlan.workflowRequest?.type, "CHECK_APPOINTMENT_AVAILABILITY");
  const result = await executeAiBookingRequest(db.input(m, r)); assert.equal(result.trustedWorkflowResult.status, "NOT_EXECUTED"); assert.deepEqual(result.trustedWorkflowResult.claims, []);
  assert.equal(db.attempts(), 0); assert.equal(db.appointments.length, 0); assert.equal(f.slots.mock.callCount(), 0); assert.notEqual(f.state().workflowStatus, "COMPLETED");
  assert.doesNotMatch(r.validatedResponse.text!, /is confirmed/); assert.equal(f.messages().length, 6);
});



for (const demo of [false, true]) test(`matrix: paused booking answers pending date; expired options cannot select, demo=${demo}`, async t => {
  const f = await begin(t, "consultancy", demo);
  const purpose = structuredClone(f.state().knownEntities);
  let m = await f.add("Tell me about the business instead"); const pause = side(m, "GENERAL_QUESTION"); pause.topicShift!.kind = "NEW_PRIMARY_GOAL";
  pause.workflow = { name: "APPOINTMENT_BOOKING", action: "PAUSE", evidence: evidence(m) };
  await f.save(await f.run(m, pause, "We offer strategy consultation."));
  m = await f.add("Tomorrow"); m.createdAt = new Date("2030-01-01T10:00:00Z");
  let r = await f.run(m, base({ workflow: { name: "APPOINTMENT_BOOKING", action: "RESUME", evidence: evidence(m) }, resolvedEntities: [temporal(m, "preferredDate", "2030-01-02")] }), "What time works for you?"); await f.save(r);
  assert.equal(f.state().awaiting.field, "preferredTime"); assert.equal(r.conversationPlan.targetField, "preferredTime"); assert.deepEqual(f.state().knownEntities.serviceId, purpose.serviceId);
  await state.setOptions(f.command(), [{ id: "old", label: "2 PM", value: "14:00", position: 1 }]);
  await state.setAwaiting(f.command(), { type: "OPTION_SELECTION", field: "preferredTime" });
  f.state().offeredOptionsCreatedAt = "2000-01-01T00:00:00Z";
  m = await f.add("The first one");
  r = await f.run(m, base({ optionResolution: { basis: "POSITION", candidateOptionIds: ["old"] }, selectedOption: { optionId: "old", value: "14:00", position: 1, confidence: .99 }, resolvedEntities: [{ ...temporal(m, "preferredTime", "14:00"), source: "REFERENCE_RESOLUTION", reference: { type: "OPTION", optionId: "old" } }] }), "Could you clarify what time you mean?"); await f.save(r);
  assert.equal(r.conversationPlan.move, "ASK_FOR_CLARIFICATION"); assert.equal(r.conversationPlan.workflowRequest, undefined); assert.equal(f.state().knownEntities.preferredTime, undefined);
  assert.equal(f.state().knownEntities.preferredDate.normalizedValue, "2030-01-02");
});

for (const demo of [false, true]) test(`matrix: replay through shared runtime retains one persisted reply, demo=${demo}`, async t => {
  const f = await begin(t, "consultancy", demo); const m = await f.add("Tomorrow"); m.createdAt = new Date("2030-01-01T10:00:00Z");
  const meaning = base({ resolvedEntities: [temporal(m, "preferredDate", "2030-01-02")] });
  const first = await f.run(m, meaning, "What time works for you?"); const saved = await f.save(first);
  const revision = f.state().revision; const receipts = f.receipts().length; const interpreterCalls = f.interpretation.mock.callCount();
  await assert.rejects(f.run(m, meaning, "What time works for you?"), { code: "CONVERSATION_STATE_CONFLICT" }); // Raw runtime correctly refuses an older interpretation receipt; entrypoints replay the saved reply below.
  const duplicate = await f.save(first);
  assert.equal(duplicate.id, saved.id); assert.equal(f.state().revision, revision); assert.equal(f.receipts().length, receipts); assert.equal(f.interpretation.mock.callCount(), interpreterCalls);
  assert.equal(f.messages().length, 4); assert.equal(f.state().awaiting.field, "preferredTime");
  const providerCalls = f.requests.length;
  if (demo) {
    const enabled = env.DEMO_ENABLED; env.DEMO_ENABLED = true; t.after(() => { env.DEMO_ENABLED = enabled; });
    // Supply the demo resource/transport columns absent from the generic state fixture.
    Object.assign(m, { leadId: "lead-a", messageType: "TEXT" });
    Object.assign(saved, { provider: "DEMO", providerMessageId: m.id });
    f.tx.demoSession.updateMany = async () => ({ count: 1 });
    f.tx.demoSession.findFirst = async () => ({ setupStatus: "READY" });
    f.tx.conversation.findMany = async () => [{ id: scope.conversationId, businessId: scope.businessId, leadId: "lead-a", channel: "DEMO" }];
    f.tx.lead = { findFirst: async () => ({ id: "lead-a" }) };
    const replay = await processDemoReplyForMessage({ actorType: "DEMO", isDemo: true, ...scope, demoSessionId: "demo-a" }, m.id);
    assert.equal(replay.aiMessage.id, saved.id);
  } else {
    const enabled = env.AI_REPLY_ENABLED; env.AI_REPLY_ENABLED = true; t.after(() => { env.AI_REPLY_ENABLED = enabled; });
    mockMethod(t, prisma.conversation, "findFirst", async () => ({ id: scope.conversationId, businessId: scope.businessId, status: "OPEN", aiEnabled: true, business: { aiRepliesEnabled: true, aiAutoReplyEnabled: true } }) as any);
    mockMethod(t, prisma.message, "findFirst", f.tx.message.findFirst);
    const replay = await aiReplyEngine.processInboundMessageForAi({ ...scope, messageId: m.id, triggeredBy: "WHATSAPP_INBOUND" });
    assert.equal(replay.status, "REPLAYED"); assert.equal(replay.message?.id, saved.id);
  }
  assert.equal(f.requests.length, providerCalls); assert.equal(f.messages().length, 4);
});
