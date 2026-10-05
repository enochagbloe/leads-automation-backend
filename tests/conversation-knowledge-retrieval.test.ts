import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationKnowledgeRetrievalService as adapter, buildConversationKnowledgeQuery as query } from "../src/services/conversation-knowledge-retrieval.service";
import { knowledgeRetrievalService } from "../src/services/knowledge-retrieval.service";
import type { KnowledgeGrounding } from "../src/services/knowledge-retrieval.service";
import { emptyState } from "../src/services/conversation-state.schema";
import { mockMethod } from "./helpers/mock-method";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { aiProvider } from "../src/services/ai-provider.service";
import { conversationPlannerService } from "../src/services/conversation-planner.service";
import { conversationResponseService } from "../src/services/conversation-response.service";
import { responseOutput } from "./helpers/response-output";
import { generateContextReply } from "../src/services/ai-reply-runtime.service";
import type { AiBusinessContext } from "../src/services/ai-context-builder.service";

type Input = Parameters<typeof adapter.retrieve>[0];
function input(message = "how much?"): Input {
  const state: Input["snapshot"]["state"] = { ...emptyState(), ...scope, id: "state", revision: 3, createdAt: new Date(), updatedAt: new Date(), lastActivityAt: new Date(), activeTopic: "APPOINTMENT", activeWorkflow: "APPOINTMENT_BOOKING", workflowStatus: "WAITING_FOR_CUSTOMER", awaiting: { type: "FIELD", field: "preferredDate" }, lastAssistantQuestion: "What day works for the consultation?", knownEntities: { serviceId: { kind: "TEXT", value: "service-a" }, reason: { kind: "TEXT", value: "review the growth strategy" } } };
  const context = {
    business: { id: scope.businessId, name: "Fixture" }, conversation: { id: scope.conversationId, status: "AI_HANDLING", aiEnabled: true }, triggerMessage: { id: "current", text: message, createdAt: "2026-10-04T12:00:00Z" },
    services: [{ id: "service-a", name: "Strategy consultation", basePrice: 150, currency: "GHS", priceType: "FIXED" }, { id: "service-b", name: "Team training" }], policies: [{ id: "policy", title: "Payment", content: "Payment is due at the visit." }],
    knowledgeArticles: [{ id: "broad", title: "BROAD PRIVATE FIXTURE", body: "OLD ARTICLE DUMP", tags: [] }], knowledgeDocumentChunks: [{ id: "old-chunk", documentId: "old-document", documentTitle: "Old", chunkText: "OLD CHUNK DUMP" }], approvedKnowledgeFacts: [{ id: "old-fact", valueText: "OLD FACT DUMP" }], runtimeKnowledgeGuards: [{ reviewItemId: "guard", canonicalEntityType: "SERVICE", canonicalEntityId: "guarded-service", canonicalField: "basePrice", priority: "HIGH" }],
    customerMemory: { summary: null }, planCapabilities: { aiReplies: true, tone: "PROFESSIONAL" }, recentMessages: [], existingCustomerIssues: [], pendingFollowUpContexts: [],
  } as unknown as AiBusinessContext;
  return { businessId: scope.businessId, context, interpretation: { intent: "PRICING_INQUIRY", confidence: .98, needsClarification: false, resolvedEntities: [] }, snapshot: { state, currentMessage: { id: "current", text: message, senderType: "CUSTOMER", createdAt: context.triggerMessage.createdAt }, recentMessages: [{ id: "earlier", text: "I need a strategy consultation", senderType: "CUSTOMER", direction: "INBOUND", createdAt: "2026-10-04T11:59:00Z" }], timezone: "Africa/Accra", customerMemorySummary: null } as Input["snapshot"] };
}
const grounding = (id: string, text = `Useful confirmed information ${id}`, title = `Guide ${id}`, sourceType: KnowledgeGrounding["sourceType"] = "ARTICLE"): KnowledgeGrounding => ({ sourceId: id, sourceType, title, text, pageNumber: 2, score: .9, retrieval: "semantic", ...(sourceType === "DOCUMENT_FACT" ? { factId: `fact-${id}` } : sourceType === "DOCUMENT_CHUNK" ? { chunkId: `chunk-${id}` } : {}) });

for (const [message, intent, expected] of [
  ["boss i want talk to somebody", "HUMAN_REQUEST", /human representative customer support/],
  ["please connect me to one of your people", "HUMAN_REQUEST", /human representative/],
  ["if i no come what happens to my money?", "PAYMENT_QUESTION", /refund cancellation policy/],
  ["i paid already but i want cancel", "CANCELLATION_INTENT", /cancellation refund payment/],
  ["something happened and i want report am", "COMPLAINT", /complaint report problem/],
] as const) test(`${intent}: deterministic query preserves noisy current message`, () => {
  const i = input(message); i.interpretation.intent = intent;
  const result = query(i); assert.ok(result.includes(message)); assert.match(result, expected);
  if (["HUMAN_REQUEST", "COMPLAINT"].includes(intent)) assert.doesNotMatch(result, /growth strategy|APPOINTMENT_BOOKING/);
});

for (const message of ["how much?", "the other one"]) test(`short ${message} uses topical service context without booking fields`, () => {
  const i = input(message); const result = query(i);
  assert.match(result, /Strategy consultation/); assert.match(result, /growth strategy/); assert.doesNotMatch(result, /preferredDate|APPOINTMENT_BOOKING/);
});

test("payment gets policy context without dragging unrelated booking history", () => {
  const i = input("payment"); i.interpretation.intent = "PAYMENT_QUESTION";
  assert.match(query(i), /payment policy/); assert.match(query(i), /Strategy consultation/); assert.doesNotMatch(query(i), /preferredDate|APPOINTMENT_BOOKING/);
});

test("current need and resolved service are used; stale unrelated workflow is excluded", () => {
  const i = input("How much is team training?");
  i.interpretation.customerPurpose = { goal: "INQUIRE_SERVICE", need: "training the team", serviceId: "service-b", resolution: "EXACT", candidateServiceIds: [], confidence: .99, evidence: [{ messageId: "current", quote: "team training" }], catalogEvidence: [] };
  const result = query(i); assert.match(result, /training the team|Team training/); assert.doesNotMatch(result, /growth strategy|Strategy consultation|preferredDate/);
  i.interpretation.intent = "GENERAL_QUESTION"; i.interpretation.customerPurpose = undefined;
  assert.doesNotMatch(query(i), /APPOINTMENT_BOOKING|growth strategy/);
});

test("new primary goal, stale lifecycle and uncertain meaning do not inherit old workflow", () => {
  for (const variant of ["new-goal", "completed", "uncertain"]) {
    const i = input("Tell me something different");
    if (variant === "new-goal") i.interpretation.topicShift = { detected: true, kind: "NEW_PRIMARY_GOAL" };
    if (variant === "completed") i.snapshot.state.workflowStatus = "COMPLETED";
    if (variant === "uncertain") i.interpretation.needsClarification = true;
    assert.doesNotMatch(query(i), /growth strategy|Strategy consultation|preferredDate/);
  }
});

test("query is bounded and history is limited to two messages", () => {
  const i = input("x".repeat(8000)); i.snapshot.recentMessages = Array.from({ length: 10 }, (_, n) => ({ id: `m${n}`, text: `history${n} ` + "z".repeat(1000), createdAt: "2026-10-04T11:59:00Z", senderType: "CUSTOMER", direction: "INBOUND" }));
  const result = query(i); assert.ok(result.length <= 2000); assert.doesNotMatch(result, /history0/); assert.doesNotMatch(result, /history8/);
});

test("one scoped retrieval call deduplicates title/text and caps at four groundings", async t => {
  const i = input(); const before = structuredClone(i.context);
  const spy = mockMethod(t, knowledgeRetrievalService, "retrieve", async (request: any) => {
    assert.equal(request.businessId, scope.businessId); assert.equal(request.topK, 8); assert.match(request.query, /how much\?/);
    return { status: "MATCHES_FOUND", matches: [grounding("a", "Confirmed opening hours.", "Guide"), grounding("b", "CONFIRMED opening hours!", "guide"), ...Array.from({ length: 6 }, (_, n) => grounding(`distinct${n}`))] };
  });
  const result = await adapter.retrieve(i); assert.equal(result.knowledgeArticles.length, 4); assert.equal(spy.mock.callCount(), 1);
  assert.equal(result.knowledgeArticles[0]!.id, "a"); assert.ok(!result.knowledgeArticles.some(a => a.id === "b")); assert.deepEqual(result.approvedKnowledgeFacts, []);
  assert.deepEqual(i.context, before); assert.deepEqual({ ...i.context, ...result }.services, before.services); assert.deepEqual({ ...i.context, ...result }.policies, before.policies);
  assert.deepEqual({ ...i.context, ...result }.runtimeKnowledgeGuards, before.runtimeKnowledgeGuards);
});

test("facts and chunks become bounded text, never structured operational permissions", async t => {
  const i = input(); mockMethod(t, knowledgeRetrievalService, "retrieve", async () => ({ status: "MATCHES_FOUND", matches: [grounding("d", "v".repeat(1100), "Fact", "DOCUMENT_FACT"), grounding("c", "Safe text", "Chunk", "DOCUMENT_CHUNK")] }));
  const result = await adapter.retrieve(i); assert.equal(result.knowledgeDocumentChunks.length, 2); assert.equal(result.knowledgeDocumentChunks[0]!.chunkText.length, 900); assert.equal(result.knowledgeDocumentChunks[0]!.id, "fact-d"); assert.deepEqual(result.approvedKnowledgeFacts, []);
});

for (const status of ["NO_RELEVANT_KNOWLEDGE", "RETRIEVAL_UNAVAILABLE", "throws"]) test(`${status}: broad knowledge is cleared, structured business data survives`, async t => {
  const i = input(); const logs: any[] = []; mockMethod(t, console, "info", (...args: any[]) => { logs.push(args); });
  mockMethod(t, knowledgeRetrievalService, "retrieve", async () => { if (status === "throws") throw new Error("provider failed"); return { status, matches: [] }; });
  const result = { ...i.context, ...await adapter.retrieve(i) };
  assert.deepEqual(result.knowledgeArticles, []); assert.deepEqual(result.knowledgeDocumentChunks, []); assert.deepEqual(result.approvedKnowledgeFacts, []);
  assert.equal(result.services, i.context.services); assert.equal(result.policies, i.context.policies); assert.equal(result.runtimeKnowledgeGuards, i.context.runtimeKnowledgeGuards);
  assert.equal(logs[0][1].status, status === "throws" ? "RETRIEVAL_UNAVAILABLE" : status); assert.ok(!JSON.stringify(logs).includes("how much"));
});

test("scope mismatch fails before retrieval; demo preserves existing website knowledge", async t => {
  const spy = mockMethod(t, knowledgeRetrievalService, "retrieve", async () => { throw new Error("must not call"); });
  const wrong = input(); wrong.businessId = "foreign"; await assert.rejects(adapter.retrieve(wrong), { code: "CONVERSATION_KNOWLEDGE_SCOPE_MISMATCH" });
  const demo = input(); demo.context.demoSessionId = "demo-a"; const result = await adapter.retrieve(demo);
  assert.equal(result.knowledgeArticles, demo.context.knowledgeArticles); assert.equal(result.knowledgeDocumentChunks, demo.context.knowledgeDocumentChunks); assert.equal(result.approvedKnowledgeFacts, demo.context.approvedKnowledgeFacts); assert.equal(spy.mock.callCount(), 0);
});

for (const status of ["MATCHES_FOUND", "NO_RELEVANT_KNOWLEDGE", "RETRIEVAL_UNAVAILABLE"] as const) test(`real runtime orders interpretation → retrieval → unchanged planner → bounded response: ${status}`, async t => {
  const f = fixture(t); const m = await f.add("Tell me about your support policy"); const i = input(m.content); i.context.triggerMessage = { id: m.id, text: m.content, createdAt: m.createdAt.toISOString() };
  const events: string[] = [];
  mockMethod(t, aiProvider, "generateCompletion", async () => { events.push("interpret"); return { rawText: JSON.stringify({ intent: "GENERAL_QUESTION", confidence: .99, needsClarification: false, resolvedEntities: [] }), provider: "OPENROUTER", model: "test", providerRequestCount: 1 }; });
  mockMethod(t, knowledgeRetrievalService, "retrieve", async (request: any) => { events.push("retrieve"); assert.equal(request.businessId, scope.businessId); return { status, matches: status === "MATCHES_FOUND" ? [grounding("support", "Our team can help.")] : [] }; });
  const plan = conversationPlannerService.plan.bind(conversationPlannerService);
  mockMethod(t, conversationPlannerService, "plan", async (args: any) => { events.push("plan"); assert.equal(args.businessContext, i.context); assert.equal(args.interpretation.intent, "GENERAL_QUESTION"); return plan(args); });
  const respond = conversationResponseService.generate.bind(conversationResponseService);
  mockMethod(t, conversationResponseService, "generate", async (context: any, options: any) => {
    events.push("respond"); assert.equal(context.services, i.context.services); assert.equal(context.policies, i.context.policies); assert.equal(context.runtimeKnowledgeGuards, i.context.runtimeKnowledgeGuards);
    assert.equal(context.knowledgeArticles.length, status === "MATCHES_FOUND" ? 1 : 0); assert.deepEqual(context.approvedKnowledgeFacts, []); assert.deepEqual(context.knowledgeDocumentChunks, []);
    return respond(context, options);
  });
  mockMethod(t, aiProvider, "generateReply", async (request: any) => { assert.doesNotMatch(request.userPrompt, /OLD ARTICLE DUMP|OLD CHUNK DUMP|OLD FACT DUMP/); return { rawText: JSON.stringify(responseOutput(request, "I can help with your question.")), provider: "OPENROUTER", model: "test", providerRequestCount: 1 }; });
  const result = await generateContextReply(i.context, { ...scope, messageId: m.id });
  if (status !== "MATCHES_FOUND") {
    assert.match(result.parsedDecision!.replyText!, /don.t have confirmed information/);
    assert.equal(result.parsedDecision!.requiresHumanReview, false);
  }
  assert.deepEqual(events, ["interpret", "retrieve", "plan", "respond"]); assert.equal(result.providerRequestCount, status === "MATCHES_FOUND" ? 2 : 1); assert.equal(result.conversationPlan.move, "ANSWER"); assert.equal(result.conversationPlan.workflowRequest, undefined); assert.equal(result.conversationPlan.requiresHumanReview, false); assert.equal(result.parsedDecision!.suggestedAction, "SEND_REPLY");
});

test("near-identical editorial copies collapse without discarding different numeric claims", async t => {
  const i = input(); const paragraph = "Customers can contact our support team during normal business hours for helpful information about the available services and the general process for making a request";
  mockMethod(t, knowledgeRetrievalService, "retrieve", async () => ({ status: "MATCHES_FOUND", matches: [grounding("a", paragraph, "Support"), grounding("b", paragraph + " please", "Support"), grounding("c", paragraph + " 100", "Support"), grounding("d", paragraph + " 200", "Support")] }));
  const result = await adapter.retrieve(i); assert.deepEqual(result.knowledgeArticles.map(a => a.id), ["a", "c", "d"]);
});

for (const [message, intent] of [["payment", "PAYMENT_QUESTION"], ["cash?", "PAYMENT_QUESTION"], ["momo?", "PAYMENT_QUESTION"], ["how much?", "PRICING_INQUIRY"], ["what if i cancel?", "CANCELLATION_INTENT"], ["the other one", "SERVICE_INQUIRY"]] as const) test(`topical follow-up ${message} retains photography but no operational state`, () => {
  const i = input(message); i.interpretation.intent = intent; i.interpretation.topic = intent === "PAYMENT_QUESTION" ? "PAYMENT" : undefined;
  i.snapshot.state.knownEntities = { serviceNeed: { kind: "TEXT", value: "photography" }, preferredDate: { kind: "DATE", value: "tomorrow", normalizedValue: "2026-10-05" }, preferredTime: { kind: "TIME", value: "2pm", normalizedValue: "14:00" }, location: { kind: "TEXT", value: "Old Location" } };
  i.snapshot.state.offeredOptions = [{ id: "old", label: "Old option", value: "14:00", position: 1 }];
  i.snapshot.state.lastAssistantQuestion = "What date and time at Old Location?";
  const result = query(i); assert.match(result, /photography/); assert.doesNotMatch(result, /preferredDate|preferredTime|tomorrow|2026-10-05|14:00|2pm|Old Location|Old option|APPOINTMENT_BOOKING|What date/);
  if (intent === "PAYMENT_QUESTION") assert.match(result, /payment policy/);
});

test("history-only topical anchor supports payment without copying the assistant question", () => {
  const i = input("payment"); i.interpretation.intent = "PAYMENT_QUESTION"; i.snapshot.state.knownEntities = {};
  i.snapshot.recentMessages = [
    { id: "customer", text: "I want to know about photography", senderType: "CUSTOMER", direction: "INBOUND", createdAt: "2026-10-04T11:58:00Z" },
    { id: "assistant", text: "What would you like to know?", senderType: "AI", direction: "OUTBOUND", createdAt: "2026-10-04T11:59:00Z" },
  ];
  assert.match(query(i), /photography/); assert.doesNotMatch(query(i), /What would you like/);
});

for (const variant of ["unrelated", "new-goal", "paused", "ambiguous", "stale", "foreign"] as const) test(`${variant} cannot inherit the previous topical anchor`, () => {
  const i = input(variant === "unrelated" ? "where can i buy sneakers?" : "payment"); i.interpretation.intent = variant === "unrelated" ? "GENERAL_QUESTION" : "PAYMENT_QUESTION";
  i.snapshot.state.knownEntities.serviceNeed = { kind: "TEXT", value: "photography" };
  if (variant === "new-goal") i.interpretation.topicShift = { detected: true, kind: "NEW_PRIMARY_GOAL" };
  if (variant === "paused") { i.snapshot.state.workflowStatus = "PAUSED"; i.interpretation.workflow = { name: "APPOINTMENT_BOOKING", action: "RESUME" }; }
  if (variant === "ambiguous") i.interpretation.needsClarification = true;
  if (variant === "stale") { i.snapshot.state.lastActivityAt = new Date("2020-01-01"); i.snapshot.recentMessages = []; }
  if (variant === "foreign") i.snapshot.state.conversationId = "another-conversation";
  assert.doesNotMatch(query(i), /photography|Strategy consultation|growth strategy|preferredDate/);
});

test("history fallback excludes known location and scheduling messages", () => {
  const i = input("payment"); i.interpretation.intent = "PAYMENT_QUESTION"; i.snapshot.state.knownEntities = { location: { kind: "TEXT", value: "Old Location" } };
  i.snapshot.recentMessages = [
    { id: "one", text: "At Old Location", senderType: "CUSTOMER", direction: "INBOUND", createdAt: "2026-10-04T11:58:00Z" },
    { id: "two", text: "At 14:00", senderType: "CUSTOMER", direction: "INBOUND", createdAt: "2026-10-04T11:59:00Z" },
  ];
  assert.doesNotMatch(query(i), /Old Location|14:00/);
});

test("new primary goal cannot carry old interpreter context entities into retrieval", () => {
  const i = input("where can i buy sneakers?"); i.interpretation.intent = "GENERAL_QUESTION";
  i.interpretation.topicShift = { detected: true, kind: "NEW_PRIMARY_GOAL" };
  i.interpretation.resolvedEntities = [{ key: "serviceNeed", kind: "TEXT", value: "photography", source: "CONVERSATION_CONTEXT", confidence: .99, certainty: "EXACT", evidence: [{ messageId: "earlier", quote: "photography" }] }];
  assert.doesNotMatch(query(i), /photography|Strategy consultation/);
});

for (const variant of ["current", "paused", "ambiguous", "new-goal", "stale", "noncatalog", "foreign"]) test(`retrieval hint requires validated current service: ${variant}`, async t => {
  const i = input("payment"); i.interpretation.intent = "PAYMENT_QUESTION";
  if (variant === "paused") i.snapshot.state.workflowStatus = "PAUSED";
  if (variant === "ambiguous") i.interpretation.needsClarification = true;
  if (variant === "new-goal") i.interpretation.topicShift = { detected: true, kind: "NEW_PRIMARY_GOAL" } as any;
  if (variant === "stale") { i.snapshot.recentMessages = []; i.snapshot.state.lastActivityAt = new Date(0); }
  if (variant === "noncatalog") i.snapshot.state.knownEntities.serviceId!.value = "foreign-service";
  if (variant === "foreign") i.snapshot.state.businessId = "foreign";
  let calls = 0;
  mockMethod(t, knowledgeRetrievalService, "retrieve", async (request: any) => {
    calls++; assert.equal(request.businessId, scope.businessId);
    assert.deepEqual(request.hints, variant === "current" ? { serviceId: "service-a" } : undefined);
    return { status: "NO_RELEVANT_KNOWLEDGE", matches: [] };
  });
  if (variant === "foreign") { await assert.rejects(adapter.retrieve(i), { code: "CONVERSATION_KNOWLEDGE_SCOPE_MISMATCH" }); assert.equal(calls, 0); }
  else { await adapter.retrieve(i); assert.equal(calls, 1); }
});

test("changed catalog service passes only the newly resolved current-message hint", async t => {
  const i = input("How much is team training?");
  i.interpretation.resolvedEntities = [{ key: "serviceId", value: "service-b", kind: "TEXT", confidence: .99, source: "CURRENT_MESSAGE", certainty: "EXACT", evidence: [{ messageId: "current", quote: "team training" }] }];
  mockMethod(t, knowledgeRetrievalService, "retrieve", async (request: any) => {
    assert.deepEqual(request.hints, { serviceId: "service-b" });
    assert.doesNotMatch(request.query, /Strategy consultation|growth strategy/);
    return { status: "NO_RELEVANT_KNOWLEDGE", matches: [] };
  });
  await adapter.retrieve(i);
});
test("explicit unrelated question carries no old service hint", async t => {
  const i = input("Where can I buy sneakers?"); i.interpretation.intent = "GENERAL_INQUIRY" as any;
  mockMethod(t, knowledgeRetrievalService, "retrieve", async (request: any) => {
    assert.equal(request.hints, undefined);
    return { status: "NO_RELEVANT_KNOWLEDGE", matches: [] };
  });
  await adapter.retrieve(i);
});
