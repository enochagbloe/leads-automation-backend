import { WhatsAppIntegration, WhatsAppIntegrationStatus, WhatsAppProvider } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { decryptCredential } from "../utils/credential-encryption";
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
  const existing = await prisma.whatsAppIntegration.findFirst({
    where: { businessId },
    orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
  });
  if (existing?.status === WhatsAppIntegrationStatus.DEACTIVATED || existing?.status === WhatsAppIntegrationStatus.DISCONNECTED) {
    throw new AppError(409, "WhatsApp has been deactivated for this business.", "WHATSAPP_DEACTIVATED");
  }
  if (
    !existing
    || (existing.status !== WhatsAppIntegrationStatus.CONNECTED && existing.status !== WhatsAppIntegrationStatus.MOCK_CONNECTED)
  ) {
    throw new AppError(409, "WhatsApp is not connected for this business.", "WHATSAPP_NOT_CONNECTED");
  }
  if (env.WHATSAPP_PROVIDER_MODE === "live" && existing.status !== WhatsAppIntegrationStatus.CONNECTED) {
    throw new AppError(409, "WhatsApp is not connected for this business.", "WHATSAPP_NOT_CONNECTED");
  }
  if (existing.provider === WhatsAppProvider.MOCK_WHATSAPP && env.WHATSAPP_PROVIDER_MODE === "live") {
    throw new AppError(409, "WhatsApp is not connected for this business.", "WHATSAPP_NOT_CONNECTED");
  }
  if (
    existing.provider === WhatsAppProvider.META
    && existing.status === WhatsAppIntegrationStatus.CONNECTED
    && !existing.accessTokenEncrypted
  ) {
    throw new AppError(409, "WhatsApp provider credentials are missing for this business.", "WHATSAPP_PROVIDER_CONFIG_MISSING");
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
  constructor(private readonly accessToken: string) {}

  async sendTextMessage(params: SendWhatsAppTextParams): Promise<WhatsAppSendResult> {
    try {
      const response = await fetch(`https://graph.facebook.com/${env.META_API_VERSION}/${params.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
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

export async function sendWhatsAppText(integration: WhatsAppIntegration, params: SendWhatsAppTextParams): Promise<WhatsAppSendResult> {
  if (integration.provider === WhatsAppProvider.MOCK_WHATSAPP || integration.status === WhatsAppIntegrationStatus.MOCK_CONNECTED) {
    if (env.WHATSAPP_PROVIDER_MODE === "live") {
      throw new AppError(409, "Mock WhatsApp connections are disabled in live provider mode.", "WHATSAPP_NOT_CONNECTED");
    }
    return new MockWhatsAppProvider().sendTextMessage(params);
  }
  if (!integration.accessTokenEncrypted) {
    throw new AppError(409, "WhatsApp provider credentials are missing for this business.", "WHATSAPP_PROVIDER_CONFIG_MISSING");
  }
  try {
    return new MetaWhatsAppProvider(decryptCredential(integration.accessTokenEncrypted)).sendTextMessage(params);
  } catch (error) {
    console.error("Stored Meta WhatsApp credential could not be used", { businessId: integration.businessId, integrationId: integration.id, error });
    return { success: false, provider: "META_WHATSAPP", error: "Meta WhatsApp provider credential is unavailable" };
  }
}
