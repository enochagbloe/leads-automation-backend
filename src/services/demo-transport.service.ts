import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
// Fail closed at the provider boundary, including direct provider-client calls.
export async function assertProductionWhatsApp(businessId: string, conversationId?: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { demoSessionId: true } });
  if (!business || business.demoSessionId) throw new AppError(403, "WhatsApp is unavailable for this scope", "DEMO_RESOURCE_FORBIDDEN");
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, businessId }, select: { channel: true } });
    if (!conversation || conversation.channel === "DEMO") throw new AppError(403, "WhatsApp is unavailable for this scope", "DEMO_RESOURCE_FORBIDDEN");
  }
}
export const demoRealtimeScope = (demoSessionId: string, conversationId: string) => `demo:${demoSessionId}:conversation:${conversationId}`;
