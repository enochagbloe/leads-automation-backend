import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  ConversationChannel,
  MessageDirection,
  Prisma,
  WhatsAppIntegration,
  WhatsAppIntegrationStatus,
  WhatsAppProvider,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { encryptCredential } from "../utils/credential-encryption";
import { AuditInput, auditService } from "./audit.service";
import { cacheService } from "./cache.service";
import { realtimeService } from "./realtime.service";
import { subscriptionService } from "./subscription.service";

export type WhatsAppConnectionActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

const ACTIVE_STATUSES: WhatsAppIntegrationStatus[] = [
  WhatsAppIntegrationStatus.CONNECTING,
  WhatsAppIntegrationStatus.CONNECTED,
  WhatsAppIntegrationStatus.MOCK_CONNECTED,
];
const CONNECTED_STATUSES: WhatsAppIntegrationStatus[] = [
  WhatsAppIntegrationStatus.CONNECTED,
  WhatsAppIntegrationStatus.MOCK_CONNECTED,
];
const STATUS_TTL = 60;
const HEALTH_TTL = 30;

function providerLabel(provider: WhatsAppProvider) {
  return provider === WhatsAppProvider.MOCK_WHATSAPP ? "MOCK_WHATSAPP" : "META_WHATSAPP";
}

function publicStatus(status: WhatsAppIntegrationStatus) {
  if (status === WhatsAppIntegrationStatus.MOCK_CONNECTED) return WhatsAppIntegrationStatus.CONNECTED;
  if (status === WhatsAppIntegrationStatus.DISCONNECTED) return WhatsAppIntegrationStatus.DEACTIVATED;
  return status;
}

function isConnected(integration?: WhatsAppIntegration | null) {
  return Boolean(integration && CONNECTED_STATUSES.includes(integration.status));
}

function canSendMessages(integration?: WhatsAppIntegration | null) {
  if (!integration || !isConnected(integration)) return false;
  if (integration.provider === WhatsAppProvider.MOCK_WHATSAPP || integration.status === WhatsAppIntegrationStatus.MOCK_CONNECTED) {
    return env.WHATSAPP_PROVIDER_MODE === "mock";
  }
  return Boolean(integration.accessTokenEncrypted);
}

function safeStatus(integration?: WhatsAppIntegration | null) {
  if (!integration) return { status: WhatsAppIntegrationStatus.NOT_CONNECTED, automationEnabled: false, canSendMessages: false };
  const connected = isConnected(integration);
  return {
    status: publicStatus(integration.status),
    provider: providerLabel(integration.provider),
    displayPhoneNumber: integration.displayPhoneNumber,
    phoneNumberId: integration.phoneNumberId,
    wabaId: integration.wabaId,
    connectedAt: integration.connectedAt,
    deactivatedAt: integration.deactivatedAt ?? integration.disconnectedAt,
    automationEnabled: connected && integration.automationEnabled,
    canSendMessages: canSendMessages(integration),
    lastHealthCheckAt: integration.lastHealthCheckAt,
    lastErrorCode: integration.lastErrorCode,
    lastErrorMessage: integration.lastErrorMessage,
  };
}

async function currentIntegration(businessId: string) {
  return prisma.whatsAppIntegration.findFirst({
    where: { businessId },
    orderBy: [{ createdAt: "desc" }, { updatedAt: "desc" }],
  });
}

async function activeIntegration(businessId: string) {
  return prisma.whatsAppIntegration.findFirst({
    where: { businessId, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
}

async function invalidateConnectionCaches(businessId: string) {
  await Promise.all([
    cacheService.del(`business:${businessId}:knowledge-preview`),
    cacheService.del(`business:${businessId}:whatsapp:status`),
    cacheService.del(`business:${businessId}:whatsapp:health`),
    cacheService.delByPattern(`business:${businessId}:profile*`),
    cacheService.delByPattern(`business:${businessId}:setup-status*`),
    cacheService.delByPattern(`business:${businessId}:conversations:list:*`),
    cacheService.delByPattern(`business:${businessId}:conversations:detail:*`),
  ]);
}

function publishConnection(
  type: "whatsapp.connection.updated" | "whatsapp.connection.deactivated" | "whatsapp.connection.error",
  businessId: string,
  integration: WhatsAppIntegration,
) {
  realtimeService.publish({ type, businessId, payload: safeStatus(integration) });
}

function auditMetadata(actor: WhatsAppConnectionActor, integration: WhatsAppIntegration, extra: Record<string, Prisma.JsonValue> = {}) {
  return {
    businessId: actor.businessId,
    actorUserId: actor.userId,
    actorMembershipId: actor.membershipId,
    integrationId: integration.id,
    displayPhoneNumber: integration.displayPhoneNumber,
    provider: providerLabel(integration.provider),
    status: publicStatus(integration.status),
    ...extra,
  } satisfies Prisma.InputJsonObject;
}

async function ensureCanConnect(actor: WhatsAppConnectionActor) {
  await subscriptionService.getCurrentRecord(actor.businessAccountId);
  const existing = await activeIntegration(actor.businessId);
  if (existing) {
    const code = isConnected(existing) ? "WHATSAPP_ALREADY_CONNECTED" : "WHATSAPP_NUMBER_LIMIT_REACHED";
    const message = isConnected(existing)
      ? "WhatsApp is already connected for this business."
      : "Your current plan allows one WhatsApp number per business.";
    throw new AppError(409, message, code);
  }
}

type MetaTokenExchange = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string; code?: number };
};

type MetaPhoneDetails = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  error?: { message?: string; code?: number };
};

type MetaPhoneList = {
  data?: Array<{ id?: string }>;
  error?: { message?: string; code?: number };
};

async function metaGet<T>(path: string, accessToken: string) {
  try {
    const response = await fetch(`https://graph.facebook.com/${env.META_API_VERSION}/${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as T | null;
    if (!response.ok || !body) {
      const providerError = body as { error?: { message?: string; code?: number } } | null;
      throw new AppError(422, "Meta could not verify ownership of this WhatsApp number.", "WHATSAPP_PROVIDER_OWNERSHIP_VERIFICATION_FAILED", {
        providerCode: providerError?.error?.code,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, "Meta ownership verification is temporarily unavailable.", "WHATSAPP_PROVIDER_UNAVAILABLE");
  }
}

async function exchangeMetaAuthorizationCode(authorizationCode: string) {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    throw new AppError(409, "Meta provider exchange is not configured.", "WHATSAPP_PROVIDER_CONFIG_MISSING");
  }
  try {
    const response = await fetch(`https://graph.facebook.com/${env.META_API_VERSION}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.META_APP_ID,
        client_secret: env.META_APP_SECRET,
        code: authorizationCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as MetaTokenExchange | null;
    if (!response.ok || !body?.access_token) {
      throw new AppError(422, "Meta could not complete the WhatsApp authorization.", "WHATSAPP_PROVIDER_AUTHORIZATION_FAILED", {
        providerCode: body?.error?.code,
      });
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, "Meta authorization is temporarily unavailable.", "WHATSAPP_PROVIDER_UNAVAILABLE");
  }
}

async function verifyMetaOwnership(input: { phoneNumberId: string; wabaId: string; accessToken: string }) {
  const phone = await metaGet<MetaPhoneDetails>(
    `${encodeURIComponent(input.phoneNumberId)}?fields=id,display_phone_number,verified_name`,
    input.accessToken,
  );
  if (phone.id !== input.phoneNumberId) {
    throw new AppError(422, "Meta could not verify ownership of this WhatsApp number.", "WHATSAPP_PROVIDER_OWNERSHIP_VERIFICATION_FAILED");
  }
  if (input.wabaId) {
    const phoneNumbers = await metaGet<MetaPhoneList>(
      `${encodeURIComponent(input.wabaId)}/phone_numbers?fields=id&limit=100`,
      input.accessToken,
    );
    if (!phoneNumbers.data?.some((number) => number.id === input.phoneNumberId)) {
      throw new AppError(422, "The WhatsApp number does not belong to the supplied WhatsApp Business Account.", "WHATSAPP_PROVIDER_OWNERSHIP_VERIFICATION_FAILED");
    }
  }
  return phone;
}

export const whatsappConnectionService = {
  async status(actor: WhatsAppConnectionActor) {
    const key = `business:${actor.businessId}:whatsapp:status`;
    const cached = await cacheService.get<ReturnType<typeof safeStatus>>(key);
    if (cached) return cached;
    const result = safeStatus(await currentIntegration(actor.businessId));
    await cacheService.set(key, result, STATUS_TTL);
    return result;
  },

  async start(
    actor: WhatsAppConnectionActor,
    input: { provider: "META_WHATSAPP" | "MOCK_WHATSAPP"; displayPhoneNumber?: string },
    context: Omit<AuditInput, "action">,
  ) {
    await ensureCanConnect(actor);
    const mock = input.provider === "MOCK_WHATSAPP";
    if (mock && env.WHATSAPP_PROVIDER_MODE === "live") {
      throw new AppError(409, "Mock WhatsApp connections are disabled in live provider mode.", "WHATSAPP_PROVIDER_CONFIG_MISSING");
    }
    if (!mock && env.WHATSAPP_PROVIDER_MODE !== "live") {
      throw new AppError(409, "Live Meta WhatsApp provider configuration is missing.", "WHATSAPP_PROVIDER_CONFIG_MISSING");
    }
    const integration = await prisma.whatsAppIntegration.create({
      data: {
        businessId: actor.businessId,
        provider: mock ? WhatsAppProvider.MOCK_WHATSAPP : WhatsAppProvider.META,
        phoneNumberId: mock ? `mock-${actor.businessId}-${crypto.randomUUID()}` : `pending-${crypto.randomUUID()}`,
        displayPhoneNumber: input.displayPhoneNumber,
        status: mock ? WhatsAppIntegrationStatus.MOCK_CONNECTED : WhatsAppIntegrationStatus.CONNECTING,
        automationEnabled: mock,
        connectedAt: mock ? new Date() : null,
        metadata: { connectionMode: mock ? "MOCK" : "LIVE" },
      },
    }).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "Your current plan allows one WhatsApp number per business.", "WHATSAPP_NUMBER_LIMIT_REACHED");
      }
      throw error;
    });
    await Promise.all([
      auditService.log({ ...context, action: AuditAction.WHATSAPP_CONNECTION_STARTED, businessId: actor.businessId, userId: actor.userId, metadata: auditMetadata(actor, integration) }),
      ...(mock ? [auditService.log({ ...context, action: AuditAction.WHATSAPP_CONNECTED, businessId: actor.businessId, userId: actor.userId, metadata: auditMetadata(actor, integration) })] : []),
      invalidateConnectionCaches(actor.businessId),
    ]);
    publishConnection("whatsapp.connection.updated", actor.businessId, integration);
    return {
      ...safeStatus(integration),
      message: mock ? "Mock WhatsApp connected." : "WhatsApp connection started.",
      nextStep: mock ? null : "COMPLETE_PROVIDER_CONNECTION",
    };
  },

  async complete(
    actor: WhatsAppConnectionActor,
    input: {
      provider: "META_WHATSAPP";
      phoneNumberId: string;
      displayPhoneNumber?: string;
      wabaId: string;
      businessAccountId?: string;
      authorizationCode: string;
      metadata?: Prisma.InputJsonValue;
    },
    context: Omit<AuditInput, "action">,
  ) {
    await subscriptionService.getCurrentRecord(actor.businessAccountId);
    if (env.WHATSAPP_PROVIDER_MODE !== "live") {
      throw new AppError(409, "Live Meta WhatsApp provider configuration is missing.", "WHATSAPP_PROVIDER_CONFIG_MISSING");
    }
    const active = await activeIntegration(actor.businessId);
    if (active && isConnected(active)) throw new AppError(409, "WhatsApp is already connected for this business.", "WHATSAPP_ALREADY_CONNECTED");
    if (!active || active.status !== WhatsAppIntegrationStatus.CONNECTING) {
      throw new AppError(409, "Start the WhatsApp connection before completing it.", "WHATSAPP_CONNECTION_NOT_STARTED");
    }
    const { accessToken, expiresIn } = await exchangeMetaAuthorizationCode(input.authorizationCode);
    const verifiedPhone = await verifyMetaOwnership({
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      accessToken,
    });
    const integration = await prisma.$transaction(async (tx) => {
      return tx.whatsAppIntegration.update({
        where: { id: active.id },
        data: {
          provider: WhatsAppProvider.META,
          phoneNumberId: input.phoneNumberId,
          displayPhoneNumber: verifiedPhone.display_phone_number ?? input.displayPhoneNumber,
          wabaId: input.wabaId,
          businessAccountId: input.businessAccountId,
          accessTokenEncrypted: encryptCredential(accessToken),
          metadata: {
            ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}),
            ownershipVerifiedAt: new Date().toISOString(),
            credentialExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
            verifiedName: verifiedPhone.verified_name ?? null,
          },
          status: WhatsAppIntegrationStatus.CONNECTED,
          automationEnabled: true,
          connectedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
    }).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError(409, "This WhatsApp number is already connected.", "WHATSAPP_ALREADY_CONNECTED");
      }
      throw error;
    });
    await Promise.all([
      auditService.log({ ...context, action: AuditAction.WHATSAPP_CONNECTED, businessId: actor.businessId, userId: actor.userId, metadata: auditMetadata(actor, integration) }),
      invalidateConnectionCaches(actor.businessId),
    ]);
    publishConnection("whatsapp.connection.updated", actor.businessId, integration);
    return safeStatus(integration);
  },

  async deactivate(actor: WhatsAppConnectionActor, reason: string | undefined, context: Omit<AuditInput, "action">) {
    const active = await activeIntegration(actor.businessId);
    if (!active) throw new AppError(404, "WhatsApp connection not found.", "WHATSAPP_CONNECTION_NOT_FOUND");
    const now = new Date();
    const integration = await prisma.$transaction(async (tx) => {
      const updated = await tx.whatsAppIntegration.update({
        where: { id: active.id },
        data: {
          status: WhatsAppIntegrationStatus.DEACTIVATED,
          automationEnabled: false,
          deactivatedAt: now,
          disconnectedAt: now,
          metadata: { reason: reason ?? null },
        },
      });
      await tx.conversation.updateMany({
        where: { businessId: actor.businessId, channel: ConversationChannel.WHATSAPP, deletedAt: null },
        data: { aiEnabled: false },
      });
      return updated;
    });
    await Promise.all([
      auditService.log({
        ...context,
        action: AuditAction.WHATSAPP_DEACTIVATED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: auditMetadata(actor, integration, { reason: reason ?? null }),
      }),
      invalidateConnectionCaches(actor.businessId),
    ]);
    publishConnection("whatsapp.connection.deactivated", actor.businessId, integration);
    return safeStatus(integration);
  },

  async startChange(actor: WhatsAppConnectionActor, context: Omit<AuditInput, "action">) {
    const current = await activeIntegration(actor.businessId);
    if (!current) throw new AppError(404, "WhatsApp connection not found.", "WHATSAPP_CONNECTION_NOT_FOUND");
    const updated = await prisma.whatsAppIntegration.update({
      where: { id: current.id },
      data: { status: WhatsAppIntegrationStatus.DEACTIVATED, automationEnabled: false, deactivatedAt: new Date(), disconnectedAt: new Date() },
    });
    await prisma.conversation.updateMany({
      where: { businessId: actor.businessId, channel: ConversationChannel.WHATSAPP, deletedAt: null },
      data: { aiEnabled: false },
    });
    await Promise.all([
      auditService.log({
        ...context,
        action: AuditAction.WHATSAPP_NUMBER_CHANGED,
        businessId: actor.businessId,
        userId: actor.userId,
        metadata: auditMetadata(actor, updated, { previousIntegrationId: current.id }),
      }),
      invalidateConnectionCaches(actor.businessId),
    ]);
    publishConnection("whatsapp.connection.deactivated", actor.businessId, updated);
    return { ...safeStatus(updated), message: "Previous WhatsApp number deactivated.", nextStep: "START_NEW_CONNECTION" };
  },

  async health(actor: WhatsAppConnectionActor) {
    const key = `business:${actor.businessId}:whatsapp:health`;
    const cached = await cacheService.get<Record<string, unknown>>(key);
    if (cached) return cached;
    const integration = await currentIntegration(actor.businessId);
    if (!integration) {
      const result = { status: WhatsAppIntegrationStatus.NOT_CONNECTED, canReceiveMessages: false, canSendMessages: false, automationEnabled: false };
      await cacheService.set(key, result, HEALTH_TTL);
      return result;
    }
    const [lastInbound, lastOutbound, updated] = await Promise.all([
      prisma.message.findFirst({
        where: { businessId: actor.businessId, direction: MessageDirection.INBOUND, conversation: { channel: ConversationChannel.WHATSAPP } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.message.findFirst({
        where: { businessId: actor.businessId, direction: MessageDirection.OUTBOUND, conversation: { channel: ConversationChannel.WHATSAPP } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.whatsAppIntegration.update({ where: { id: integration.id }, data: { lastHealthCheckAt: new Date() } }),
    ]);
    const connected = isConnected(updated);
    const result = {
      status: publicStatus(updated.status),
      canReceiveMessages: connected,
      canSendMessages: canSendMessages(updated),
      automationEnabled: connected && updated.automationEnabled,
      lastInboundMessageAt: lastInbound?.createdAt ?? null,
      lastOutboundMessageAt: lastOutbound?.createdAt ?? null,
      lastHealthCheckAt: updated.lastHealthCheckAt,
      lastErrorCode: updated.lastErrorCode,
      lastErrorMessage: updated.lastErrorMessage,
    };
    await cacheService.set(key, result, HEALTH_TTL);
    return result;
  },
};
