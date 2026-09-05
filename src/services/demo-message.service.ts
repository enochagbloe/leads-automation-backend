import { Message, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { DemoActor, assertDemoEnabled } from "./demo.service";
import { storeInboundCustomerMessage } from "./inbound-message-store.service";

export const DEMO_CUSTOMER_MESSAGE_LIMIT = 50;
const schema = z.object({ text: z.string().trim().min(1).max(2000), clientMessageId: z.string().uuid().transform(value => value.toLowerCase()) }).strict();
export function parseDemoMessage(input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AppError(400, "Text (1-2000 characters) and a UUID clientMessageId are required", "DEMO_MESSAGE_INVALID");
  return parsed.data;
}
const forbidden = () => new AppError(403, "Demo resource forbidden", "DEMO_RESOURCE_FORBIDDEN");
export async function resolveResources(tx: Prisma.TransactionClient, actor: DemoActor) {
  const session = await tx.demoSession.findFirst({ where: { id: actor.demoSessionId, status: "ACTIVE", expiresAt: { gt: new Date() }, business: { id: actor.businessId, demoSessionId: actor.demoSessionId, deletedAt: null } }, select: { setupStatus: true } });
  if (!session) throw forbidden();
  if (session.setupStatus !== "READY" && session.setupStatus !== "READY_PARTIAL") throw new AppError(409, "Demo setup is not ready", "DEMO_SETUP_NOT_READY");
  const conversations = await tx.conversation.findMany({ where: { businessId: actor.businessId, deletedAt: null }, take: 2, select: { id: true, businessId: true, leadId: true, channel: true } });
  const conversation = conversations[0];
  if (conversations.length !== 1 || !conversation || conversation.channel !== "DEMO" || conversation.businessId !== actor.businessId) throw forbidden();
  const lead = await tx.lead.findFirst({ where: { id: conversation.leadId, businessId: actor.businessId, deletedAt: null, phone: `demo_customer_${actor.demoSessionId}` }, select: { id: true } });
  if (!lead) throw forbidden();
  return { conversation, lead };
}
export function canonical(message: Message) {
  return { id: message.id, text: message.content, senderType: message.senderType, direction: message.direction, messageType: message.messageType, createdAt: message.createdAt };
}
export const demoMessageService = {
  async create(actor: DemoActor, input: unknown) {
    assertDemoEnabled();
    const data = parseDemoMessage(input);
    return prisma.$transaction(async tx => {
      // Serialize sends with each other, setup and destruction, across backend instances.
      const locked = await tx.demoSession.updateMany({ where: { id: actor.demoSessionId, status: "ACTIVE", expiresAt: { gt: new Date() }, business: { id: actor.businessId, demoSessionId: actor.demoSessionId } }, data: { lastActivityAt: new Date() } });
      if (!locked.count) throw forbidden();
      const { conversation, lead } = await resolveResources(tx, actor);
      const providerMessageId = `demo:${actor.demoSessionId}:${data.clientMessageId}`;
      const existing = await tx.message.findFirst({ where: { businessId: actor.businessId, provider: "DEMO", providerMessageId } });
      if (existing) {
        if (existing.conversationId !== conversation.id || existing.leadId !== lead.id || existing.senderType !== "CUSTOMER" || existing.direction !== "INBOUND" || existing.messageType !== "TEXT" || existing.deletedAt) throw forbidden();
        if (existing.content !== data.text) throw new AppError(409, "clientMessageId was already used for different text", "DEMO_MESSAGE_CONFLICT");
        return { success: true, conversation: { id: conversation.id }, message: canonical(existing) };
      }
      // Include deleted customer rows so a retry/deletion cannot reset the allowance.
      const count = await tx.message.count({ where: { businessId: actor.businessId, conversationId: conversation.id, senderType: "CUSTOMER" } });
      if (count >= DEMO_CUSTOMER_MESSAGE_LIMIT) throw new AppError(429, "Demo customer message limit reached", "DEMO_MESSAGE_LIMIT_REACHED");
      const { message } = await storeInboundCustomerMessage(tx, {
        businessId: actor.businessId, conversationId: conversation.id, leadId: lead.id, content: data.text,
        provider: "DEMO", providerMessageId,
        metadata: { isDemo: true, demoSessionId: actor.demoSessionId, clientMessageId: data.clientMessageId },
        activityMetadata: { isDemo: true, demoSessionId: actor.demoSessionId },
      });
      return { success: true, conversation: { id: conversation.id }, message: canonical(message) };
    }, { maxWait: 15_000, timeout: 15_000 });
  },
  async list(actor: DemoActor) {
    assertDemoEnabled();
    return prisma.$transaction(async tx => {
      const { conversation, lead } = await resolveResources(tx, actor);
      const messages = await tx.message.findMany({ where: { businessId: actor.businessId, conversationId: conversation.id, leadId: lead.id, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
      return { success: true, conversation: { id: conversation.id }, messages: messages.reverse().map(canonical) };
    });
  },
};
