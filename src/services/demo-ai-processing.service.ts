import { Message, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { assertDemoEnabled, DemoActor } from "./demo.service";
import { canonical, resolveResources } from "./demo-message.service";
import { buildDemoBusinessContext } from "./demo-business-context.provider";
import { generateContextReply } from "./ai-reply-runtime.service";
import { aiSafetyService } from "./ai-safety.service";
import { storeAiReply } from "./ai-message-store.service";

export const DEMO_AI_LIMIT = 50;
const unavailable = () => new AppError(503, "Demo AI is unavailable for this message", "DEMO_AI_UNAVAILABLE");
const metadata = (message: Message) => (message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata) ? message.metadata : {}) as Prisma.InputJsonObject;
async function lock(tx: Prisma.TransactionClient, actor: DemoActor) {
  const result = await tx.demoSession.updateMany({ where: { id: actor.demoSessionId, status: "ACTIVE", expiresAt: { gt: new Date() }, business: { id: actor.businessId, demoSessionId: actor.demoSessionId, deletedAt: null } }, data: { lastActivityAt: new Date() } });
  if (!result.count) throw new AppError(403, "Demo resource forbidden", "DEMO_RESOURCE_FORBIDDEN");
  return resolveResources(tx, actor);
}
const response = (customer: Message, ai: Message) => ({ success: true, conversation: { id: customer.conversationId }, customerMessage: canonical(customer), aiMessage: canonical(ai) });

/** Reply-only orchestration using the same context runtime, safety and persistence as production. */
export async function processLatestDemoReply(actor: DemoActor) {
  assertDemoEnabled();
  const claim = await prisma.$transaction(async tx => {
    const { conversation, lead } = await lock(tx, actor);
    const scope = { businessId: actor.businessId, conversationId: conversation.id, leadId: lead.id };
    const customer = await tx.message.findFirst({ where: { ...scope, senderType: "CUSTOMER", direction: "INBOUND", messageType: "TEXT", deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!customer) throw new AppError(404, "No demo customer message found", "DEMO_CUSTOMER_MESSAGE_NOT_FOUND");
    const existing = await tx.message.findFirst({ where: { ...scope, provider: "DEMO_AI", providerMessageId: customer.id, senderType: "AI", direction: "OUTBOUND", messageType: "TEXT", deletedAt: null } });
    if (existing) return { customer, existing };
    // Claims survive crashes and count failed calls. Never regenerate a claimed input.
    if (metadata(customer).demoAiAttempted === true) throw unavailable();
    const attempts = await tx.message.count({ where: { ...scope, senderType: "CUSTOMER", metadata: { path: ["demoAiAttempted"], equals: true } } });
    // Successful replies and failed attempts both have separate hard bounds.
    const replyCount = await tx.message.count({ where: { ...scope, provider: "DEMO_AI" } });
    if (attempts >= DEMO_AI_LIMIT || replyCount >= DEMO_AI_LIMIT) throw new AppError(429, "Demo AI limit reached", "DEMO_AI_LIMIT_REACHED");
    await tx.message.update({ where: { id: customer.id, ...scope }, data: { metadata: { ...metadata(customer), demoAiAttempted: true } } });
    const session = await tx.demoSession.findUniqueOrThrow({ where: { id: actor.demoSessionId }, select: { setupAttemptId: true } });
    return { customer, existing: null, setupAttemptId: session.setupAttemptId };
  });
  if (claim.existing) return response(claim.customer, claim.existing);
  const customer = claim.customer;
  let result;
  try {
    const context = await buildDemoBusinessContext(actor, customer);
    result = await generateContextReply(context, { businessId: actor.businessId, conversationId: customer.conversationId, messageId: customer.id, maxAttempts: 1, signal: AbortSignal.timeout(30_000), metadata: { channel: "DEMO", source: "INBOUND_MESSAGE", isDemo: true, demoSessionId: actor.demoSessionId } });
  } catch { throw unavailable(); }
  const safety = aiSafetyService.evaluate({ decision: result.parsedDecision, businessReady: true, humanTakeover: false });
  if (result.fallbackExhausted || !safety.allowed || safety.decision.suggestedAction !== "SEND_REPLY" || safety.decision.requiresHumanReview || !safety.decision.shouldReply || !safety.decision.replyText?.trim()) throw unavailable();
  const ai = await prisma.$transaction(async tx => {
    const { conversation, lead } = await lock(tx, actor);
    const session = await tx.demoSession.findUniqueOrThrow({ where: { id: actor.demoSessionId }, select: { setupAttemptId: true } });
    if (conversation.id !== customer.conversationId || lead.id !== customer.leadId || session.setupAttemptId !== claim.setupAttemptId) throw unavailable();
    const stillPresent = await tx.message.findFirst({ where: { id: customer.id, businessId: actor.businessId, conversationId: conversation.id, leadId: lead.id, deletedAt: null, senderType: "CUSTOMER", direction: "INBOUND", messageType: "TEXT" } });
    if (!stillPresent) throw unavailable();
    return storeAiReply(tx, { businessId: actor.businessId, conversationId: conversation.id, leadId: lead.id, senderType: "AI", direction: "OUTBOUND", messageType: "TEXT", deliveryStatus: "INTERNAL", readAt: new Date(), content: safety.decision.replyText!.trim(), provider: "DEMO_AI", providerMessageId: customer.id, metadata: { isDemo: true, demoSessionId: actor.demoSessionId, sourceCustomerMessageId: customer.id, model: result.model } }, "OPEN", { isDemo: true, demoSessionId: actor.demoSessionId });
  });
  return response(customer, ai);
}
