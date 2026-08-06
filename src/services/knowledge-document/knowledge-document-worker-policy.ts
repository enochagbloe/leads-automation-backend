export function knowledgeDocumentRetryAt(attemptCount: number, now = new Date()) {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 6));
  return new Date(now.getTime() + Math.min(2 ** exponent, 60) * 60_000);
}

export function canRetryKnowledgeDocumentJob(attemptCount: number, maximumAttempts: number) {
  return attemptCount < maximumAttempts;
}

export function knowledgeDocumentJobCanBeClaimed(input: {
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  attemptCount: number;
  maximumAttempts: number;
  nextAttemptAt: Date | null;
  now: Date;
}) {
  if (input.attemptCount >= input.maximumAttempts) return false;
  if (input.status === "QUEUED") return !input.nextAttemptAt || input.nextAttemptAt <= input.now;
  return input.status === "FAILED" && Boolean(input.nextAttemptAt && input.nextAttemptAt <= input.now);
}

export function knowledgeDocumentCompletionAllowed(input: {
  jobStatus: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  documentDeleted: boolean;
  ownershipMatches: boolean;
  expectedProcessingStartedAt: Date;
  currentProcessingStartedAt: Date | null;
}) {
  return input.jobStatus === "PROCESSING"
    && !input.documentDeleted
    && input.ownershipMatches
    && input.currentProcessingStartedAt?.getTime() === input.expectedProcessingStartedAt.getTime();
}

export function knowledgeDocumentJobIsStale(processingStartedAt: Date | null, staleBefore: Date) {
  return Boolean(processingStartedAt && processingStartedAt < staleBefore);
}

export function knowledgeDocumentJobOwnershipMatches(input: {
  jobBusinessId: string;
  jobDocumentId: string;
  jobVersionId: string;
  documentBusinessId: string;
  activeVersionId: string | null;
  versionBusinessId: string;
  versionDocumentId: string;
  versionId: string;
  versionIsActive: boolean;
}) {
  return input.jobBusinessId === input.documentBusinessId
    && input.jobBusinessId === input.versionBusinessId
    && input.jobDocumentId === input.versionDocumentId
    && input.jobVersionId === input.versionId
    && input.activeVersionId === input.versionId
    && input.versionIsActive;
}
