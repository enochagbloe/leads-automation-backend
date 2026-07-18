-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_DRAFT_AUTOSAVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_DRAFT_SYNC_DUPLICATE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_DRAFT_CONFLICT_DETECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_DRAFT_CONFLICT_RESOLVED';

-- AlterTable
ALTER TABLE "AiPromptVersion" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AiPromptVersion" ADD COLUMN IF NOT EXISTS "validatedRevision" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "AiPromptDraftMutation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "clientMutationId" TEXT NOT NULL,
  "clientUpdatedAt" TIMESTAMP(3),
  "appliedRevision" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiPromptDraftMutation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AiPromptDraftMutation_businessId_clientMutationId_key" ON "AiPromptDraftMutation"("businessId", "clientMutationId");
CREATE INDEX IF NOT EXISTS "AiPromptDraftMutation_businessId_versionId_idx" ON "AiPromptDraftMutation"("businessId", "versionId");
CREATE INDEX IF NOT EXISTS "AiPromptDraftMutation_createdAt_idx" ON "AiPromptDraftMutation"("createdAt");

-- AddForeignKey
ALTER TABLE "AiPromptDraftMutation" ADD CONSTRAINT "AiPromptDraftMutation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiPromptDraftMutation" ADD CONSTRAINT "AiPromptDraftMutation_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AiPromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
