-- AlterTable
ALTER TABLE "AiPromptDraftMutation" ADD COLUMN IF NOT EXISTS "resultSnapshot" JSONB;
