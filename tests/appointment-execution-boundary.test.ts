import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { mockMethod } from "./helpers/mock-method";
import { prisma } from "../src/config/prisma";
import { conversationStateService } from "../src/services/conversation-state.service";
import { bookingCompletionPatch, createAiBookingRequest, executeAiBookingRequest } from "../src/services/ai-reply-engine.service";
import { storeAiReply } from "../src/services/ai-message-store.service";
import { appointmentInternalService } from "../src/services/appointment.service";
import { knowledgeRuntimeGovernanceService } from "../src/services/knowledge-document/knowledge-runtime-governance.service";
import { AppError } from "../src/utils/errors";
import { Prisma } from "@prisma/client";

for (const variant of ["confirmed", "pending", "review", "failure", "slot", "stale", "control", "replay", "post-commit-failure", "demo", "retry-backend", "retry-stale", "retry-control", "concurrent", "retry-concurrent"] as const) test(`trusted booking execution: ${variant}`, async t => {
  const f = fixture(t); await conversationStateService.initialize(scope);
  await conversationStateService.setActiveWorkflow({ ...scope, expectedRevision: f.state().revision, source: "WORKFLOW", sourceEffectId: "booking-start" }, "APPOINTMENT_BOOKING", "APPOINTMENT");
  const m = await f.add("Please book the requested service");
  const appointment: any = { id: "appointment-a", businessId: scope.businessId, status: variant === "pending" ? "PENDING_BUSINESS_CONFIRMATION" : variant === "review" ? "NEEDS_HUMAN_CONFIRMATION" : "CONFIRMED", service: { name: "Consultation" }, startTime: new Date("2030-01-01T14:00:00Z"), timezone: "Africa/Accra" };
  let saved: string | null = null; let creates = 0;
  let reservation: any = null; const transitions: string[] = [];
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const executing = new Promise<void>(resolve => { started = resolve; });
  mockMethod(t, prisma.aiInteractionLog, "findUnique", async () => reservation);
  mockMethod(t, prisma.aiInteractionLog, "create", async ({ data }: any) => {
    if (reservation) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    reservation = { ...data, appointmentId: null }; transitions.push(data.status); return reservation;
  });
  mockMethod(t, prisma.aiInteractionLog, "updateMany", async ({ where, data }: any) => {
    assert.equal(where.appointmentId, null); assert.equal(where.businessId, scope.businessId); assert.equal(where.messageId, m.id);
    if (!reservation || !Object.entries(where).every(([key, value]) => reservation[key] === value)) return { count: 0 };
    Object.assign(reservation, data); transitions.push(data.status); return { count: 1 };
  });
  mockMethod(t, prisma.aiInteractionLog, "update", async ({ data }: any) => { Object.assign(reservation, data); return reservation; });
  mockMethod(t, prisma.appointment, "findFirst", async ({ where }: any) => { assert.equal(where.businessId, scope.businessId); return saved ? appointment : null; });
  mockMethod(t, prisma.businessMember, "findFirst", async () => ({ id: "owner", userId: "user", role: "BUSINESS_OWNER" }) as any);
  mockMethod(t, knowledgeRuntimeGovernanceService, "assertOperationalFieldSafe", async () => []);
  mockMethod(t, appointmentInternalService, "createAppointmentFromValidatedInput", async (_actor: any, input: any) => {
    creates++; assert.ok(input.bookingIdempotencyKey); assert.equal(input.conversationPlan.sourceMessageId, m.id);
    if (variant.startsWith("retry-") && creates === 1) throw variant === "retry-stale" || variant === "retry-control"
      ? new AppError(409, "changed inside appointment transaction", variant === "retry-stale" ? "CONVERSATION_STATE_CONFLICT" : "CONVERSATION_PLAN_CONTROL_CHANGED") : new Error("first attempt failed before commit");
    if (variant === "concurrent" || variant === "retry-concurrent") { started(); await gate; }
    if (variant === "failure") throw new Error("backend failed");
    if (variant === "slot") throw new AppError(422, "slot unavailable", "APPOINTMENT_SLOT_UNAVAILABLE");
    saved = appointment.id; // Simulate the receipt committed in the appointment transaction.
    Object.assign(reservation, { appointmentId: saved, status: "BOOKING_REQUEST_CREATED", bookingRequestCreated: true });
    if (variant === "post-commit-failure") throw new Error("notification failed after commit");
    return appointment;
  });
  const input: any = { ...scope, businessAccountId: "account", leadId: "lead-a", messageId: m.id,
    context: { business: { id: scope.businessId, timezone: "Africa/Accra" }, services: [{ id: "service-a", name: "Consultation", isBookable: true, durationMinutes: 30 }] },
    decision: { suggestedAction: "CREATE_BOOKING_REQUEST", intent: "BOOKING_INTENT", confidence: .99, appointmentIntent: { serviceId: "service-a", preferredDate: "2030-01-01", preferredTime: "14:00", timezone: "Africa/Accra", missingFields: [] } },
    conversationPlan: { version: 1, ...scope, sourceMessageId: m.id, move: "CONTINUE_WORKFLOW", intent: "BOOKING_INTENT", workflow: "APPOINTMENT_BOOKING", reasonCode: "READY", missingFields: [], knownFields: [], responseDirective: { purpose: "ACKNOWLEDGE", acknowledgeContext: true, askOneQuestion: false }, confidence: .99, requiresHumanReview: false, stateRevision: f.state().revision, workflowRequest: { type: "CREATE_BOOKING_REQUEST", serviceId: "service-a", preferredDate: "2030-01-01", preferredTime: "14:00", timezone: "Africa/Accra" } } };
  if (variant === "stale") await conversationStateService.setEntity({ ...scope, expectedRevision: f.state().revision, source: "STAFF", sourceEffectId: "newer-edit" }, "preferredTime", { kind: "TIME", value: "16:00", normalizedValue: "16:00" });
  if (variant === "control") f.human();
  if (variant === "demo") input.context.demoSessionId = "demo-a";
  if (variant === "stale" || variant === "control") {
    await assert.rejects(executeAiBookingRequest(input), { code: variant === "stale" ? "CONVERSATION_STATE_CONFLICT" : "CONVERSATION_PLAN_CONTROL_CHANGED" }); assert.equal(creates, 0); return;
  }
  if (variant.startsWith("retry-")) {
    const code = variant === "retry-stale" ? "CONVERSATION_STATE_CONFLICT" : variant === "retry-control" ? "CONVERSATION_PLAN_CONTROL_CHANGED" : undefined;
    if (code) await assert.rejects(executeAiBookingRequest(input), { code });
    else assert.equal((await executeAiBookingRequest(input)).trustedWorkflowResult.status, "FAILED");
    assert.equal(reservation.status, "BOOKING_REQUEST_FAILED"); assert.equal(reservation.appointmentId, null); assert.equal(saved, null);
  }
  if (variant === "concurrent" || variant === "retry-concurrent") {
    const live = executeAiBookingRequest(input); await executing;
    try {
      await assert.rejects(executeAiBookingRequest(input), { code: "AI_BOOKING_REQUEST_IN_PROGRESS" });
      assert.equal(reservation.status, "BOOKING_REQUEST_IN_PROGRESS"); assert.equal(saved, null);
    } finally { release(); }
    const result = await live; assert.equal(result.appointment?.id, appointment.id);
    assert.equal((await executeAiBookingRequest(input)).appointment?.id, appointment.id);
    assert.equal(creates, variant === "concurrent" ? 1 : 2); return;
  }
  const r = await executeAiBookingRequest(input);
  if (variant.startsWith("retry-")) {
    assert.equal(r.appointment?.id, appointment.id); assert.equal(creates, 2);
    assert.deepEqual(transitions, ["BOOKING_REQUEST_IN_PROGRESS", "BOOKING_REQUEST_FAILED", "BOOKING_REQUEST_IN_PROGRESS"]);
    const committed = structuredClone(reservation);
    assert.equal((await executeAiBookingRequest(input)).appointment?.id, appointment.id); assert.equal(creates, 2); assert.deepEqual(reservation, committed);
  }
  const failed = variant === "failure" || variant === "slot";
  assert.equal(r.trustedWorkflowResult.status, variant === "demo" ? "NOT_EXECUTED" : failed ? "FAILED" : "SUCCEEDED");
  assert.deepEqual(r.trustedWorkflowResult.claims, variant === "demo" || failed || variant === "review" || variant === "pending" ? [] : ["APPOINTMENT_CONFIRMED"]);
  if (variant === "review" || variant === "pending") assert.match(r.replyText, /saved.*review/);
  if (variant === "slot") assert.match(r.replyText, /no longer available.*other time/);
  if (failed || variant === "review" || variant === "pending" || variant === "demo") assert.doesNotMatch(r.replyText, /is confirmed/);
  if (variant === "replay" || variant === "post-commit-failure") { const replay = await executeAiBookingRequest(input); assert.equal(replay.appointment?.id, r.appointment?.id); assert.equal(creates, 1); }
  if (variant === "post-commit-failure") { assert.equal(reservation.status, "BOOKING_REQUEST_CREATED"); assert.equal(reservation.appointmentId, appointment.id); assert.ok(!transitions.includes("BOOKING_REQUEST_FAILED")); }
  if (variant === "demo") { assert.equal(creates, 0); await assert.rejects(createAiBookingRequest(input), { code: "DEMO_PRODUCTION_EFFECT_FORBIDDEN" }); }
  const patch = bookingCompletionPatch(r.trustedWorkflowResult, r.appointment);
  if (failed || variant === "demo") { assert.equal(patch, undefined); assert.equal(f.state().workflowStatus, "ACTIVE"); }
  else {
    await prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", content: r.replyText, messageType: "TEXT", deliveryStatus: "INTERNAL" }, "OPEN", {}, { plan: input.conversationPlan, stateChange: { expectedRevision: input.conversationPlan.stateRevision, patch: patch! } }));
    assert.equal(f.state().workflowStatus, "COMPLETED");
  }
});
