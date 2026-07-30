import {
  AuditAction,
  CustomerMemoryCategory,
  CustomerMemoryExtractionStatus,
  CustomerMemoryMissingDetailState,
  CustomerMemorySourceType,
  CustomerMemoryStatus,
  CustomerMemorySuppressionMode,
  CustomerMemoryTruthType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import {
  CustomerMemoryWriteAuthority,
  isBackendOwnedCustomerMemory,
  isMemoryCategoryAllowed,
  isMemoryTruthTypeAllowed,
  sourceTypeForMessageSender,
} from "./customer-memory-category-policy";
import { sanitizeExtractedCustomerMemory } from "./customer-memory-safety.service";
import {
  CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
  applyCustomerMemorySensitiveDataPolicy,
} from "./customer-memory-sensitive-data-policy";
import { ExtractedMemory } from "./customer-memory.types";

type Db = Prisma.TransactionClient;

const TRUTH_PRIORITY: Record<CustomerMemoryTruthType, number> = {
  BACKEND_CONFIRMED: 4,
  CUSTOMER_STATED: 3,
  STAFF_CONFIRMED: 2,
  AI_INFERRED: 1,
};

const TERMINAL_REQUEST_STATES = new Set<CustomerMemoryMissingDetailState>([
  CustomerMemoryMissingDetailState.PROVIDED,
  CustomerMemoryMissingDetailState.CANCELLED,
  CustomerMemoryMissingDetailState.NO_LONGER_REQUIRED,
  CustomerMemoryMissingDetailState.EXPIRED,
]);

// Applying a batch holds a lead-scoped advisory lock while it validates and
// persists each memory. Remote databases can exceed Prisma's 5-second default.
const CUSTOMER_MEMORY_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

function resolvedRequestState(memory: ExtractedMemory, existingState: CustomerMemoryMissingDetailState | null) {
  if (memory.missingDetailState && TERMINAL_REQUEST_STATES.has(memory.missingDetailState)) {
    return memory.missingDetailState;
  }
  if (memory.sourceType === CustomerMemorySourceType.CUSTOMER_MESSAGE) {
    return CustomerMemoryMissingDetailState.PROVIDED;
  }
  return existingState;
}

export function canResolveCustomerMemory(input: {
  incomingTruthType: CustomerMemoryTruthType;
  existingTruthType: CustomerMemoryTruthType;
  sourceType: CustomerMemorySourceType;
  force?: boolean;
}) {
  // AI output is untrusted input. It may only resolve facts that were also AI-inferred,
  // regardless of the truthType supplied by an extractor or future caller.
  if (
    input.sourceType === CustomerMemorySourceType.AI_MESSAGE
    && input.existingTruthType !== CustomerMemoryTruthType.AI_INFERRED
  ) {
    return false;
  }
  if (input.force) return true;
  return TRUTH_PRIORITY[input.incomingTruthType] >= TRUTH_PRIORITY[input.existingTruthType];
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sameMemoryValue(existing: { valueText: string; structuredValue: Prisma.JsonValue | null }, incoming: ExtractedMemory) {
  const sameText = existing.valueText.trim().toLowerCase() === incoming.valueText.trim().toLowerCase();
  const existingStructured = JSON.stringify(existing.structuredValue ?? null);
  const incomingStructured = JSON.stringify(incoming.structuredValue ?? null);
  return sameText && existingStructured === incomingStructured;
}

export async function lockCustomerMemoryLeadScope(tx: Db, businessId: string, leadId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-memory:${businessId}:${leadId}`}))`;
}

export const customerMemoryStoreService = {
  async apply(input: {
    businessId: string;
    leadId: string;
    conversationId?: string | null;
    messageId?: string | null;
    memories: ExtractedMemory[];
    actorMembershipId?: string | null;
    extractionJobId?: string | null;
    extractionBatchId?: string | null;
    writeAuthority: CustomerMemoryWriteAuthority;
    force?: boolean;
  }) {
    return prisma.$transaction(async (tx) => {
      await lockCustomerMemoryLeadScope(tx, input.businessId, input.leadId);
      if (input.force && input.writeAuthority !== "MANUAL") {
        throw new AppError(403, "Only an authorized manual correction may force a memory update.", "CUSTOMER_MEMORY_FORCE_NOT_ALLOWED");
      }
      if (input.writeAuthority === "MANUAL" && !input.actorMembershipId) {
        throw new AppError(403, "Manual memory corrections require an actor.", "CUSTOMER_MEMORY_CORRECTION_ACTOR_REQUIRED");
      }
      const extractionSources = new Map<string, { sourceType: CustomerMemorySourceType; createdAt: Date }>();
      if (input.extractionJobId) {
        const activeJob = await tx.customerMemoryExtractionJob.findFirst({
          where: {
            id: input.extractionJobId,
            businessId: input.businessId,
            leadId: input.leadId,
            conversationId: input.conversationId ?? undefined,
            messageId: input.messageId ?? undefined,
            status: CustomerMemoryExtractionStatus.PROCESSING,
          },
          select: { id: true, messageId: true, message: { select: { senderType: true, createdAt: true } } },
        });
        if (!activeJob) {
          return { created: 0, superseded: 0, conflicts: 0, skipped: "EXTRACTION_JOB_NOT_PROCESSING" as const };
        }
        const sourceType = sourceTypeForMessageSender(activeJob.message.senderType);
        if (sourceType) extractionSources.set(activeJob.messageId, { sourceType, createdAt: activeJob.message.createdAt });
      }
      if (input.extractionBatchId) {
        const activeJobs = await tx.customerMemoryExtractionJob.findMany({
          where: {
            processingBatchId: input.extractionBatchId,
            businessId: input.businessId,
            leadId: input.leadId,
            conversationId: input.conversationId ?? undefined,
            status: CustomerMemoryExtractionStatus.PROCESSING,
          },
          select: { messageId: true, message: { select: { senderType: true, createdAt: true } } },
        });
        for (const activeJob of activeJobs) {
          const sourceType = sourceTypeForMessageSender(activeJob.message.senderType);
          if (sourceType) extractionSources.set(activeJob.messageId, { sourceType, createdAt: activeJob.message.createdAt });
        }
      }
      if (input.writeAuthority === "EXTRACTION" && extractionSources.size === 0) {
        return { created: 0, superseded: 0, conflicts: 0, skipped: "EXTRACTION_SOURCE_NOT_VERIFIED" as const };
      }
      if (input.conversationId) {
        const tombstone = await tx.customerMemoryConversationTombstone.findFirst({
          where: {
            businessId: input.businessId,
            leadId: input.leadId,
            conversationId: input.conversationId,
          },
          select: { id: true },
        });
        if (tombstone) {
          return { created: 0, superseded: 0, conflicts: 0, skipped: "CONVERSATION_MEMORY_DELETED" as const };
        }
      }
      const disabledProfile = await tx.customerMemoryProfile.findUnique({
        where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
        select: { memoryEnabled: true },
      });
      if (disabledProfile?.memoryEnabled === false) {
        return { created: 0, superseded: 0, conflicts: 0, skipped: "CUSTOMER_MEMORY_DISABLED" as const };
      }
      if (!disabledProfile) {
        await tx.customerMemoryProfile.create({
          data: { businessId: input.businessId, leadId: input.leadId },
        });
      }

      let created = 0;
      let superseded = 0;
      let conflicts = 0;
      let rejected = 0;
      let updated = 0;
      let memoryChanged = false;
      for (const candidate of input.memories) {
        if (input.writeAuthority === "MANUAL" && isBackendOwnedCustomerMemory(candidate)) {
          throw new AppError(
            409,
            "This memory is controlled by backend state. Update the source entity instead.",
            "CUSTOMER_MEMORY_BACKEND_OWNED",
            { category: candidate.category, sourceType: candidate.sourceType },
          );
        }
        if (input.writeAuthority === "MANUAL" && candidate.operation === "RESOLVE") {
          throw new AppError(
            422,
            "Manual corrections must replace a memory value and cannot resolve it.",
            "CUSTOMER_MEMORY_MANUAL_RESOLVE_NOT_ALLOWED",
          );
        }
        const sourceMessageId = input.writeAuthority === "EXTRACTION"
          ? candidate.sourceMessageId ?? null
          : candidate.sourceMessageId ?? input.messageId ?? null;
        const verifiedSource = sourceMessageId ? extractionSources.get(sourceMessageId) : undefined;
        const sourceMatchesJob = input.writeAuthority !== "EXTRACTION"
          || candidate.sourceType === verifiedSource?.sourceType;
        const policyAllowed = sourceMatchesJob
          && isMemoryCategoryAllowed({
            authority: input.writeAuthority,
            sourceType: candidate.sourceType,
            category: candidate.category,
          })
          && isMemoryTruthTypeAllowed({
            authority: input.writeAuthority,
            sourceType: candidate.sourceType,
            truthType: candidate.truthType,
          });
        if (!policyAllowed) {
          if (input.writeAuthority !== "EXTRACTION") {
            throw new AppError(
              422,
              "The memory category or truth type is not allowed for this source.",
              "CUSTOMER_MEMORY_SOURCE_POLICY_VIOLATION",
              { category: candidate.category, sourceType: candidate.sourceType, writeAuthority: input.writeAuthority },
            );
          }
          rejected += 1;
          continue;
        }
        const sanitizedMemory = sanitizeExtractedCustomerMemory(candidate);
        if (!sanitizedMemory) {
          rejected += 1;
          continue;
        }
        const sensitiveDataResult = applyCustomerMemorySensitiveDataPolicy(sanitizedMemory);
        if (!sensitiveDataResult.memory) {
          rejected += 1;
          continue;
        }
        const memory = sensitiveDataResult.memory;
        const suppression = await tx.customerMemoryItemTombstone.findFirst({
          where: {
            businessId: input.businessId,
            leadId: input.leadId,
            category: memory.category,
            memoryKey: memory.memoryKey,
            OR: [
              { mode: CustomerMemorySuppressionMode.MEMORY_KEY },
              ...(verifiedSource ? [{
                mode: CustomerMemorySuppressionMode.SOURCE_OCCURRENCE,
                suppressThrough: { gte: verifiedSource.createdAt },
              }] : []),
              ...(sourceMessageId ? [{
                mode: CustomerMemorySuppressionMode.SOURCE_OCCURRENCE,
                sourceMessageId,
              }] : []),
            ],
          },
          select: { id: true },
        });
        if (suppression) {
          rejected += 1;
          continue;
        }
        const existing = await tx.customerMemoryItem.findFirst({
          where: {
            businessId: input.businessId,
            leadId: input.leadId,
            category: memory.category,
            memoryKey: memory.memoryKey,
            status: CustomerMemoryStatus.ACTIVE,
            activeKey: "ACTIVE",
          },
          orderBy: { learnedAt: "desc" },
        });
        if (input.writeAuthority === "MANUAL" && existing && isBackendOwnedCustomerMemory(existing)) {
          throw new AppError(
            409,
            "This memory is controlled by backend state. Update the source entity instead.",
            "CUSTOMER_MEMORY_BACKEND_OWNED",
            { category: existing.category, sourceType: existing.sourceType },
          );
        }

        if (memory.operation === "RESOLVE") {
          if (!existing) continue;
          const resolutionAllowed = canResolveCustomerMemory({
            incomingTruthType: memory.truthType,
            existingTruthType: existing.truthType,
            sourceType: memory.sourceType,
            force: input.force,
          });
          if (!resolutionAllowed) {
            await tx.customerMemoryItem.create({
              data: {
                businessId: input.businessId,
                leadId: input.leadId,
                sourceConversationId: input.conversationId ?? null,
                sourceMessageId,
                category: memory.category,
                memoryKey: memory.memoryKey,
                valueText: memory.valueText,
                structuredValue: memory.structuredValue,
                status: CustomerMemoryStatus.NEEDS_CLARIFICATION,
                activeKey: null,
                truthType: memory.truthType,
                sourceType: memory.sourceType,
                confidence: memory.confidence,
                missingDetailState: memory.missingDetailState,
                sourceStatement: memory.sourceStatement,
                sensitiveDataPolicy: sensitiveDataResult.policy,
                sensitiveDataPolicyVersion: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
                retentionExpiresAt: sensitiveDataResult.retentionExpiresAt,
                correctedByMembershipId: input.actorMembershipId ?? null,
              },
            });
            await tx.auditLog.create({
              data: {
                businessId: input.businessId,
                actorMembershipId: input.actorMembershipId ?? null,
                action: AuditAction.CUSTOMER_MEMORY_CONFLICT_DETECTED,
                metadata: json({
                  leadId: input.leadId,
                  memoryId: existing.id,
                  category: memory.category,
                  memoryKey: memory.memoryKey,
                  operation: "RESOLVE",
                  incomingTruthType: memory.truthType,
                  existingTruthType: existing.truthType,
                  sourceType: memory.sourceType,
                }),
              },
            });
            conflicts += 1;
            memoryChanged = true;
            continue;
          }
          await tx.customerMemoryItem.update({
            where: { id: existing.id },
            data: {
              status: CustomerMemoryStatus.RESOLVED,
              activeKey: null,
              resolvedAt: new Date(),
              sourceConversationId: input.conversationId ?? existing.sourceConversationId,
              sourceMessageId: sourceMessageId ?? existing.sourceMessageId,
              missingDetailState: resolvedRequestState(memory, existing.missingDetailState),
            },
          });
          await tx.auditLog.create({
            data: {
              businessId: input.businessId,
              actorMembershipId: input.actorMembershipId ?? null,
              action: AuditAction.CUSTOMER_MEMORY_RESOLVED,
              metadata: json({ leadId: input.leadId, memoryId: existing.id, category: memory.category, memoryKey: memory.memoryKey, sourceMessageId }),
            },
          });
          memoryChanged = true;
          continue;
        }

        if (existing && sameMemoryValue(existing, memory)) {
          const refreshesRequest = (
            memory.category === CustomerMemoryCategory.MISSING_DETAIL
            || memory.category === CustomerMemoryCategory.UNRESOLVED_REQUEST
          ) && memory.missingDetailState === CustomerMemoryMissingDetailState.REQUESTED;
          const retainedPolicy = refreshesRequest
            ? sensitiveDataResult
            : applyCustomerMemorySensitiveDataPolicy(memory, existing.learnedAt);
          if (!retainedPolicy.memory) {
            rejected += 1;
            continue;
          }
          const policyChanged = existing.valueText !== retainedPolicy.memory.valueText
            || JSON.stringify(existing.structuredValue ?? null) !== JSON.stringify(retainedPolicy.memory.structuredValue ?? null)
            || existing.sourceStatement !== (retainedPolicy.memory.sourceStatement ?? null)
            || existing.sensitiveDataPolicy !== retainedPolicy.policy
            || existing.sensitiveDataPolicyVersion !== CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION
            || existing.retentionExpiresAt?.getTime() !== retainedPolicy.retentionExpiresAt?.getTime();
          await tx.customerMemoryItem.update({
            where: { id: existing.id },
            data: {
              ...(refreshesRequest ? {
                sourceConversationId: input.conversationId ?? existing.sourceConversationId,
                sourceMessageId: sourceMessageId ?? existing.sourceMessageId,
                learnedAt: new Date(),
              } : {}),
              valueText: retainedPolicy.memory.valueText,
              structuredValue: retainedPolicy.memory.structuredValue,
              sourceStatement: retainedPolicy.memory.sourceStatement ?? null,
              sensitiveDataPolicy: retainedPolicy.policy,
              sensitiveDataPolicyVersion: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
              retentionExpiresAt: retainedPolicy.retentionExpiresAt,
            },
          });
          if (refreshesRequest || policyChanged) {
            updated += 1;
            memoryChanged = true;
          }
          continue;
        }

        const lowerPriorityConflict = existing
          && !input.force
          && TRUTH_PRIORITY[memory.truthType] < TRUTH_PRIORITY[existing.truthType];
        if (lowerPriorityConflict) {
          await tx.customerMemoryItem.create({
            data: {
              businessId: input.businessId,
              leadId: input.leadId,
              sourceConversationId: input.conversationId ?? null,
              sourceMessageId,
              category: memory.category,
              memoryKey: memory.memoryKey,
              valueText: memory.valueText,
              structuredValue: memory.structuredValue,
              status: CustomerMemoryStatus.NEEDS_CLARIFICATION,
              activeKey: null,
              truthType: memory.truthType,
              sourceType: memory.sourceType,
              confidence: memory.confidence,
              missingDetailState: memory.missingDetailState,
              sourceStatement: memory.sourceStatement,
              sensitiveDataPolicy: sensitiveDataResult.policy,
              sensitiveDataPolicyVersion: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
              retentionExpiresAt: sensitiveDataResult.retentionExpiresAt,
              correctedByMembershipId: input.actorMembershipId ?? null,
            },
          });
          await tx.auditLog.create({
            data: {
              businessId: input.businessId,
              actorMembershipId: input.actorMembershipId ?? null,
              action: AuditAction.CUSTOMER_MEMORY_CONFLICT_DETECTED,
              metadata: json({ leadId: input.leadId, category: memory.category, memoryKey: memory.memoryKey }),
            },
          });
          conflicts += 1;
          memoryChanged = true;
          continue;
        }

        if (existing) {
          await tx.customerMemoryItem.update({
            where: { id: existing.id },
            data: { status: CustomerMemoryStatus.SUPERSEDED, activeKey: null },
          });
        }
        const next = await tx.customerMemoryItem.create({
          data: {
            businessId: input.businessId,
            leadId: input.leadId,
            sourceConversationId: input.conversationId ?? null,
            sourceMessageId,
            category: memory.category,
            memoryKey: memory.memoryKey,
            valueText: memory.valueText,
            structuredValue: memory.structuredValue,
            status: CustomerMemoryStatus.ACTIVE,
            activeKey: "ACTIVE",
            truthType: memory.truthType,
            sourceType: memory.sourceType,
            confidence: memory.confidence,
            missingDetailState: memory.missingDetailState,
            sourceStatement: memory.sourceStatement,
            sensitiveDataPolicy: sensitiveDataResult.policy,
            sensitiveDataPolicyVersion: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
            retentionExpiresAt: sensitiveDataResult.retentionExpiresAt,
            supersedesId: existing?.id,
            correctedByMembershipId: input.actorMembershipId ?? null,
          },
        });
        if (existing) {
          await tx.customerMemoryItem.update({ where: { id: existing.id }, data: { supersededById: next.id } });
        }
        await tx.auditLog.create({
          data: {
            businessId: input.businessId,
            actorMembershipId: input.actorMembershipId ?? null,
            action: input.force
              ? AuditAction.CUSTOMER_MEMORY_MANUALLY_CORRECTED
              : existing ? AuditAction.CUSTOMER_MEMORY_SUPERSEDED : AuditAction.CUSTOMER_MEMORY_CREATED,
            metadata: json({ leadId: input.leadId, memoryId: next.id, category: memory.category, memoryKey: memory.memoryKey, replacedMemoryId: existing?.id }),
          },
        });
        created += 1;
        memoryChanged = true;
        if (existing) superseded += 1;
      }

      const extractionCompleted = input.writeAuthority === "EXTRACTION";
      if (memoryChanged || extractionCompleted) {
        const now = new Date();
        await tx.customerMemoryProfile.update({
          where: { businessId_leadId: { businessId: input.businessId, leadId: input.leadId } },
          data: {
            ...(extractionCompleted ? { lastExtractionAt: now } : {}),
            lastMeaningfulActivityAt: created > 0 ? now : undefined,
            ...(memoryChanged ? { memoryRevision: { increment: 1 } } : {}),
          },
        });
      }
      return { created, superseded, conflicts, rejected, updated };
    }, CUSTOMER_MEMORY_TRANSACTION_OPTIONS);
  },
};
