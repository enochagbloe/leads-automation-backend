import { conversationPlannerService } from "../src/services/conversation-planner.service";
import { fallbackResponse } from "../src/services/conversation-response.service";
import { conversationPlanSchema } from "../src/services/conversation-plan.schema";
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
  const slots = mockMethod(t, appointmentPlanningBackend, "checkSlot", async () => { assert.fail("Side questions cannot inspect slots or execute workflows"); });
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
async function booked(t: TestContext, catalog: Catalog = "consultancy", demo = false, dateKnown = false) {
  const f = await setup(t, catalog, demo);
  const m = await f.add(`I want to book ${f.services[0]!.name}${dateKnown ? " tomorrow" : ""}`);
  m.createdAt = new Date("2026-09-29T10:00:00Z");
  const i = f.meaning(m, "EXACT"); if(dateKnown) i.resolvedEntities = [temporal(m,"preferredDate","2026-09-30")];
  await f.save(await f.run(m,i,dateKnown ? "What time works for you?" : "What day works for you?"));
  return f;
}
for(const demo of [false,true]) for(const catalog of ["consultancy","repair","clinic","photography","salon"] as const) {
  for(const [intent,question,answer] of [
    ["PRICING_INQUIRY","How much is it?","It's GHS 150."],
    ["AVAILABILITY_INQUIRY","Are you open Sundays?","We're open Sundays from 10am to 4pm."],
    ["GENERAL_QUESTION","Where are you located?","We're at East Legon."],
  ] as const) test(`${demo ? "demo" : "production Basic"} ${catalog}: ${intent} answers then continues without a resume command`, async t=>{
    const f=await booked(t,catalog,demo); const before=structuredClone(f.state()); const m=await f.add(question);
    const r=await f.run(m,side(m,intent),`${answer} What day would work for you?`);
    assert.equal(r.conversationPlan.move,"ANSWER"); assert.equal(r.conversationPlan.continuation?.field,"preferredDate");
    assert.equal(r.conversationPlan.suspendedContext?.workflow,"APPOINTMENT_BOOKING"); assert.equal(r.conversationPlan.workflowRequest,undefined);
    assert.deepEqual(f.state().knownEntities,before.knownEntities); assert.deepEqual(f.state().awaiting,before.awaiting);
    assert.equal(r.validatedResponse.answerText,answer); assert.equal(r.validatedResponse.askedField,"preferredDate"); assert.equal(r.providerRequestCount,2);
    assert.equal(r.parsedDecision.suggestedAction,"SEND_REPLY"); assert.equal(r.parsedDecision.appointmentIntent,undefined);
    const reply=await f.save(r); const revision=f.state().revision; const again=await f.save(r);
    assert.equal(reply.id,again.id); assert.equal(f.state().revision,revision); assert.equal(f.state().awaiting.field,"preferredDate");
    assert.deepEqual(f.state().knownEntities,before.knownEntities); assert.equal(f.state().activeWorkflow,before.activeWorkflow);
    const next=await f.add("Tomorrow"); next.createdAt=new Date("2026-09-29T11:00:00Z");
    const continued: ConversationInterpretation = {intent:"BOOKING_INTENT",confidence:.98,needsClarification:false,resolvedEntities:[temporal(next,"preferredDate","2026-09-30")],pendingExpectation:{resolved:true,field:"preferredDate"},workflow:{name:"APPOINTMENT_BOOKING",action:"CONTINUE"}};
    const nextReply=await f.run(next,continued,"What time would work for you?");
    assert.equal(nextReply.conversationPlan.targetField,"preferredTime"); assert.equal(f.state().knownEntities.preferredDate.normalizedValue,"2026-09-30");
    assert.equal(f.slots.mock.callCount(),0);
  });
}
for(const demo of [false,true]) test(`known date resumes at time, despite an outdated date expectation: demo=${demo}`,async t=>{
  const f=await booked(t,"consultancy",demo,true);
  await state.setAwaiting(f.command(),{type:"FIELD",field:"preferredDate"});
  const before=structuredClone(f.state().knownEntities); const m=await f.add("How much is it?");
  const r=await f.run(m,side(m),"It's GHS 150. What time works for you tomorrow?");
  assert.equal(r.conversationPlan.continuation?.field,"preferredTime"); await f.save(r);
  assert.equal(f.state().awaiting.field,"preferredTime"); assert.deepEqual(f.state().knownEntities,before);
});

test("no active workflow answers only and does not invent a booking",async t=>{
  const f=await setup(t,"consultancy"); const m=await f.add("How much is the strategy consultation?"); const i=side(m); delete i.topicShift!.from;
  const r=await f.run(m,i,"It's GHS 150."); assert.equal(r.conversationPlan.continuation,undefined);
  assert.equal(f.state().activeWorkflow,null); assert.equal(r.validatedResponse.questionCount,0);
});

for(const intent of ["HUMAN_REQUEST","COMPLAINT"] as const) for(const demo of [false,true]) test(`${intent} wins over continuity: demo=${demo}`,async t=>{
  const f=await booked(t,"consultancy",demo); const before=structuredClone(f.state()); const m=await f.add(intent==="HUMAN_REQUEST" ? "I want a person" : "I am unhappy with the service");
  const i:ConversationInterpretation={intent,confidence:.98,needsClarification:false,resolvedEntities:[],customerPurpose:{goal:intent==="HUMAN_REQUEST"?"HUMAN_ASSISTANCE":"COMPLAINT",need:m.content,resolution:"UNRESOLVED",serviceId:null,candidateServiceIds:[],confidence:.98,evidence:[{messageId:m.id,quote:m.content}],catalogEvidence:[]}};
  const r=await f.run(m,i,"I understand you need help from the team.");
  assert.equal(r.conversationPlan.move,"REQUEST_HUMAN"); assert.equal(r.conversationPlan.continuation,undefined); assert.equal(r.conversationPlan.requiresHumanReview,!demo);
  assert.deepEqual(f.state().knownEntities,before.knownEntities); assert.deepEqual(f.state().awaiting,before.awaiting);
});

for(const lifecycle of ["PAUSED","COMPLETED","CANCELLED","WAITING_FOR_SYSTEM"] as const) test(`${lifecycle} workflow never auto-resumes`,async t=>{
  const f=await booked(t); if(lifecycle==="PAUSED") await state.pauseWorkflow(f.command());
  else if(lifecycle==="COMPLETED") await state.completeWorkflow(f.command());
  else if(lifecycle==="CANCELLED") await state.patch(f.command(),{activeWorkflow:null,workflowStatus:"CANCELLED",awaiting:null,offeredOptions:[],lastAssistantQuestion:null});
  else await state.patch(f.command(),{workflowStatus:"WAITING_FOR_SYSTEM",awaiting:{type:"SYSTEM_RESULT"}});
  const before=structuredClone(f.state()); const m=await f.add("Where are you located?"); const i=side(m,"GENERAL_QUESTION"); i.topicShift!.from=before.activeTopic ?? undefined;
  const r=await f.run(m,i,"We're at East Legon."); await f.save(r);
  assert.equal(r.conversationPlan.continuation,undefined); assert.equal(f.state().workflowStatus,before.workflowStatus);
  assert.equal(f.state().activeWorkflow,before.activeWorkflow); assert.deepEqual(f.state().awaiting,before.awaiting);
});

for(const variant of ["new-primary","missing-classification","forged-evidence","ambiguous","low-confidence"] as const) test(`${variant} cannot authorize continuation or replace purpose`,async t=>{
  const f=await booked(t,"repair"); const before=structuredClone(f.state()); const m=await f.add("Tell me about installation instead"); const i=side(m,"SERVICE_INQUIRY");
  if(variant==="new-primary") {i.topicShift!.kind="NEW_PRIMARY_GOAL"; i.customerPurpose={...f.meaning(m,"INFERRED","SEEK_SERVICE",1).customerPurpose!};}
  if(variant==="missing-classification") delete i.topicShift!.kind;
  if(variant==="forged-evidence") i.topicShift!.evidence![0]!.quote="not in the customer message";
  if(variant==="ambiguous") {i.needsClarification=true;i.clarificationReason="CONTEXT_INSUFFICIENT";}
  if(variant==="low-confidence") i.confidence=.5;
  const invalid=["forged-evidence","ambiguous","low-confidence"].includes(variant);
  const r=await f.run(m,i,invalid?"Could you clarify what you mean?":"We offer installation of new units.");
  assert.equal(r.conversationPlan.continuation,undefined); assert.deepEqual(f.state().knownEntities,before.knownEntities);
  assert.deepEqual(f.state().awaiting,before.awaiting); assert.equal(f.state().activeWorkflow,before.activeWorkflow);
});

test("side-question purpose and entity proposals cannot overwrite the main goal or pending field",async t=>{
  const f=await booked(t,"repair"); const before=structuredClone(f.state()); const m=await f.add("What does AC Installation include?");
  const i=side(m,"SERVICE_INQUIRY"); i.customerPurpose=f.meaning(m,"EXACT","INQUIRE_SERVICE",1).customerPurpose;
  i.resolvedEntities=[{key:"preferredDate",value:"2099-01-01",normalizedValue:"2099-01-01",kind:"DATE",certainty:"EXACT",confidence:.99,source:"CURRENT_MESSAGE",evidence:[{messageId:m.id,quote:m.content}],dateBasis:{type:"EXPLICIT"}}];
  i.pendingExpectation={resolved:true,field:"preferredDate"};
  const r=await f.run(m,i,"That covers installation of new units. What day would work for your inspection?");
  assert.deepEqual(f.state().knownEntities,before.knownEntities); assert.deepEqual(f.state().awaiting,before.awaiting);
  assert.equal(r.conversationPlan.continuation?.field,"preferredDate");
});

for(const variant of ["catalog-removed","knowledge-guard","ai-capability","confirmation-pending","options-pending","complete-details"] as const) test(`${variant} blocks automatic field continuation`,async t=>{
  const f=await booked(t); const m=await f.add("How much is it?");
  if(variant==="catalog-removed") f.services.splice(0);
  if(variant==="confirmation-pending") await state.setAwaiting(f.command(),{type:"CONFIRMATION"});
  if(variant==="options-pending") await state.setAwaiting(f.command(),{type:"OPTION_SELECTION",field:"preferredTime"});
  if(variant==="complete-details") {await state.setEntity(f.command(),"preferredDate",{kind:"DATE",value:"2026-09-30",normalizedValue:"2026-09-30"});await state.setEntity(f.command(),"preferredTime",{kind:"TIME",value:"14:00",normalizedValue:"14:00"});}
  const ctx=f.context(m); if(variant==="knowledge-guard") ctx.runtimeKnowledgeGuards=[{reviewItemId:"review",canonicalEntityType:"SERVICE",canonicalEntityId:f.services[0]!.id,canonicalField:"basePrice",priority:"HIGH"}];
  if(variant==="ai-capability") ctx.safetyInstructions.canDetectBookingIntent=false;
  const snapshot=await conversationContextService.getSnapshot({...f.scoped,messageId:m.id});
  const p=await conversationPlannerService.plan({businessContext:ctx,conversationSnapshot:snapshot,interpretation:side(m)});
  assert.equal(p.continuation,undefined); assert.equal(f.slots.mock.callCount(),0);
});

test("continuation reply and pending field commit atomically, with revision and tenant checks",async t=>{
  const f=await booked(t,"consultancy",true); const m=await f.add("Where are you located?"); const r=await f.run(m,side(m,"GENERAL_QUESTION"),"We're at East Legon. What day works for you?");
  const before=structuredClone(f.state()); const count=f.messages().length;
  await state.setEntity(f.command(),"branch",{value:"new choice"});
  await assert.rejects(f.save(r),{code:"CONVERSATION_STATE_CONFLICT"}); assert.equal(f.messages().length,count);
  await assert.rejects(prisma.$transaction(tx=>storeAiReply(tx,{businessId:"other-business",conversationId:scope.conversationId,leadId:"lead-a",senderType:"AI",direction:"OUTBOUND",messageType:"TEXT",content:r.validatedResponse.text!,deliveryStatus:"INTERNAL"},"OPEN",{},{demoSessionId:"demo-a",plan:r.conversationPlan})),{code:"CONVERSATION_STATE_FORBIDDEN"});
  const next=await f.add("Where are you located?"); const fresh=await f.run(next,side(next,"GENERAL_QUESTION"),"We're at East Legon. What day works for you?"); const current=structuredClone(f.state()); const messages=f.messages().length;
  f.fail(); await assert.rejects(f.save(fresh)); assert.deepEqual(f.state(),current); assert.equal(f.messages().length,messages);
  assert.equal(before.awaiting.field,"preferredDate");
});

test("validator requires the side answer before the one authorized question and preserves grounding",async t=>{
  const f=await booked(t); const m=await f.add("How much is it?"); const r=await f.run(m,side(m),"It's GHS 150. What day works for you?");
  const snapshot=await conversationContextService.getSnapshot({...f.scoped,messageId:m.id});
  const ctx={...f.context(m),conversationPlan:r.conversationPlan,conversationSnapshot:snapshot};
  const validate=(generated:any)=>conversationResponsePolicyService.validate({plan:r.conversationPlan,state:snapshot.state,recentMessages:[],facts:responseFacts(ctx),generatedResponse:generated});
  assert.equal(validate(r.validatedResponse).valid,true);
  for(const change of [
    {answerText:null,text:"What day works for you?"},
    {text:"What day works for you? It's GHS 150."},
    {askedField:"preferredTime"},
    {answerText:"It's GHS 999.",text:"It's GHS 999. What day works for you?"},
    {answerText:"Your appointment is confirmed.",text:"Your appointment is confirmed. What day works for you?"},
    {continuationQuestion:"What day and time works for you?",text:"It's GHS 150. What day and time works for you?"},
  ]) assert.equal(validate({...r.validatedResponse,...change}).valid,false,JSON.stringify(change));
});


test("hours answer can ask a natural weekday preference without claiming availability",async t=>{
  const f=await booked(t,"clinic",true); const m=await f.add("Are you open Sundays?");
  const r=await f.run(m,side(m,"AVAILABILITY_INQUIRY"),"We're open Sundays from 10am to 4pm. Would Sunday work for the visit?");
  assert.equal(r.validatedResponse.askedField,"preferredDate"); assert.deepEqual(r.validatedResponse.claims,[]);
  assert.equal(f.state().knownEntities.preferredDate,undefined); assert.equal(f.slots.mock.callCount(),0);
});

test("unknown-price fallback answers honestly before the authorized question",async t=>{
  const f=await booked(t,"salon",true); const m=await f.add("How much is it?");
  const r=await f.run(m,side(m),"It's GHS 150. What day would work for you?");
  const snapshot=await conversationContextService.getSnapshot({...f.scoped,messageId:m.id});
  const ctx={...f.context(m),conversationPlan:r.conversationPlan,conversationSnapshot:snapshot};
  const fallback=fallbackResponse(ctx,[]);
  assert.equal(fallback?.text,"I don't have a confirmed price for that right now. What day would work for you?");
  assert.equal(conversationResponsePolicyService.validate({plan:r.conversationPlan,state:snapshot.state,recentMessages:[],facts:[],generatedResponse:fallback}).valid,true);
});

test("human control acquired after generation prevents storing a continuation",async t=>{
  const f=await booked(t); const m=await f.add("Where are you located?"); const r=await f.run(m,side(m,"GENERAL_QUESTION"),"We're at East Legon. What day would work for you?");
  const before=structuredClone(f.state()); const count=f.messages().length; f.human();
  await assert.rejects(f.save(r),{code:"CONVERSATION_PLAN_CONTROL_CHANGED"}); assert.deepEqual(f.state(),before); assert.equal(f.messages().length,count);
});

test("AI policy control prevents even planning an automatic continuation",async t=>{
  const f=await booked(t); const m=await f.add("Where are you located?"); const ctx=f.context(m); ctx.planCapabilities.aiReplies=false;
  const snapshot=await conversationContextService.getSnapshot({...f.scoped,messageId:m.id});
  const p=await conversationPlannerService.plan({businessContext:ctx,conversationSnapshot:snapshot,interpretation:side(m,"GENERAL_QUESTION")});
  assert.equal(p.move,"NO_ACTION"); assert.equal(p.continuation,undefined);
});

test("a continuation cannot target a known field, carry an action, or bypass review",async t=>{
  const f=await booked(t); const m=await f.add("Where are you located?"); const r=await f.run(m,side(m,"GENERAL_QUESTION"),"We're at East Legon. What day would work for you?");
  const p=r.conversationPlan;
  for(const change of [{knownFields:[...p.knownFields,"preferredDate"]},{requiresHumanReview:true},{responseDirective:{...p.responseDirective,askOneQuestion:false}},{move:"CONTINUE_WORKFLOW"},{continuation:{...p.continuation,workflow:"ANOTHER_WORKFLOW"}}]) assert.equal(conversationPlanSchema.safeParse({...p,...change}).success,false);
});

test("an answer-only plan rejects an unplanned continuation even with matching response text",async t=>{
  const f=await setup(t,"consultancy"); const m=await f.add("Where are you located?"); const i=side(m,"GENERAL_QUESTION"); delete i.topicShift!.from;
  const r=await f.run(m,i,"We're at East Legon.");
  const snapshot=await conversationContextService.getSnapshot({...f.scoped,messageId:m.id});
  const result=conversationResponsePolicyService.validate({plan:r.conversationPlan,state:snapshot.state,recentMessages:[],facts:[],generatedResponse:{...r.validatedResponse,text:"We're at East Legon. What day works for you?",answerText:"We're at East Legon.",continuationQuestion:"What day works for you?",askedField:"preferredDate",questionCount:1}});
  assert.equal(result.valid,false); assert.ok(result.issues.includes("UNPLANNED_CONTINUATION"));
});
