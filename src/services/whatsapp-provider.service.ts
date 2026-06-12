import { WhatsAppIntegrationStatus, WhatsAppProvider } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";

export type SendWhatsAppTextParams = {
  phoneNumberId: string;
  to: string;
  message: string;
  businessId: string;
  conversationId: string;
  messageId: string;
};

export type WhatsAppSendResult = {
  success: boolean;
  provider: "MOCK_WHATSAPP" | "META_WHATSAPP";
  providerMessageId?: string;
  error?: string;
  raw?: unknown;
};

export interface WhatsAppProviderClient {
  sendTextMessage(params: SendWhatsAppTextParams): Promise<WhatsAppSendResult>;
}

export async function getWhatsAppIntegration(businessId: string) {
  const existing = await prisma.whatsAppIntegration.findUnique({
    where: { businessId_provider: { businessId, provider: WhatsAppProvider.META } },
  });
  if (env.WHATSAPP_PROVIDER_MODE === "mock") {
    if (existing) {
      if (existing.status === WhatsAppIntegrationStatus.MOCK_CONNECTED || existing.status === WhatsAppIntegrationStatus.CONNECTED) return existing;
      return prisma.whatsAppIntegration.update({
        where: { id: existing.id },
        data: { status: WhatsAppIntegrationStatus.MOCK_CONNECTED, connectedAt: new Date(), disconnectedAt: null },
      });
    }
    return prisma.whatsAppIntegration.create({
      data: {
        businessId,
        provider: WhatsAppProvider.META,
        phoneNumberId: `mock-${businessId}`,
        status: WhatsAppIntegrationStatus.MOCK_CONNECTED,
        connectedAt: new Date(),
      },
    });
  }
  if (!existing || existing.status !== WhatsAppIntegrationStatus.CONNECTED) {
    throw new AppError(409, "WhatsApp is not connected for this business.", "WHATSAPP_NOT_CONNECTED");
  }
  return existing;
}

export class MockWhatsAppProvider implements WhatsAppProviderClient {
  async sendTextMessage(params: SendWhatsAppTextParams): Promise<WhatsAppSendResult> {
    if (env.MOCK_WHATSAPP_FORCE_FAILURE) {
      return { success: false, provider: "MOCK_WHATSAPP", error: "Mock WhatsApp provider failure" };
    }
    return {
      success: true,
      provider: "MOCK_WHATSAPP",
      providerMessageId: `mock_whatsapp_msg_${params.messageId}`,
      raw: { simulated: true },
    };
  }
}

export class MetaWhatsAppProvider implements WhatsAppProviderClient {
  async sendTextMessage(params: SendWhatsAppTextParams): Promise<WhatsAppSendResult> {
    if (!env.META_WHATSAPP_ACCESS_TOKEN) {
      return { success: false, provider: "META_WHATSAPP", error: "Meta WhatsApp provider is not configured" };
    }
    try {
      const response = await fetch(`https://graph.facebook.com/${env.META_API_VERSION}/${params.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.META_WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: params.to,
          type: "text",
          text: { body: params.message },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await response.json().catch(() => null) as { messages?: Array<{ id?: string }>; error?: { message?: string } } | null;
      const providerMessageId = raw?.messages?.[0]?.id;
      if (!response.ok || !providerMessageId) {
        return { success: false, provider: "META_WHATSAPP", error: raw?.error?.message ?? "Meta WhatsApp send failed", raw };
      }
      return { success: true, provider: "META_WHATSAPP", providerMessageId, raw };
    } catch (error) {
      console.error("Meta WhatsApp send failed", error);
      return { success: false, provider: "META_WHATSAPP", error: "Meta WhatsApp provider request failed" };
    }
  }
}

export const whatsappProvider: WhatsAppProviderClient = env.WHATSAPP_PROVIDER_MODE === "live"
  ? new MetaWhatsAppProvider()
  : new MockWhatsAppProvider();
