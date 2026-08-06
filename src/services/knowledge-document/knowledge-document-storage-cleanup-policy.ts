export function knowledgeDocumentStorageDeletionRetryAt(attemptCount: number, now = new Date()) {
  const delayMinutes = Math.min(24 * 60, 2 ** Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + delayMinutes * 60_000);
}

export function knowledgeDocumentStorageDeletionCanBeClaimed(input: {
  status: string;
  attemptCount: number;
  maximumAttempts: number;
  scheduledFor: Date;
  nextAttemptAt: Date | null;
  now: Date;
}) {
  if (input.attemptCount >= input.maximumAttempts) return false;
  if (input.status === "SCHEDULED") return input.scheduledFor <= input.now;
  return input.status === "FAILED" && Boolean(input.nextAttemptAt && input.nextAttemptAt <= input.now);
}

export function knowledgeDocumentStorageDeletionOwnershipMatches(input: {
  jobBusinessId: string;
  jobDocumentId: string;
  jobVersionId: string;
  jobObjectKey: string;
  documentBusinessId: string;
  documentDeleted: boolean;
  versionBusinessId: string;
  versionDocumentId: string;
  versionId: string;
  versionObjectKey: string | null;
}) {
  return input.jobBusinessId === input.documentBusinessId
    && input.documentDeleted
    && input.jobBusinessId === input.versionBusinessId
    && input.jobDocumentId === input.versionDocumentId
    && input.jobVersionId === input.versionId
    && input.jobObjectKey === input.versionObjectKey;
}
