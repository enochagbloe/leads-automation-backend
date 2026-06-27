ALTER TYPE "MembershipStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED_BY_PLAN';

ALTER TABLE "AuditLog"
ADD COLUMN IF NOT EXISTS "actorMembershipId" TEXT;

CREATE INDEX IF NOT EXISTS "AuditLog_actorMembershipId_createdAt_idx"
ON "AuditLog"("actorMembershipId", "createdAt");
