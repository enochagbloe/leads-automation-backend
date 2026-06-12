import { WhatsAppIntegration, WhatsAppIntegrationStatus, WhatsAppProvider } from "@prisma/client";

export function metaCredentialExpiresAt(integration: WhatsAppIntegration) {
  if (integration.provider !== WhatsAppProvider.META || integration.status !== WhatsAppIntegrationStatus.CONNECTED) {
    return null;
  }
  if (!integration.metadata || typeof integration.metadata !== "object" || Array.isArray(integration.metadata)) {
    return null;
  }

  const expiresAt = integration.metadata.credentialExpiresAt;
  if (typeof expiresAt !== "string") return null;

  const expiryTime = Date.parse(expiresAt);
  return Number.isFinite(expiryTime) ? expiryTime : null;
}

export function isMetaCredentialExpired(integration: WhatsAppIntegration, now = Date.now()) {
  const expiryTime = metaCredentialExpiresAt(integration);
  return expiryTime !== null && expiryTime <= now;
}
