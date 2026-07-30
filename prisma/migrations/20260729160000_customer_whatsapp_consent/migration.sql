ALTER TYPE "LeadActivityAction"
ADD VALUE IF NOT EXISTS 'CUSTOMER_WHATSAPP_OPTED_OUT';

ALTER TYPE "LeadActivityAction"
ADD VALUE IF NOT EXISTS 'CUSTOMER_WHATSAPP_OPTED_IN';

ALTER TABLE "Lead"
ADD COLUMN "whatsAppOptedOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "whatsAppConsentUpdatedAt" TIMESTAMP(3),
ADD COLUMN "whatsAppConsentSourceMessageId" TEXT;

WITH "contactSignals" AS (
  SELECT
    "message"."businessId",
    "message"."leadId",
    "message"."id" AS "messageId",
    "message"."createdAt",
    CASE
      WHEN "message"."content" ~* '\m(stop|cease) (all )?(messages|messaging|contacting|texting|calling|follow-ups?)\M'
        OR "message"."content" ~* '\m(do not|don.?t|never) (message|contact|text|call|follow up) me\M'
        OR "message"."content" ~* '\m(no more) (messages|texts|calls|follow-ups?)\M'
        OR "message"."content" ~* '\m(unsubscribe|remove my (number|phone))\M'
        OR "message"."content" ~* '\m(withdraw|revoke) (my )?consent\M'
        OR "message"."content" ~* '\mI (do not|don.?t) consent to (messages|messaging|being contacted)\M'
        OR "message"."content" ~* '^\s*(I(''m| am) )?not interested[.!]?\s*$'
        THEN true
      WHEN "message"."content" ~* '\m(resubscribe|subscribe me|opt me in)\M'
        OR "message"."content" ~* '\m(you can|please|may) (message|contact|text|call|follow up)( me)? again\M'
        OR "message"."content" ~* '\m(start|resume) (messages|messaging|contact|follow-ups?)\M'
        OR "message"."content" ~* '\mI (consent|agree) to (messages|messaging|being contacted)\M'
        THEN false
      ELSE NULL
    END AS "optedOut"
  FROM "Message" AS "message"
  INNER JOIN "Conversation" AS "conversation"
    ON "conversation"."id" = "message"."conversationId"
    AND "conversation"."businessId" = "message"."businessId"
  WHERE "message"."senderType" = 'CUSTOMER'
    AND "message"."direction" = 'INBOUND'
    AND "conversation"."channel" = 'WHATSAPP'
),
"latestContactSignal" AS (
  SELECT DISTINCT ON ("businessId", "leadId")
    "businessId",
    "leadId",
    "messageId",
    "createdAt",
    "optedOut"
  FROM "contactSignals"
  WHERE "optedOut" IS NOT NULL
  ORDER BY "businessId", "leadId", "createdAt" DESC, "messageId" DESC
)
UPDATE "Lead" AS "lead"
SET
  "whatsAppOptedOut" = "signal"."optedOut",
  "whatsAppConsentUpdatedAt" = "signal"."createdAt",
  "whatsAppConsentSourceMessageId" = "signal"."messageId"
FROM "latestContactSignal" AS "signal"
WHERE "lead"."id" = "signal"."leadId"
  AND "lead"."businessId" = "signal"."businessId";

CREATE INDEX "Lead_businessId_whatsAppOptedOut_idx"
ON "Lead"("businessId", "whatsAppOptedOut");
