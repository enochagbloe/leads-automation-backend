ALTER TABLE "AccountUsageRecord"
  ADD COLUMN "aiKnowledgeAnalysisRequestsUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiKnowledgeAnalysisTokensUsed" INTEGER NOT NULL DEFAULT 0;
