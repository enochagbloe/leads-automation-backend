import { servicePurpose } from "./helpers/customer-purpose";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, scope } from "./helpers/conversation-state-fixture";
import { mockMethod } from "./helpers/mock-method";
import { responseOutput } from "./helpers/response-output";
import { prisma } from "../src/config/prisma";
import { aiProvider } from "../src/services/ai-provider.service";
import { buildDemoBusinessContext } from "../src/services/demo-business-context.provider";
import { adaptDemoRuntimeContext, demoContextId } from "../src/services/demo-runtime-context.adapter";
import { DemoContext } from "../src/services/demo-context.service";
import { DemoActor } from "../src/services/demo.service";
import { emptyDemoFacts } from "../src/services/demo-extraction.service";
import { generateContextReply } from "../src/services/ai-reply-runtime.service";
import { ConversationRuntimeTiming } from "../src/services/conversation-runtime-timing";
import { appointmentPlanningBackend } from "../src/services/conversation-workflow-planning.service";
import { storeAiReply } from "../src/services/ai-message-store.service";
import { aiSafetyService } from "../src/services/ai-safety.service";
import { offsetLocalDate } from "../src/services/conversation-interpretation.schema";

const actor: DemoActor = { actorType: "DEMO", isDemo: true, businessId: scope.businessId, demoSessionId: "demo-a" };
const websiteContext = (name = "Example company"): DemoContext => ({ businessName: name, facts: emptyDemoFacts(), sourceWebsite: "https://example.com/", crawlStatus: "COMPLETE", extractionStatus: "COMPLETE", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), pagesAttempted: 1, pagesFetched: 1, errorCode: null, sources: [], bookingLinks: [], contactLinks: [], unknowns: [] });
const service = (name: string, price: string | null = null) => ({ name, price, duration: null, description: null });

test("adapter preserves confirmed text, unknown settings, contacts, policies, FAQs and scoped stable IDs", async () => {
  const c = websiteContext();
  c.facts.services = [{ ...service("Strategy consultation", "From USD 100"), duration: "About an hour" }];
  c.facts.openingHours = [{ day: "Weekdays", hours: "By appointment after lunch" }];
  c.facts.contacts = { phone: "+233200000000", email: "hello@example.com", address: "Main Street" };
  c.facts.locations = ["North office", "City office"];
  c.facts.policies = ["Please give 24 hours notice for cancellations."];
  c.facts.faqs = [{ question: "Do you offer remote meetings?", answer: "Yes, remote meetings are offered." }];
  const a = await adaptDemoRuntimeContext(actor, c);
  assert.deepEqual(a, await adaptDemoRuntimeContext(actor, c));
  assert.notEqual(a.services[0]!.id, (await adaptDemoRuntimeContext({ ...actor, demoSessionId: "demo-b" }, c)).services[0]!.id);
  assert.notEqual(demoContextId(actor, "service", "same"), demoContextId({ ...actor, businessId: "other" }, "service", "same"));
  const s = a.services[0]!;
  for (const key of ["isBookable", "capacityMode", "autoConfirmEligible", "requiredStaffRole", "allowedLocationTypes", "requiresStaffAssignmentBeforeConfirmation", "requiresLocationBeforeConfirmation", "requiresManualApproval", "requiresManagerApproval", "allowAiToChooseLocationType", "requiredSkillTags", "basePrice", "currency", "durationMinutes"]) assert.equal(s[key as keyof typeof s], undefined, key);
  assert.equal(s.priceDescription, "From USD 100"); assert.equal(s.durationText, "About an hour");
  assert.equal(a.availability!.timezone, null); assert.deepEqual(a.availability!.weeklyHours, []);
  assert.equal(a.availability!.summaryText, "Weekdays: By appointment after lunch");
  assert.equal(a.availability!.meaning, "BUSINESS_HOURS_NOT_SLOTS");
  assert.equal(a.business.phone, c.facts.contacts.phone); assert.equal(a.business.email, c.facts.contacts.email);
  assert.equal(a.business.address, "Main Street"); assert.deepEqual(a.business.locations, c.facts.locations);
  assert.equal(a.business.website, c.sourceWebsite); assert.equal(a.policies[0]!.content, c.facts.policies[0]);
  assert.match(a.knowledgeDocumentChunks[0]!.chunkText, /remote meetings are offered/);
  assert.deepEqual(a.approvedKnowledgeFacts, []); // Website FAQs are not governance-approved production facts.
  assert.equal(a.safetyInstructions.canAnswerServiceQuestions, true); assert.equal(a.safetyInstructions.canAnswerPricingQuestions, true);
  assert.equal(a.safetyInstructions.canAnswerBusinessHoursQuestions, true); assert.equal(a.safetyInstructions.canAnswerAvailabilityQuestions, false);
  assert.equal(a.safetyInstructions.canAnswerPolicyQuestions, true);
});

test("empty or partial extraction advertises only capabilities backed by canonical facts", async () => {
  const c = websiteContext(); c.extractionStatus = "FALLBACK";
  const result = await adaptDemoRuntimeContext(actor, c);
  assert.deepEqual(result.services, []); assert.equal(result.availability, null);
  assert.deepEqual(result.knowledgeDocumentChunks, []);
  for (const [key, value] of Object.entries(result.safetyInstructions)) if (key.startsWith("canAnswer") || key === "canDetectBookingIntent") assert.equal(value, false, key);
});

// Controlled provider outputs test the real adapter → interpreter validator → state → planner → response policy → persistence.
// They intentionally do not claim to measure a live model's language quality.
const cases = [
  { industry: "Clinic", message: "When are you open?", intent: "AVAILABILITY_INQUIRY", hours: true, services: [service("Consultation")], reply: "We are open Monday to Friday, 8 AM to 5 PM." },
  { industry: "Consultancy", message: "Can I book a strategy consultation?", intent: "BOOKING_INTENT", services: [service("Strategy consultation")], booking: true, reply: "What day would you like to come in?" },
  { industry: "Consultancy complete request", message: "Can I book a strategy consultation tomorrow at 2pm?", intent: "BOOKING_INTENT", services: [service("Strategy consultation")], booking: true, tomorrow: true, complete: true, reply: "Live availability and appointment booking are not connected in this demo." },
  { industry: "Repair company", message: "My AC isn't cooling. Can someone come tomorrow?", intent: "BOOKING_INTENT", services: [service("AC repair")], booking: true, tomorrow: true, reply: "What time would you prefer?" },
  { industry: "Salon", message: "How much is braiding?", intent: "PRICING_INQUIRY", services: [service("Braiding", "GHS 150")], reply: "Braiding costs GHS 150." },
  { industry: "Salon FAQ price", message: "How much is braiding?", intent: "PRICING_INQUIRY", services: [service("Braiding")], faqPrice: true, reply: "Braiding costs GHS 150." },
  { industry: "Salon unknown price", message: "How much is braiding?", intent: "PRICING_INQUIRY", services: [service("Braiding")], reply: "I don't have a confirmed price for that right now." },
  { industry: "Photography", message: "Do you do weddings?", intent: "SERVICE_INQUIRY", services: [service("Wedding photography")], faq: true, reply: "Yes, we photograph weddings and offer digital albums." },
  { industry: "Creative business", message: "hrllo", intent: "GENERAL_QUESTION", services: [service("Portrait photography")], greeting: true, reply: "Hi! How can I help?" },
  { industry: "Consultancy catalog", message: "what services do you offer?", intent: "SERVICE_INQUIRY", services: [service("Strategy consultation"), service("Business planning")], reply: "We offer strategy consultation and business planning." },
] as const;
for (const entry of cases) test(`${entry.industry}: ${entry.message}`, async t => {
  const f = fixture(t); f.demo();
  const c = websiteContext(entry.industry); c.facts.services = [...entry.services];
  if ("hours" in entry) c.facts.openingHours = [{ day: "Monday to Friday", hours: "8 AM to 5 PM" }];
  if ("faq" in entry) c.facts.faqs = [{ question: "Do you do weddings?", answer: "Yes, we photograph weddings and offer digital albums." }];
  if ("faqPrice" in entry) c.facts.faqs = [{ question: entry.message, answer: entry.reply }];
  mockMethod(t, prisma.demoSession, "findFirst", async ({ where }: any) => where.id === actor.demoSessionId && where.business.id === actor.businessId ? { setupStatus: "READY", demoContext: c } : null);
  mockMethod(t, prisma.message, "findMany", f.tx.message.findMany);
  const forbidden = () => { throw new Error("Production effect/lookup forbidden"); };
  const spies = [mockMethod(t, appointmentPlanningBackend, "checkSlot", forbidden)];
  for (const delegate of [prisma.service, prisma.appointment, prisma.knowledgeDocument, prisma.knowledgeArticle, prisma.customerMemoryItem, prisma.followUpJob]) {
    for (const method of ["create", "findMany"]) spies.push(mockMethod(t, delegate, method, forbidden));
  }
  const m = await f.add(entry.message);
  const timing = new ConversationRuntimeTiming();
  const context = await timing.measure("contextBuildMs", () => buildDemoBusinessContext(actor, m));
  assert.equal(context.services[0]!.name, entry.services[0].name);
  const interpreter = mockMethod(t, aiProvider, "generateCompletion", async (input: any) => {
    const data = JSON.parse(input.userPrompt);
    assert.deepEqual(data.business.services.map((s: any) => s.id), context.services.map(s => s.id));
    assert.equal(data.business.services[0].name, entry.services[0].name);
    const entity = (key: string, value: string, extra = {}) => ({ key, value, kind: "TEXT", confidence: .99, certainty: "EXACT", source: "CURRENT_MESSAGE", evidence: [{ messageId: m.id, quote: m.content }], ...extra });
    const interpreted = { intent: entry.intent, confidence: .99, needsClarification: false, resolvedEntities: "booking" in entry ? [entity("reason", m.content), ...("tomorrow" in entry ? [entity("preferredDate", "tomorrow", { kind: "DATE", normalizedValue: offsetLocalDate(data.localClock.date, 1), dateBasis: { type: "DAY_OFFSET", offsetDays: 1 } })] : []), ...("complete" in entry ? [entity("preferredTime", "2pm", { kind: "TIME", normalizedValue: "14:00" })] : [])] : [], ...("booking" in entry ? { topic: "APPOINTMENT", customerPurpose: servicePurpose(m, context.services[0]!), workflow: { action: "START", name: "APPOINTMENT_BOOKING" } } : {}), ...("greeting" in entry ? { conversationAct: "GREETING" } : {}) };
    return { rawText: JSON.stringify(interpreted), provider: "OPENROUTER", model: "fixture", providerRequestCount: 1 };
  });
  const response = mockMethod(t, aiProvider, "generateReply", async (input: any) => {
    const envelope = JSON.parse(input.userPrompt); const sections = envelope.context.sections;
    assert.equal(sections.temporaryDemoFacts, undefined);
    assert.deepEqual(sections.serviceCatalog.data.map((s: any) => s.id), context.services.map(s => s.id));
    if ("hours" in entry) { assert.match(sections.availability.data.summaryText, /8 AM to 5 PM/); assert.equal(sections.availability.trustClassification, "UNTRUSTED_DATA"); }
    if ("faqPrice" in entry) { assert.equal(sections.capabilities.data.canAnswerPricingQuestions, true); assert.match(sections.uploadedDocumentChunks.data[0].text, /GHS 150/); }
    if ("faq" in entry) assert.match(sections.uploadedDocumentChunks.data[0].text, /digital albums/);
    return { rawText: JSON.stringify(responseOutput(input, entry.reply)), provider: "OPENROUTER", model: "fixture", providerRequestCount: 1 };
  });
  const result = await generateContextReply(context, { businessId: actor.businessId, conversationId: m.conversationId, messageId: m.id }, timing);
  assert.equal(result.parsedDecision.replyText, entry.reply);
  assert.equal(aiSafetyService.evaluate({ decision: result.parsedDecision, businessReady: true, humanTakeover: false, replyOnlyDemo: true }).allowed, true);
  assert.equal(interpreter.mock.callCount(), 1); assert.equal(response.mock.callCount(), 1); assert.equal(result.providerRequestCount, 2);
  if ("booking" in entry) {
    assert.equal(f.state().activeWorkflow, "APPOINTMENT_BOOKING");
    assert.equal(f.state().knownEntities.serviceName.value, context.services[0]!.name);
    assert.ok(result.conversationPlan.knownFields.includes("service"), "workflow adapter resolves canonical service");
    assert.ok(!result.conversationPlan.missingFields.includes("service"));
    if ("complete" in entry) {
      assert.equal(result.conversationPlan.reasonCode, "DEMO_AVAILABILITY_NOT_CONNECTED");
      assert.equal(result.conversationPlan.workflowRequest!.serviceId, context.services[0]!.id);
      assert.equal(result.conversationPlan.workflowRequest!.type, "CHECK_APPOINTMENT_AVAILABILITY");
    } else assert.equal(result.conversationPlan.targetField, "tomorrow" in entry ? "preferredTime" : "preferredDate");
  }
  if ("greeting" in entry) assert.equal(result.conversationPlan.reasonCode, "CUSTOMER_GREETING");
  await timing.measure("persistenceMs", () => prisma.$transaction(tx => storeAiReply(tx, { ...scope, leadId: "lead-a", senderType: "AI", direction: "OUTBOUND", messageType: "TEXT", deliveryStatus: "INTERNAL", content: entry.reply }, "OPEN", {}, { demoSessionId: actor.demoSessionId, plan: result.conversationPlan, response: { text: result.validatedResponse.text, metadata: result.conversationResponse } })));
  timing.report({ ...scope, sourceMessageId: m.id });
  const logged = f.logs.find(l => l[0] === "conversation_runtime.timing")[1];
  for (const stage of ["contextBuildMs", "interpretationMs", "plannerMs", "workflowMs", "responseMs", "persistenceMs", "totalMs"]) assert.ok(Number.isFinite(logged[stage]) && logged[stage] >= 0);
  assert.ok(!JSON.stringify(logged).includes(entry.message));
  assert.ok(f.messages().some(row => row.senderType === "AI" && row.content === entry.reply));
  await assert.rejects(buildDemoBusinessContext({ ...actor, businessId: "other" }, m), { code: "DEMO_RESOURCE_FORBIDDEN" });
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});
