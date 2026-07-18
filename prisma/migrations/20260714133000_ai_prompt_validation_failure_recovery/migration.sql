ALTER TABLE "AiPromptVersion"
  ADD COLUMN "validationFailureCode" TEXT,
  ADD COLUMN "validationFailureAt" TIMESTAMP(3);

