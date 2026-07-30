import {
  FollowUpJobStatus,
  LeadActivityAction,
  Prisma,
} from "@prisma/client";

export type CustomerWhatsAppConsentSignal = "OPT_OUT" | "OPT_IN";

function normalizeConsentText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectCustomerWhatsAppConsentSignal(
  value: string | null | undefined,
): CustomerWhatsAppConsentSignal | null {
  if (!value) return null;
  const text = normalizeConsentText(value);
  const optIn = [
    /\b(?:resubscribe|subscribe me|opt me in)\b/i,
    /\b(?:you can|please|may)\s+(?:message|contact|text|call|follow up)(?:\s+me)?\s+again\b/i,
    /\b(?:start|resume)\s+(?:messages|messaging|contact|follow[- ]?ups?)\b/i,
    /\bi\s+(?:consent|agree)\s+to\s+(?:messages|messaging|being contacted)\b/i,
  ].some((pattern) => pattern.test(text));
  const optOut = [
    /\b(?:stop|cease)\s+(?:all\s+)?(?:messages|messaging|contacting|texting|calling|follow[- ]?ups?)\b/i,
    /\b(?:do not|don't|dont|never)\s+(?:message|contact|text|call|follow up)\s+me(?:\s+again)?\b/i,
    /\bno more\s+(?:messages|texts|calls|follow[- ]?ups?)\b/i,
    /\bunsubscribe\b/i,
    /\bremove\s+my\s+(?:number|phone)\b/i,
    /\b(?:withdraw|revoke)\s+(?:my\s+)?consent\b/i,
    /\bi\s+(?:do not|don't|dont)\s+consent\s+to\s+(?:messages|messaging|being contacted)\b/i,
    /^\s*(?:i(?:'m| am)\s+)?not interested[.!]?\s*$/i,
  ].some((pattern) => pattern.test(text));

  // A stop request wins when a message contains conflicting consent language.
  if (optOut) return "OPT_OUT";
  return optIn ? "OPT_IN" : null;
}

export async function persistCustomerWhatsAppConsentSignal(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    leadId: string;
    conversationId: string;
    messageId: string;
    messageText: string;
    messageCreatedAt: Date;
  },
) {
  const signal = detectCustomerWhatsAppConsentSignal(input.messageText);
  if (!signal) return null;

  const changed = await tx.lead.updateMany({
    where: {
      id: input.leadId,
      businessId: input.businessId,
      OR: [
        { whatsAppConsentUpdatedAt: null },
        { whatsAppConsentUpdatedAt: { lte: input.messageCreatedAt } },
      ],
    },
    data: {
      whatsAppOptedOut: signal === "OPT_OUT",
      whatsAppConsentUpdatedAt: input.messageCreatedAt,
      whatsAppConsentSourceMessageId: input.messageId,
    },
  });
  if (changed.count !== 1) return null;

  if (signal === "OPT_OUT") {
    await tx.followUpJob.updateMany({
      where: {
        businessId: input.businessId,
        leadId: input.leadId,
        status: FollowUpJobStatus.SCHEDULED,
      },
      data: {
        status: FollowUpJobStatus.CANCELLED,
        cancelReason: "CUSTOMER_OPTED_OUT",
        processingStartedAt: null,
      },
    });
  }

  await tx.leadActivity.create({
    data: {
      businessId: input.businessId,
      leadId: input.leadId,
      action: signal === "OPT_OUT"
        ? LeadActivityAction.CUSTOMER_WHATSAPP_OPTED_OUT
        : LeadActivityAction.CUSTOMER_WHATSAPP_OPTED_IN,
      metadata: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        signal,
      },
    },
  });
  return signal;
}
