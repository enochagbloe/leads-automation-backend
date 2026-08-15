export function knowledgeDocumentRetryAt(attemptCount: number, now = new Date()) {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 6));
  return new Date(now.getTime() + Math.min(2 ** exponent, 60) * 60_000);
}

export function canRetryKnowledgeDocumentJob(attemptCount: number, maximumAttempts: number) {
  return attemptCount < maximumAttempts;
}

export function knowledgeDocumentProcessingFailureIsRetryable(errorCode: string) {
  return ![
    "KNOWLEDGE_DOCUMENT_MALWARE_SCAN_REQUIRED",
    "KNOWLEDGE_DOCUMENT_PROCESSING_SCOPE_MISMATCH",
    "KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED",
    "KNOWLEDGE_DOCUMENT_DELETED",
    "KNOWLEDGE_DOCUMENT_AI_RESULT_RECONCILIATION_REQUIRED",
  ].includes(errorCode);
}

export function knowledgeDocumentBusinessIsProcessable(input: {
  status: string;
  deletedAt: Date | null;
}) {
  return input.status === "ACTIVE" && input.deletedAt === null;
}

export function knowledgeDocumentProcessingJobIdFromBatchId(processingBatchId: string) {
  const separator = processingBatchId.lastIndexOf(":");
  if (separator <= 0 || separator === processingBatchId.length - 1) return null;
  const attempt = Number(processingBatchId.slice(separator + 1));
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return processingBatchId.slice(0, separator);
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

export function knowledgeDocumentCompletionUpdatesSucceeded(input: {
  jobCount: number;
  documentCount: number;
  versionCount: number;
}) {
  return input.jobCount === 1 && input.documentCount === 1 && input.versionCount === 1;
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

export async function processKnowledgeDocumentBusinessFairBatch<T extends { businessId: string }>(input: {
  limit: number;
  claim: (excludedBusinessIds: ReadonlySet<string>) => Promise<T | null>;
  process: (job: T) => Promise<void>;
}) {
  const servicedBusinessIds = new Set<string>();
  let processed = 0;
  while (processed < input.limit) {
    let job = await input.claim(servicedBusinessIds);
    if (!job && servicedBusinessIds.size) {
      servicedBusinessIds.clear();
      job = await input.claim(servicedBusinessIds);
    }
    if (!job) break;
    servicedBusinessIds.add(job.businessId);
    await input.process(job);
    processed += 1;
  }
  return processed;
}
