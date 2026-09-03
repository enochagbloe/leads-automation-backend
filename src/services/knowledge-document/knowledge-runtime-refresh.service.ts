import {
  KnowledgeRuntimeRefreshJobStatus,
  Prisma,
} from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { invalidateAiBusinessContext } from "../ai-context-builder.service";
import { knowledgeEmbeddingService } from "../knowledge-embedding.service";

type RefreshTarget = { businessId: string; documentId: string };

export function knowledgeRuntimeRefreshDisposition(input: {
  requestedRevision: number;
  processingRevision: number;
  attemptCount: number;
  maximumAttempts: number;
  cacheInvalidated: boolean;
  embeddingsSynced: boolean;
}) {
  if (input.requestedRevision > input.processingRevision) return "RESCHEDULE" as const;
  if (!input.cacheInvalidated || !input.embeddingsSynced) {
    return input.attemptCount >= input.maximumAttempts ? "EXHAUST" as const : "RETRY" as const;
  }
  return "COMPLETE" as const;
}

function retryAt(attemptCount: number, now = new Date()) {
  const delaySeconds = Math.min(15 * 60, 15 * 2 ** Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + delaySeconds * 1_000);
}

function failure(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message.slice(0, 300) };
  return {
    code: "KNOWLEDGE_RUNTIME_REFRESH_FAILED",
    message: "Knowledge runtime state could not be refreshed.",
  };
}

export async function enqueueKnowledgeRuntimeRefresh(
  tx: Prisma.TransactionClient,
  target: RefreshTarget,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await tx.knowledgeRuntimeRefreshJob.findUnique({
      where: { documentId: target.documentId },
      select: { id: true, businessId: true, status: true, requestedRevision: true, updatedAt: true },
    });
    if (!current) {
      const created = await tx.knowledgeRuntimeRefreshJob.createMany({
        data: [target],
        skipDuplicates: true,
      });
      if (created.count === 1) return;
      continue;
    }
    if (current.businessId !== target.businessId) {
      throw new AppError(409, "Knowledge runtime refresh ownership mismatch.", "KNOWLEDGE_RUNTIME_REFRESH_SCOPE_MISMATCH");
    }

    const processing = current.status === KnowledgeRuntimeRefreshJobStatus.PROCESSING;
    const changed = await tx.knowledgeRuntimeRefreshJob.updateMany({
      where: {
        id: current.id,
        status: current.status,
        requestedRevision: current.requestedRevision,
        updatedAt: current.updatedAt,
      },
      data: {
        requestedRevision: { increment: 1 },
        ...(processing ? {} : {
          status: KnowledgeRuntimeRefreshJobStatus.SCHEDULED,
          attemptCount: 0,
          nextAttemptAt: new Date(),
          processingRevision: null,
          processingStartedAt: null,
          cacheInvalidatedAt: null,
          embeddingsSyncedAt: null,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        }),
      },
    });
    if (changed.count === 1) return;
  }
  throw new AppError(409, "Knowledge runtime refresh changed concurrently.", "KNOWLEDGE_RUNTIME_REFRESH_STATE_CHANGED");
}

async function claim(targetDocumentIds?: readonly string[]) {
  const now = new Date();
  const candidates = await prisma.knowledgeRuntimeRefreshJob.findMany({
    where: {
      ...(targetDocumentIds?.length ? { documentId: { in: [...targetDocumentIds] } } : {}),
      attemptCount: { lt: env.KNOWLEDGE_DOCUMENT_WORKER_MAX_ATTEMPTS },
      OR: [
        { status: KnowledgeRuntimeRefreshJobStatus.SCHEDULED, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { status: KnowledgeRuntimeRefreshJobStatus.FAILED, nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, targetDocumentIds?.length ?? env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE),
  });

  for (const candidate of candidates) {
    const revisionChanged = candidate.processingRevision !== candidate.requestedRevision;
    const processingStartedAt = new Date();
    const changed = await prisma.knowledgeRuntimeRefreshJob.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        attemptCount: candidate.attemptCount,
        requestedRevision: candidate.requestedRevision,
        updatedAt: candidate.updatedAt,
      },
      data: {
        status: KnowledgeRuntimeRefreshJobStatus.PROCESSING,
        attemptCount: { increment: 1 },
        processingRevision: candidate.requestedRevision,
        processingStartedAt,
        nextAttemptAt: null,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        ...(revisionChanged ? { cacheInvalidatedAt: null, embeddingsSyncedAt: null } : {}),
      },
    });
    if (changed.count !== 1) continue;
    return prisma.knowledgeRuntimeRefreshJob.findFirst({
      where: {
        id: candidate.id,
        status: KnowledgeRuntimeRefreshJobStatus.PROCESSING,
        processingStartedAt,
      },
    });
  }
  return null;
}

async function checkpoint(jobId: string, processingRevision: number, field: "cacheInvalidatedAt" | "embeddingsSyncedAt") {
  return prisma.knowledgeRuntimeRefreshJob.updateMany({
    where: {
      id: jobId,
      status: KnowledgeRuntimeRefreshJobStatus.PROCESSING,
      processingRevision,
    },
    data: { [field]: new Date() },
  });
}

async function processClaimed(job: NonNullable<Awaited<ReturnType<typeof claim>>>) {
  if (job.processingRevision === null) return;
  const failures: Array<{ code: string; message: string }> = [];
  let cacheInvalidated = Boolean(job.cacheInvalidatedAt);
  let embeddingsSynced = Boolean(job.embeddingsSyncedAt);

  if (!cacheInvalidated) {
    try {
      await invalidateAiBusinessContext(job.businessId);
      cacheInvalidated = (await checkpoint(job.id, job.processingRevision, "cacheInvalidatedAt")).count === 1;
    } catch (error) {
      failures.push(failure(error));
    }
  }
  if (!embeddingsSynced) {
    try {
      await knowledgeEmbeddingService.syncDocument(job.documentId);
      embeddingsSynced = (await checkpoint(job.id, job.processingRevision, "embeddingsSyncedAt")).count === 1;
    } catch (error) {
      failures.push(failure(error));
    }
  }

  const current = await prisma.knowledgeRuntimeRefreshJob.findFirst({
    where: {
      id: job.id,
      status: KnowledgeRuntimeRefreshJobStatus.PROCESSING,
      processingRevision: job.processingRevision,
    },
  });
  if (!current) return;

  const disposition = knowledgeRuntimeRefreshDisposition({
    requestedRevision: current.requestedRevision,
    processingRevision: job.processingRevision,
    attemptCount: current.attemptCount,
    maximumAttempts: env.KNOWLEDGE_DOCUMENT_WORKER_MAX_ATTEMPTS,
    cacheInvalidated,
    embeddingsSynced,
  });

  if (disposition === "RESCHEDULE") {
    await prisma.knowledgeRuntimeRefreshJob.updateMany({
      where: { id: current.id, status: KnowledgeRuntimeRefreshJobStatus.PROCESSING, processingRevision: job.processingRevision },
      data: {
        status: KnowledgeRuntimeRefreshJobStatus.SCHEDULED,
        attemptCount: 0,
        nextAttemptAt: new Date(),
        processingRevision: null,
        processingStartedAt: null,
        cacheInvalidatedAt: null,
        embeddingsSyncedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    return;
  }

  if (disposition === "RETRY" || disposition === "EXHAUST") {
    const exhausted = disposition === "EXHAUST";
    const firstFailure = failures[0] ?? failure(new Error("REFRESH_CHECKPOINT_FAILED"));
    await prisma.knowledgeRuntimeRefreshJob.updateMany({
      where: { id: current.id, status: KnowledgeRuntimeRefreshJobStatus.PROCESSING, processingRevision: job.processingRevision },
      data: {
        status: exhausted ? KnowledgeRuntimeRefreshJobStatus.EXHAUSTED : KnowledgeRuntimeRefreshJobStatus.FAILED,
        nextAttemptAt: exhausted ? null : retryAt(current.attemptCount),
        processingStartedAt: null,
        completedAt: exhausted ? new Date() : null,
        lastErrorCode: firstFailure.code,
        lastErrorMessage: firstFailure.message,
      },
    });
    console.error("Knowledge runtime refresh failed", {
      businessId: current.businessId,
      documentId: current.documentId,
      attemptCount: current.attemptCount,
      exhausted,
      errorCodes: failures.map((item) => item.code),
    });
    return;
  }

  await prisma.knowledgeRuntimeRefreshJob.updateMany({
    where: { id: current.id, status: KnowledgeRuntimeRefreshJobStatus.PROCESSING, processingRevision: job.processingRevision },
    data: {
      status: KnowledgeRuntimeRefreshJobStatus.COMPLETED,
      completedRevision: job.processingRevision,
      nextAttemptAt: null,
      processingStartedAt: null,
      completedAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });
}

async function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - env.KNOWLEDGE_DOCUMENT_WORKER_STALE_SECONDS * 1_000);
  return prisma.knowledgeRuntimeRefreshJob.updateMany({
    where: {
      status: KnowledgeRuntimeRefreshJobStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
    },
    data: {
      status: KnowledgeRuntimeRefreshJobStatus.FAILED,
      processingStartedAt: null,
      nextAttemptAt: new Date(),
      lastErrorCode: "KNOWLEDGE_RUNTIME_REFRESH_STALE",
      lastErrorMessage: "The runtime refresh lease expired and will be retried.",
    },
  });
}

async function processJobs(limit: number, documentIds?: readonly string[]) {
  let processed = 0;
  const seen = new Set<string>();
  while (processed < limit) {
    const remainingDocumentIds = documentIds?.filter((id) => !seen.has(id));
    if (documentIds && !remainingDocumentIds?.length) break;
    const job = await claim(remainingDocumentIds);
    if (!job) break;
    seen.add(job.documentId);
    await processClaimed(job);
    processed += 1;
  }
  return processed;
}

export const knowledgeRuntimeRefreshService = {
  async processDueJobs(limit = env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE) {
    await recoverStaleJobs();
    return processJobs(limit);
  },

  async processDocuments(documentIds: readonly string[]) {
    const uniqueIds = [...new Set(documentIds)];
    try {
      return await processJobs(uniqueIds.length, uniqueIds);
    } catch (error) {
      console.error("Immediate knowledge runtime refresh failed; durable retry remains scheduled", {
        documentIds: uniqueIds,
        errorCode: error instanceof AppError ? error.code : "KNOWLEDGE_RUNTIME_REFRESH_FAILED",
      });
      return 0;
    }
  },
};
