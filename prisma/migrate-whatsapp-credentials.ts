import { WhatsAppIntegrationStatus, WhatsAppProvider } from "@prisma/client";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { decryptCredential, encryptCredential } from "../src/utils/credential-encryption";

async function main() {
  if (!env.WHATSAPP_CREDENTIAL_ENCRYPTION_KEY) {
    throw new Error("WHATSAPP_CREDENTIAL_ENCRYPTION_KEY is required");
  }
  const integrations = await prisma.whatsAppIntegration.findMany({
    where: { provider: WhatsAppProvider.META, status: WhatsAppIntegrationStatus.CONNECTED },
    select: { id: true, businessId: true, phoneNumberId: true, accessTokenEncrypted: true },
  });
  let migrated = 0;
  let current = 0;
  const reconnectRequired: Array<{ integrationId: string; businessId: string }> = [];

  for (const integration of integrations) {
    if (integration.accessTokenEncrypted) {
      try {
        const credential = decryptCredential(integration.accessTokenEncrypted);
        if (!credential.needsReEncryption) {
          current += 1;
          continue;
        }
        await prisma.whatsAppIntegration.update({
          where: { id: integration.id },
          data: { accessTokenEncrypted: encryptCredential(credential.plaintext) },
        });
        migrated += 1;
      } catch {
        reconnectRequired.push({ integrationId: integration.id, businessId: integration.businessId });
      }
      continue;
    }
    if (env.META_WHATSAPP_ACCESS_TOKEN && env.META_WHATSAPP_PHONE_NUMBER_ID === integration.phoneNumberId) {
      await prisma.whatsAppIntegration.update({
        where: { id: integration.id },
        data: { accessTokenEncrypted: encryptCredential(env.META_WHATSAPP_ACCESS_TOKEN) },
      });
      migrated += 1;
      continue;
    }
    reconnectRequired.push({ integrationId: integration.id, businessId: integration.businessId });
  }

  console.info("WhatsApp credential migration complete", {
    connectedIntegrations: integrations.length,
    migrated,
    alreadyCurrent: current,
    reconnectRequired,
  });
}

main()
  .catch((error) => {
    console.error("WhatsApp credential migration failed", error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
