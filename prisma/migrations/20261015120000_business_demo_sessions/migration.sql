ALTER TABLE "DemoSession" ADD COLUMN "hostBusinessId" TEXT;
ALTER TABLE "DemoSession" ADD CONSTRAINT "DemoSession_hostBusinessId_fkey" FOREIGN KEY ("hostBusinessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "DemoSession_hostBusinessId_status_expiresAt_idx" ON "DemoSession"("hostBusinessId", "status", "expiresAt");
