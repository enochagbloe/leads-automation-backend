CREATE TYPE "DemoSessionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DESTROYED');
ALTER TYPE "ConversationChannel" ADD VALUE 'DEMO';
CREATE TABLE "DemoSession" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "tokenHash" TEXT NOT NULL,
 "ipHash" TEXT NOT NULL,
 "idempotencyHash" TEXT,
 "status" "DemoSessionStatus" NOT NULL DEFAULT 'ACTIVE',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "destroyedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "DemoSession_tokenHash_key" ON "DemoSession"("tokenHash");
CREATE UNIQUE INDEX "DemoSession_idempotencyHash_key" ON "DemoSession"("idempotencyHash");
CREATE INDEX "DemoSession_status_expiresAt_idx" ON "DemoSession"("status", "expiresAt");
CREATE INDEX "DemoSession_ipHash_status_expiresAt_idx" ON "DemoSession"("ipHash", "status", "expiresAt");
ALTER TABLE "User" ADD COLUMN "demoSessionId" TEXT;
CREATE UNIQUE INDEX "User_demoSessionId_key" ON "User"("demoSessionId");
ALTER TABLE "User" ADD CONSTRAINT "User_demoSessionId_fkey" FOREIGN KEY ("demoSessionId") REFERENCES "DemoSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BusinessAccount" ADD COLUMN "demoSessionId" TEXT;
CREATE UNIQUE INDEX "BusinessAccount_demoSessionId_key" ON "BusinessAccount"("demoSessionId");
ALTER TABLE "BusinessAccount" ADD CONSTRAINT "BusinessAccount_demoSessionId_fkey" FOREIGN KEY ("demoSessionId") REFERENCES "DemoSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Business" ADD COLUMN "demoSessionId" TEXT;
CREATE UNIQUE INDEX "Business_demoSessionId_key" ON "Business"("demoSessionId");
ALTER TABLE "Business" ADD CONSTRAINT "Business_demoSessionId_fkey" FOREIGN KEY ("demoSessionId") REFERENCES "DemoSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
