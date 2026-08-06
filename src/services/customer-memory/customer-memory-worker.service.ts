import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessRole,
  CustomerMemoryExtractionStatus,
  MembershipStatus,
  MessageSenderType,
  MessageType,
  Prisma,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { isDatabaseUnavailableError } from "../../utils/database-error";
import { AppError } from "../../utils/errors";
import { cacheService } from "../cache.service";
import { aiUsageService } from "../ai-usage.service";
import { notificationService } from "../notification.service";
import { customerMemoryDeterministicExtractionService, customerMessagesNeedAiExtraction } from "./customer-memory-deterministic-extraction.service";
import {
  CustomerMemoryExtractionPostProviderError,
  CustomerMemoryExtractionUsage,
  customerMemoryExtractionService,
} from "./customer-memory-extraction.service";
import { packCustomerMemoryExtractionMessages } from "./customer-memory-message-batch";
import { customerMemoryResolverService } from "./customer-memory-resolver.service";
import { customerMemoryRetentionService } from "./customer-memory-retention.service";
import { usableCustomerMemoryPolicyWhere } from "./customer-memory-sensitive-data-policy";
import { customerMemoryStoreService } from "./customer-memory-store.service";

let timer: NodeJS.Timeout | null = null;
let running = false;
const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 10 * 60_000;
const AI_USAGE_RECONCILIATION_REQUIRED = "CUSTOMER_MEMORY_AI_USAGE_RECONCILIATION_REQUIRED";
const CUSTOMER_MEMORY_WORKER_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

function retryAt(attempt: number) {
  const delayMinutes = Math.min(2 ** Math.max(attempt - 1, 0), 60);
  return new Date(Date.now() + delayMinutes * 60_000);
}

function errorCode(error: unknown) {
  if (error instanceof Error && error.message.startsWith("CUSTOMER_MEMORY_")) return error.message.slice(0, 120);
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "P2028") return "CUSTOMER_MEMORY_TRANSACTION_TIMEOUT";
    if (typeof code === "string" && /^P\d{4}$/.test(code)) {
      return `CUSTOMER_MEMORY_DATABASE_${code}`;
    }
  }
  return "CUSTOMER_MEMORY_EXTRACTION_FAILED";
}

function isTransactionApiError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "P2028",
  );
}

function providerUsageFromError(error: unknown): CustomerMemoryExtractionUsage | null {
  if (error instanceof CustomerMemoryExtractionPostProviderError) return error.usage;
  if (error instanceof AppError && typeof error.context?.providerRequestCount === "number") {
    return {
      providerRequestCount: Math.max(0, Math.floor(error.context.providerRequestCount)),
      provider: "OPENROUTER",
      model: typeof error.context.primaryModel === "string" ? error.context.primaryModel : "unknown",
    };
  }
  return null;
}

type ExhaustedJobDiagnostic = {
  businessId: string;
  businessAccountId: string;
  leadId: string;
  conversationId: string;
  jobIds: string[];
  errorCode: string;
};

async function reportExhaustedJobs(input: ExhaustedJobDiagnostic) {
  console.error("Customer memory extraction jobs exhausted", {
    metric: "customer_memory_extraction_jobs_exhausted_total",
    value: input.jobIds.length,
    businessId: input.businessId,
    leadId: input.leadId,
    conversationId: input.conversationId,
    errorCode: input.errorCode,
  });
  try {
    const recipients = await prisma.businessMember.findMany({
      where: {
        businessId: input.businessId,
        status: MembershipStatus.ACTIVE,
        role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] },
      },
      select: { id: true },
    });
    if (!recipients.length) return;
    await notificationService.createNotificationsForRecipients({
      businessId: input.businessId,
      businessAccountId: input.businessAccountId,
      recipientMembershipIds: recipients.map((recipient) => recipient.id),
      type: BusinessNotificationType.CUSTOMER_MEMORY_EXTRACTION_EXHAUSTED,
      priority: BusinessNotificationPriority.HIGH,
      title: "Customer memory extraction needs review",
      message: "Customer memory processing stopped after repeated internal failures. Customer messaging was not interrupted.",
      entityType: BusinessNotificationEntityType.LEAD,
      entityId: input.leadId,
      metadata: {
        leadId: input.leadId,
        conversationId: input.conversationId,
        jobIds: input.jobIds,
        finalErrorCode: input.errorCode,
      },
    });
  } catch (error) {
    console.error("Customer memory exhaustion notification failed", {
      businessId: input.businessId,
      leadId: input.leadId,
      errorCode: errorCode(error),
    });
  }
}

const DISCOVERY_MESSAGE_SELECT = {
  id: true,
  businessId: true,
  leadId: true,
  conversationId: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

function eligibleDiscoveryWhere(businessId: string): Prisma.MessageWhereInput {
  return {
    businessId,
    customerMemoryExtractionJob: { is: null },
    deletedAt: null,
    messageType: { in: [MessageType.TEXT, MessageType.SYSTEM] },
    senderType: { in: [MessageSenderType.CUSTOMER, MessageSenderType.STAFF, MessageSenderType.AI] },
    content: { not: "" },
    lead: {
      deletedAt: null,
      OR: [
        { customerMemoryProfile: { is: null } },
        { customerMemoryProfile: { is: { memoryEnabled: true } } },
      ],
    },
    conversation: { deletedAt: null, customerMemoryTombstone: { is: null } },
  };
}

async function ensureDiscoveryCursors() {
  const businesses = await prisma.business.findMany({
    where: { deletedAt: null, customerMemoryDiscoveryCursor: { is: null } },
    orderBy: { createdAt: "desc" },
    take: env.CUSTOMER_MEMORY_DISCOVERY_BUSINESS_BATCH_SIZE,
    select: { id: true },
  });
  if (!businesses.length) return;
  await prisma.customerMemoryDiscoveryCursor.createMany({
    data: businesses.map((business) => ({
      businessId: business.id,
      lastMessageCreatedAt: new Date(0),
      lastMessageId: "",
      lastScannedAt: new Date(0),
      lastProcessedAt: new Date(0),
    })),
    skipDuplicates: true,
  });
}

async function discoverBusinessMessages(businessId: string) {
  return prisma.$transaction(async (tx) => {
    const lockRows = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${`customer-memory-discovery:${businessId}`})) AS locked
    `;
    if (!lockRows[0]?.locked) return 0;
    const cursor = await tx.customerMemoryDiscoveryCursor.findUnique({ where: { businessId } });
    if (!cursor) return 0;
    const highWatermark = await tx.message.findFirst({
      where: { businessId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    });
    if (!highWatermark) {
      await tx.customerMemoryDiscoveryCursor.update({ where: { businessId }, data: { lastScannedAt: new Date() } });
      return 0;
    }

    const perBusinessLimit = env.CUSTOMER_MEMORY_DISCOVERY_PER_BUSINESS_BATCH_SIZE;
    const liveCutoff = new Date(Date.now() - env.CUSTOMER_MEMORY_LIVE_PRIORITY_WINDOW_MINUTES * 60_000);
    const baseWhere = eligibleDiscoveryWhere(businessId);
    const [liveMessages, backfillMessages] = await Promise.all([
      tx.message.findMany({
        where: { ...baseWhere, createdAt: { gte: liveCutoff } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: Math.max(1, Math.floor(perBusinessLimit / 2)),
        select: DISCOVERY_MESSAGE_SELECT,
      }),
      tx.message.findMany({
        where: {
          ...baseWhere,
          AND: [
            {
              OR: [
                { createdAt: { gt: cursor.lastMessageCreatedAt } },
                { createdAt: cursor.lastMessageCreatedAt, id: { gt: cursor.lastMessageId } },
              ],
            },
            {
              OR: [
                { createdAt: { lt: highWatermark.createdAt } },
                { createdAt: highWatermark.createdAt, id: { lte: highWatermark.id } },
              ],
            },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: perBusinessLimit,
        select: DISCOVERY_MESSAGE_SELECT,
      }),
    ]);

    const messages = Array.from(new Map([...liveMessages, ...backfillMessages].map((message) => [message.id, message])).values());
    const created = messages.length
      ? await tx.customerMemoryExtractionJob.createMany({
          data: messages.map((message) => ({
            businessId: message.businessId,
            leadId: message.leadId,
            conversationId: message.conversationId,
            messageId: message.id,
            nextAttemptAt: new Date(message.createdAt.getTime() + env.CUSTOMER_MEMORY_TURN_BATCH_DELAY_SECONDS * 1_000),
          })),
          skipDuplicates: true,
        })
      : { count: 0 };
    const backfillCursor = backfillMessages.length >= perBusinessLimit
      ? backfillMessages.at(-1)!
      : highWatermark;
    await tx.customerMemoryDiscoveryCursor.update({
      where: { businessId },
      data: {
        lastMessageCreatedAt: backfillCursor.createdAt,
        lastMessageId: backfillCursor.id,
        lastScannedAt: new Date(),
      },
    });
    return created.count;
  }, CUSTOMER_MEMORY_WORKER_TRANSACTION_OPTIONS);
}

async function discoverMessages() {
  await ensureDiscoveryCursors();
  const cursors = await prisma.customerMemoryDiscoveryCursor.findMany({
    where: { business: { deletedAt: null } },
    orderBy: [{ lastScannedAt: "asc" }, { businessId: "asc" }],
    take: env.CUSTOMER_MEMORY_DISCOVERY_BUSINESS_BATCH_SIZE,
    select: { businessId: true },
  });
  let created = 0;
  for (const cursor of cursors) {
    try {
      created += await discoverBusinessMessages(cursor.businessId);
    } catch (error) {
      if (!isTransactionApiError(error) || isDatabaseUnavailableError(error)) throw error;
      // Discovery is safe to retry: cursor movement and deduplicated job
      // creation commit in the same transaction. Acquisition/connectivity
      // failures are left for the next worker tick to avoid database pressure.
      created += await discoverBusinessMessages(cursor.businessId);
    }
  }
  return created;
}

function dueJobWhere(now: Date, businessId?: string): Prisma.CustomerMemoryExtractionJobWhereInput {
  return {
    ...(businessId ? { businessId } : {}),
    attemptCount: { lt: MAX_ATTEMPTS },
    nextAttemptAt: { lte: now },
    status: { in: [CustomerMemoryExtractionStatus.PENDING, CustomerMemoryExtractionStatus.FAILED] },
    OR: [{ lastErrorCode: null }, { lastErrorCode: { not: AI_USAGE_RECONCILIATION_REQUIRED } }],
  };
}

async function claimNextBatch(preferRecent: boolean) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = new Date();
    const recentCutoff = new Date(now.getTime() - env.CUSTOMER_MEMORY_LIVE_PRIORITY_WINDOW_MINUTES * 60_000);
    const recentCursor = preferRecent
      ? await prisma.customerMemoryDiscoveryCursor.findFirst({
          where: {
            business: {
              deletedAt: null,
              customerMemoryExtractionJobs: {
                some: { ...dueJobWhere(now), nextAttemptAt: { gte: recentCutoff, lte: now } },
              },
            },
          },
          orderBy: [{ lastProcessedAt: "asc" }, { businessId: "asc" }],
          select: { businessId: true },
        })
      : null;
    const cursor = recentCursor ?? await prisma.customerMemoryDiscoveryCursor.findFirst({
      where: {
        business: {
          deletedAt: null,
          customerMemoryExtractionJobs: { some: dueJobWhere(now) },
        },
      },
      orderBy: [{ lastProcessedAt: "asc" }, { businessId: "asc" }],
      select: { businessId: true },
    });
    if (!cursor) return null;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-memory-processing:${cursor.businessId}`}))`;
      const recentCandidate = recentCursor
        ? await tx.customerMemoryExtractionJob.findFirst({
            where: { ...dueJobWhere(now, cursor.businessId), nextAttemptAt: { gte: recentCutoff, lte: now } },
            orderBy: [{ nextAttemptAt: "desc" }, { createdAt: "desc" }],
            select: { id: true, conversationId: true },
          })
        : null;
      const candidate = recentCursor
        ? recentCandidate
        : await tx.customerMemoryExtractionJob.findFirst({
            where: dueJobWhere(now, cursor.businessId),
            orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
            select: { id: true, conversationId: true },
          });
      if (!candidate) return null;
      const candidates = await tx.customerMemoryExtractionJob.findMany({
        where: { ...dueJobWhere(now, cursor.businessId), conversationId: candidate.conversationId },
        orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
        take: 20,
        select: { id: true },
      });
      const processingBatchId = randomUUID();
      const claimed = await tx.customerMemoryExtractionJob.updateMany({
        where: { ...dueJobWhere(now, cursor.businessId), id: { in: candidates.map((job) => job.id) } },
        data: {
          status: CustomerMemoryExtractionStatus.PROCESSING,
          processingStartedAt: now,
          processingBatchId,
          attemptCount: { increment: 1 },
          lastErrorCode: null,
        },
      });
      if (claimed.count === 0) return null;
      await tx.customerMemoryDiscoveryCursor.update({
        where: { businessId: cursor.businessId },
        data: { lastProcessedAt: now },
      });
      return processingBatchId;
    }, CUSTOMER_MEMORY_WORKER_TRANSACTION_OPTIONS);
    if (result) return result;
  }
  return null;
}

async function processBatch(processingBatchId: string) {
  const jobs = await prisma.customerMemoryExtractionJob.findMany({
    where: { processingBatchId, status: CustomerMemoryExtractionStatus.PROCESSING },
    orderBy: { createdAt: "asc" },
    include: {
      message: { select: { id: true, senderType: true, content: true, createdAt: true } },
      business: { select: { businessAccountId: true, timezone: true, services: { where: { isActive: true, isArchived: false }, select: { id: true, name: true }, take: 100 } } },
    },
  });
  const job = jobs[0];
  if (!job) return;
  let reservationKey: string | null = null;
  let providerAttemptStarted = false;
  let knownProviderUsage: CustomerMemoryExtractionUsage | null = null;
  try {
    const profile = await prisma.customerMemoryProfile.findUnique({
      where: { businessId_leadId: { businessId: job.businessId, leadId: job.leadId } },
      select: { memoryEnabled: true },
    });
    if (profile?.memoryEnabled === false) {
      await prisma.customerMemoryExtractionJob.updateMany({
        where: { processingBatchId, status: CustomerMemoryExtractionStatus.PROCESSING },
        data: { status: CustomerMemoryExtractionStatus.COMPLETED, completedAt: new Date(), processingStartedAt: null, lastErrorCode: "CUSTOMER_MEMORY_DISABLED" },
      });
      return;
    }

    for (const deterministicJob of jobs.filter((entry) => entry.message.senderType !== MessageSenderType.CUSTOMER)) {
      const memories = customerMemoryDeterministicExtractionService.extract({
        messageId: deterministicJob.messageId,
        senderType: deterministicJob.message.senderType,
        content: deterministicJob.message.content,
      });
      if (!memories.length) continue;
      const applied = await customerMemoryStoreService.apply({
        businessId: deterministicJob.businessId,
        leadId: deterministicJob.leadId,
        conversationId: deterministicJob.conversationId,
        messageId: deterministicJob.messageId,
        memories,
        extractionJobId: deterministicJob.id,
        writeAuthority: "EXTRACTION",
      });
      if ("skipped" in applied) {
        await prisma.customerMemoryExtractionJob.updateMany({
          where: { processingBatchId, status: CustomerMemoryExtractionStatus.PROCESSING },
          data: { status: CustomerMemoryExtractionStatus.COMPLETED, completedAt: new Date(), processingStartedAt: null, lastErrorCode: applied.skipped },
        });
        return;
      }
    }

    const customerJobs = jobs.filter((entry) => entry.message.senderType === MessageSenderType.CUSTOMER);
    const customerJobsNeedAi = customerMessagesNeedAiExtraction(
      customerJobs.map((entry) => entry.message.content),
      job.business.services.map((service) => service.name),
    );
    if (customerJobs.length && customerJobsNeedAi) {
      const reservation = await aiUsageService.reserveCustomerMemoryExtraction({
        businessAccountId: job.business.businessAccountId,
        processingBatchId,
      });
      if (!reservation.allowed) {
        await cacheService.delByPattern(`business:${job.businessId}:ai-context:*`).catch(() => undefined);
        if (reservation.reservationStatus) {
          throw new Error(AI_USAGE_RECONCILIATION_REQUIRED);
        }
        await prisma.customerMemoryExtractionJob.updateMany({
          where: { processingBatchId, status: CustomerMemoryExtractionStatus.PROCESSING },
          data: {
            status: CustomerMemoryExtractionStatus.COMPLETED,
            completedAt: new Date(),
            processingStartedAt: null,
            processingBatchId: null,
            nextAttemptAt: null,
            lastErrorCode: "CUSTOMER_MEMORY_AI_BUDGET_EXCEEDED",
          },
        });
        return;
      }
      reservationKey = reservation.idempotencyKey;
      const existingMemory = await prisma.customerMemoryItem.findMany({
        where: {
          businessId: job.businessId,
          leadId: job.leadId,
          status: "ACTIVE",
          activeKey: "ACTIVE",
          ...usableCustomerMemoryPolicyWhere(),
        },
        select: { category: true, memoryKey: true, valueText: true },
        orderBy: { learnedAt: "desc" },
        take: 30,
      });
      const sourceJob = customerJobs.at(-1)!;
      providerAttemptStarted = true;
      const attemptClaim = await aiUsageService.markCustomerMemoryExtractionAttemptStarted(reservation.idempotencyKey);
      if (attemptClaim.count !== 1) {
        throw new AppError(
          409,
          "Customer memory AI usage reservation was already claimed.",
          "CUSTOMER_MEMORY_AI_USAGE_RESERVATION_ALREADY_CLAIMED",
        );
      }
      const extraction = await customerMemoryExtractionService.extract({
        businessId: job.businessId,
        leadId: job.leadId,
        conversationId: job.conversationId,
        messages: packCustomerMemoryExtractionMessages(customerJobs.map((entry) => ({
          id: entry.message.id,
          createdAt: entry.message.createdAt,
          text: entry.message.content,
        }))),
        senderType: MessageSenderType.CUSTOMER,
        timezone: job.business.timezone,
        existingMemory,
        services: job.business.services,
      });
      knownProviderUsage = extraction.usage;
      await aiUsageService.settleCustomerMemoryExtraction({
        idempotencyKey: reservation.idempotencyKey,
        tokens: extraction.usage.totalTokens,
        providerRequestCount: extraction.usage.providerRequestCount,
        providerRequestId: extraction.usage.requestId,
      });
      const applied = await customerMemoryStoreService.apply({
        businessId: job.businessId,
        leadId: job.leadId,
        conversationId: job.conversationId,
        messageId: sourceJob.messageId,
        memories: extraction.memories,
        extractionBatchId: processingBatchId,
        writeAuthority: "EXTRACTION",
      });
      if ("skipped" in applied) {
        await prisma.customerMemoryExtractionJob.updateMany({
          where: { processingBatchId, status: CustomerMemoryExtractionStatus.PROCESSING },
          data: {
            status: CustomerMemoryExtractionStatus.COMPLETED,
            completedAt: new Date(),
            processingStartedAt: null,
            lastErrorCode: applied.skipped,
          },
        });
        return;
      }
    }
    await customerMemoryResolverService.resolve({
      businessId: job.businessId,
      leadId: job.leadId,
      conversationId: job.conversationId,
      mode: "RECONCILE",
    });
    await cacheService.delByPattern(`business:${job.businessId}:ai-context:*`);
    await prisma.customerMemoryExtractionJob.updateMany({
      where: { processingBatchId, status: CustomerMemoryExtractionStatus.PROCESSING },
      data: { status: CustomerMemoryExtractionStatus.COMPLETED, completedAt: new Date(), processingStartedAt: null },
    });
  } catch (error) {
    const stillProcessing = await prisma.customerMemoryExtractionJob.findFirst({
      where: { processingBatchId, status: CustomerMemoryExtractionStatus.PROCESSING },
      select: { id: true },
    });
    if (!stillProcessing) return;
    let code = errorCode(error);
    if (reservationKey) {
      const usage = knownProviderUsage ?? providerUsageFromError(error);
      try {
        if (usage && usage.providerRequestCount > 0) {
          await aiUsageService.settleCustomerMemoryExtraction({
            idempotencyKey: reservationKey,
            tokens: usage.totalTokens,
            providerRequestCount: usage.providerRequestCount,
            providerRequestId: usage.requestId,
            failureCode: code,
          });
        } else if (usage?.providerRequestCount === 0 || !providerAttemptStarted) {
          await aiUsageService.releaseCustomerMemoryExtraction({ idempotencyKey: reservationKey, failureCode: code });
        } else {
          await aiUsageService.requireCustomerMemoryExtractionReconciliation({
            idempotencyKey: reservationKey,
            failureCode: code,
          });
          code = AI_USAGE_RECONCILIATION_REQUIRED;
        }
      } catch {
        await aiUsageService.requireCustomerMemoryExtractionReconciliation({
          idempotencyKey: reservationKey,
          failureCode: "CUSTOMER_MEMORY_AI_USAGE_SETTLEMENT_FAILED",
        }).catch(() => undefined);
        code = AI_USAGE_RECONCILIATION_REQUIRED;
      }
    }
    const exhaustedIds = jobs.filter((entry) => entry.attemptCount >= MAX_ATTEMPTS).map((entry) => entry.id);
    const retryIds = jobs.filter((entry) => entry.attemptCount < MAX_ATTEMPTS).map((entry) => entry.id);
    const failedAt = new Date();
    const exhaustedJobs = await prisma.$transaction(async (tx) => {
      const exhausted = exhaustedIds.length
        ? await tx.customerMemoryExtractionJob.updateManyAndReturn({
            where: {
              id: { in: exhaustedIds },
              processingBatchId,
              status: CustomerMemoryExtractionStatus.PROCESSING,
            },
            data: {
              status: CustomerMemoryExtractionStatus.EXHAUSTED,
              processingStartedAt: null,
              processingBatchId: null,
              nextAttemptAt: null,
              lastErrorCode: code,
              lastErrorAt: failedAt,
              finalErrorCode: code,
              exhaustedAt: failedAt,
            },
            select: { id: true },
          })
        : [];
      if (retryIds.length) {
        await tx.customerMemoryExtractionJob.updateMany({
          where: {
            id: { in: retryIds },
            processingBatchId,
            status: CustomerMemoryExtractionStatus.PROCESSING,
          },
          data: {
            status: CustomerMemoryExtractionStatus.FAILED,
            processingStartedAt: null,
            processingBatchId: null,
            nextAttemptAt: retryAt(job.attemptCount),
            lastErrorCode: code,
            lastErrorAt: failedAt,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          businessId: job.businessId,
          action: AuditAction.CUSTOMER_MEMORY_EXTRACTION_FAILED,
          metadata: {
            leadId: job.leadId,
            conversationId: job.conversationId,
            messageIds: jobs.map((entry) => entry.messageId),
            processingBatchId,
            jobCount: jobs.length,
            attemptCount: job.attemptCount,
            errorCode: code,
            terminal: exhausted.length > 0,
            exhaustedJobIds: exhausted.map((entry) => entry.id),
          },
        },
      });
      return exhausted;
    }, CUSTOMER_MEMORY_WORKER_TRANSACTION_OPTIONS);
    if (exhaustedJobs.length) {
      await reportExhaustedJobs({
        businessId: job.businessId,
        businessAccountId: job.business.businessAccountId,
        leadId: job.leadId,
        conversationId: job.conversationId,
        jobIds: exhaustedJobs.map((entry) => entry.id),
        errorCode: code,
      });
    }
  }
}

async function reconcileRequiredProfiles(limit: number) {
  const profiles = await prisma.customerMemoryProfile.findMany({
    where: {
      memoryEnabled: true,
      reconciliationRequiredAt: { not: null },
      lead: { deletedAt: null },
    },
    orderBy: { reconciliationRequiredAt: "asc" },
    take: limit,
    select: { businessId: true, leadId: true },
  });
  for (const profile of profiles) {
    try {
      await customerMemoryResolverService.resolve({
        businessId: profile.businessId,
        leadId: profile.leadId,
        mode: "RECONCILE",
      });
      await cacheService.delByPattern(`business:${profile.businessId}:ai-context:*`);
    } catch (error) {
      console.warn("Customer memory reconciliation failed", {
        businessId: profile.businessId,
        leadId: profile.leadId,
        errorCode: errorCode(error),
      });
    }
  }
}

async function recoverStaleProcessingJobs(staleBefore: Date, ambiguousBatchIds: string[]) {
  const batchFilter = ambiguousBatchIds.length
    ? { processingBatchId: { notIn: ambiguousBatchIds } }
    : {};
  const candidates = await prisma.customerMemoryExtractionJob.findMany({
    where: {
      status: CustomerMemoryExtractionStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
      attemptCount: { gte: MAX_ATTEMPTS },
      ...batchFilter,
    },
    select: {
      id: true,
      businessId: true,
      leadId: true,
      conversationId: true,
      business: { select: { businessAccountId: true } },
    },
  });
  const exhaustedAt = new Date();
  const exhausted = candidates.length
    ? await prisma.$transaction(async (tx) => {
        const changed = await tx.customerMemoryExtractionJob.updateManyAndReturn({
          where: {
            id: { in: candidates.map((candidate) => candidate.id) },
            status: CustomerMemoryExtractionStatus.PROCESSING,
            processingStartedAt: { lt: staleBefore },
            attemptCount: { gte: MAX_ATTEMPTS },
          },
          data: {
            status: CustomerMemoryExtractionStatus.EXHAUSTED,
            processingStartedAt: null,
            processingBatchId: null,
            nextAttemptAt: null,
            lastErrorCode: "STALE_PROCESSING_EXHAUSTED",
            lastErrorAt: exhaustedAt,
            finalErrorCode: "STALE_PROCESSING_EXHAUSTED",
            exhaustedAt,
          },
          select: { id: true, businessId: true, leadId: true, conversationId: true },
        });
        if (changed.length) {
          await tx.auditLog.createMany({
            data: changed.map((entry) => ({
              businessId: entry.businessId,
              action: AuditAction.CUSTOMER_MEMORY_EXTRACTION_FAILED,
              metadata: {
                leadId: entry.leadId,
                conversationId: entry.conversationId,
                jobId: entry.id,
                attemptCount: MAX_ATTEMPTS,
                errorCode: "STALE_PROCESSING_EXHAUSTED",
                terminal: true,
              },
            })),
          });
        }
        return changed;
      }, CUSTOMER_MEMORY_WORKER_TRANSACTION_OPTIONS)
    : [];

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const groups = new Map<string, ExhaustedJobDiagnostic>();
  for (const entry of exhausted) {
    const candidate = candidateById.get(entry.id);
    if (!candidate) continue;
    const key = `${entry.businessId}:${entry.leadId}:${entry.conversationId}`;
    const group = groups.get(key) ?? {
      businessId: entry.businessId,
      businessAccountId: candidate.business.businessAccountId,
      leadId: entry.leadId,
      conversationId: entry.conversationId,
      jobIds: [],
      errorCode: "STALE_PROCESSING_EXHAUSTED",
    };
    group.jobIds.push(entry.id);
    groups.set(key, group);
  }
  for (const group of groups.values()) await reportExhaustedJobs(group);

  await prisma.customerMemoryExtractionJob.updateMany({
    where: {
      status: CustomerMemoryExtractionStatus.PROCESSING,
      processingStartedAt: { lt: staleBefore },
      attemptCount: { lt: MAX_ATTEMPTS },
      ...batchFilter,
    },
    data: {
      status: CustomerMemoryExtractionStatus.FAILED,
      processingStartedAt: null,
      processingBatchId: null,
      nextAttemptAt: new Date(),
      lastErrorCode: "STALE_PROCESSING_RECOVERED",
      lastErrorAt: new Date(),
    },
  });
}

export const customerMemoryWorkerService = {
  async tick() {
    if (running) return;
    running = true;
    try {
      const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
      const reservationRecovery = await aiUsageService.reconcileStaleCustomerMemoryReservations(staleBefore);
      if (reservationRecovery.ambiguousBatchIds.length) {
        await prisma.customerMemoryExtractionJob.updateMany({
          where: {
            status: CustomerMemoryExtractionStatus.PROCESSING,
            processingBatchId: { in: reservationRecovery.ambiguousBatchIds },
          },
          data: {
            status: CustomerMemoryExtractionStatus.FAILED,
            processingStartedAt: null,
            processingBatchId: null,
            lastErrorCode: AI_USAGE_RECONCILIATION_REQUIRED,
            lastErrorAt: new Date(),
          },
        });
      }
      await recoverStaleProcessingJobs(staleBefore, reservationRecovery.ambiguousBatchIds);
      await customerMemoryRetentionService.maintain(env.CUSTOMER_MEMORY_WORKER_PROCESS_BATCH_SIZE);
      await reconcileRequiredProfiles(env.CUSTOMER_MEMORY_WORKER_PROCESS_BATCH_SIZE);
      await discoverMessages();
      for (let index = 0; index < env.CUSTOMER_MEMORY_WORKER_PROCESS_BATCH_SIZE; index += 1) {
        // Reserve every third slot for durable backlog so live traffic stays responsive
        // without starving historical recovery work.
        const processingBatchId = await claimNextBatch(index % 3 !== 2);
        if (!processingBatchId) break;
        await processBatch(processingBatchId);
      }
    } catch (error) {
      if (!isDatabaseUnavailableError(error)) console.error("Customer memory worker tick failed", error);
    } finally {
      running = false;
    }
  },

  start() {
    if (!env.CUSTOMER_MEMORY_WORKER_ENABLED || timer) return;
    timer = setInterval(() => void this.tick(), env.CUSTOMER_MEMORY_WORKER_INTERVAL_SECONDS * 1_000);
    timer.unref?.();
    void this.tick();
    console.info("Customer memory worker started", { intervalSeconds: env.CUSTOMER_MEMORY_WORKER_INTERVAL_SECONDS });
  },

  stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  },
};
