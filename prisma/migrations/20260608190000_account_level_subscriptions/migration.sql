ALTER TABLE "Plan" ADD COLUMN "maxBusinesses" INTEGER;
UPDATE "Plan" SET "maxBusinesses" = CASE "code"
  WHEN 'BASIC' THEN 1
  WHEN 'PLUS' THEN 5
  WHEN 'PREMIUM' THEN 10
END;

CREATE TABLE "BusinessAccount" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Business" ADD COLUMN "businessAccountId" TEXT;

INSERT INTO "BusinessAccount" ("id", "name", "ownerId", "createdAt", "updatedAt")
SELECT
  'acct_' || md5("ownerId"),
  MIN("name") || ' Workspace',
  "ownerId",
  MIN("createdAt"),
  CURRENT_TIMESTAMP
FROM "Business"
GROUP BY "ownerId";

UPDATE "Business"
SET "businessAccountId" = 'acct_' || md5("ownerId");

ALTER TABLE "Business" ALTER COLUMN "businessAccountId" SET NOT NULL;

CREATE TABLE "Subscription_new" (
  "id" TEXT NOT NULL,
  "businessAccountId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "trialEndsAt" TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3) NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_new_pkey" PRIMARY KEY ("id")
);

INSERT INTO "Subscription_new" (
  "id", "businessAccountId", "planId", "status", "startsAt", "trialEndsAt",
  "currentPeriodStart", "currentPeriodEnd", "cancelledAt", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (b."businessAccountId")
  s."id", b."businessAccountId", s."planId", s."status", s."startsAt", s."trialEndsAt",
  s."currentPeriodStart", s."currentPeriodEnd", s."cancelledAt", s."createdAt", s."updatedAt"
FROM "Subscription" s
JOIN "Business" b ON b."id" = s."businessId"
JOIN "Plan" p ON p."id" = s."planId"
ORDER BY b."businessAccountId", p."priceMonthly" DESC, s."createdAt" DESC;

CREATE TABLE "AccountUsageRecord" (
  "id" TEXT NOT NULL,
  "businessAccountId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "businessesCount" INTEGER NOT NULL DEFAULT 1,
  "conversationsUsed" INTEGER NOT NULL DEFAULT 0,
  "aiRepliesUsed" INTEGER NOT NULL DEFAULT 0,
  "staffCount" INTEGER NOT NULL DEFAULT 1,
  "servicesCount" INTEGER NOT NULL DEFAULT 0,
  "appointmentsUsed" INTEGER NOT NULL DEFAULT 0,
  "knowledgeItemsCount" INTEGER NOT NULL DEFAULT 0,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountUsageRecord_pkey" PRIMARY KEY ("id")
);

INSERT INTO "AccountUsageRecord" (
  "id", "businessAccountId", "subscriptionId", "businessesCount",
  "conversationsUsed", "aiRepliesUsed", "staffCount", "servicesCount",
  "appointmentsUsed", "knowledgeItemsCount", "periodStart", "periodEnd", "createdAt", "updatedAt"
)
SELECT
  'ausg_' || md5(sn."businessAccountId" || sn."id"),
  sn."businessAccountId",
  sn."id",
  (SELECT COUNT(*) FROM "Business" bc WHERE bc."businessAccountId" = sn."businessAccountId" AND bc."deletedAt" IS NULL),
  COALESCE(SUM(u."conversationsUsed"), 0),
  COALESCE(SUM(u."aiRepliesUsed"), 0),
  (SELECT COUNT(DISTINCT bm."userId") FROM "BusinessMember" bm JOIN "Business" mb ON mb."id" = bm."businessId" WHERE mb."businessAccountId" = sn."businessAccountId" AND bm."status" = 'ACTIVE'),
  COALESCE(SUM(u."servicesCount"), 0),
  COALESCE(SUM(u."appointmentsUsed"), 0),
  COALESCE(SUM(u."knowledgeItemsCount"), 0),
  sn."currentPeriodStart",
  sn."currentPeriodEnd",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Subscription_new" sn
LEFT JOIN "Business" b ON b."businessAccountId" = sn."businessAccountId"
LEFT JOIN "UsageRecord" u ON u."businessId" = b."id"
GROUP BY sn."businessAccountId", sn."id", sn."currentPeriodStart", sn."currentPeriodEnd";

CREATE TABLE "BusinessUsageRecord" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "conversationsUsed" INTEGER NOT NULL DEFAULT 0,
  "aiRepliesUsed" INTEGER NOT NULL DEFAULT 0,
  "appointmentsUsed" INTEGER NOT NULL DEFAULT 0,
  "leadsCreated" INTEGER NOT NULL DEFAULT 0,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessUsageRecord_pkey" PRIMARY KEY ("id")
);

INSERT INTO "BusinessUsageRecord" (
  "id", "businessId", "conversationsUsed", "aiRepliesUsed", "appointmentsUsed",
  "leadsCreated", "periodStart", "periodEnd", "createdAt", "updatedAt"
)
SELECT
  'busg_' || md5(b."id" || sn."id"),
  b."id",
  COALESCE(SUM(u."conversationsUsed"), 0),
  COALESCE(SUM(u."aiRepliesUsed"), 0),
  COALESCE(SUM(u."appointmentsUsed"), 0),
  (SELECT COUNT(*) FROM "Lead" l WHERE l."businessId" = b."id" AND l."deletedAt" IS NULL),
  sn."currentPeriodStart",
  sn."currentPeriodEnd",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Business" b
JOIN "Subscription_new" sn ON sn."businessAccountId" = b."businessAccountId"
LEFT JOIN "UsageRecord" u ON u."businessId" = b."id"
GROUP BY b."id", sn."id", sn."currentPeriodStart", sn."currentPeriodEnd";

DROP TABLE "UsageRecord";
DROP TABLE "Subscription";
ALTER TABLE "Subscription_new" RENAME TO "Subscription";

CREATE INDEX "BusinessAccount_ownerId_idx" ON "BusinessAccount"("ownerId");
CREATE INDEX "Business_businessAccountId_idx" ON "Business"("businessAccountId");
CREATE INDEX "Subscription_businessAccountId_status_idx" ON "Subscription"("businessAccountId", "status");
CREATE UNIQUE INDEX "AccountUsageRecord_subscriptionId_periodStart_key" ON "AccountUsageRecord"("subscriptionId", "periodStart");
CREATE INDEX "AccountUsageRecord_businessAccountId_periodStart_idx" ON "AccountUsageRecord"("businessAccountId", "periodStart");
CREATE UNIQUE INDEX "BusinessUsageRecord_businessId_periodStart_key" ON "BusinessUsageRecord"("businessId", "periodStart");
CREATE INDEX "BusinessUsageRecord_businessId_periodStart_idx" ON "BusinessUsageRecord"("businessId", "periodStart");

ALTER TABLE "BusinessAccount" ADD CONSTRAINT "BusinessAccount_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Business" ADD CONSTRAINT "Business_businessAccountId_fkey" FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_businessAccountId_fkey" FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountUsageRecord" ADD CONSTRAINT "AccountUsageRecord_businessAccountId_fkey" FOREIGN KEY ("businessAccountId") REFERENCES "BusinessAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountUsageRecord" ADD CONSTRAINT "AccountUsageRecord_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessUsageRecord" ADD CONSTRAINT "BusinessUsageRecord_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
