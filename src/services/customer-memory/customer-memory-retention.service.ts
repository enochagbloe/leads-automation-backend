import {
  AuditAction,
  CustomerMemoryCategory,
  CustomerMemoryMissingDetailState,
  CustomerMemoryStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { cacheService } from "../cache.service";
import { sanitizeExtractedCustomerMemory } from "./customer-memory-safety.service";
import {
  CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
  applyCustomerMemorySensitiveDataPolicy,
} from "./customer-memory-sensitive-data-policy";
import { lockCustomerMemoryLeadScope } from "./customer-memory-store.service";

const REDACTED_VALUE = "[REDACTED]";

async function maintainItem(itemId: string) {
  const result = await prisma.$transaction(async (tx) => {
    const initial = await tx.customerMemoryItem.findUnique({
      where: { id: itemId },
      select: { businessId: true, leadId: true },
    });
    if (!initial) return null;
    await lockCustomerMemoryLeadScope(tx, initial.businessId, initial.leadId);
    const item = await tx.customerMemoryItem.findUnique({ where: { id: itemId } });
    if (!item || item.status === CustomerMemoryStatus.DELETED) return null;

    const now = new Date();
    const expired = Boolean(item.retentionExpiresAt && item.retentionExpiresAt <= now);
    const sanitized = expired ? null : sanitizeExtractedCustomerMemory({
      category: item.category,
      memoryKey: item.memoryKey,
      valueText: item.valueText,
      structuredValue: item.structuredValue as Prisma.InputJsonValue | undefined,
      truthType: item.truthType,
      sourceType: item.sourceType,
      confidence: item.confidence ?? undefined,
      missingDetailState: item.missingDetailState ?? undefined,
      sourceStatement: item.sourceStatement ?? undefined,
    });
    const policyResult = sanitized
      ? applyCustomerMemorySensitiveDataPolicy(sanitized, item.learnedAt)
      : null;
    const mustForget = expired || !policyResult?.memory;
    const isRequestMemory = item.category === CustomerMemoryCategory.MISSING_DETAIL
      || item.category === CustomerMemoryCategory.UNRESOLVED_REQUEST;

    if (mustForget) {
      await tx.customerMemoryItem.update({
        where: { id: item.id },
        data: {
          valueText: REDACTED_VALUE,
          structuredValue: Prisma.JsonNull,
          sourceStatement: null,
          activeKey: null,
          status: CustomerMemoryStatus.DELETED,
          deletedAt: now,
          missingDetailState: expired && isRequestMemory
            ? CustomerMemoryMissingDetailState.EXPIRED
            : item.missingDetailState,
          sensitiveDataPolicy: policyResult?.policy ?? item.sensitiveDataPolicy,
          sensitiveDataPolicyVersion: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
          retentionExpiresAt: null,
        },
      });
      await tx.auditLog.create({
        data: {
          businessId: item.businessId,
          action: AuditAction.CUSTOMER_MEMORY_DELETED,
          metadata: {
            memoryId: item.id,
            leadId: item.leadId,
            category: item.category,
            memoryKey: item.memoryKey,
            reason: expired ? "RETENTION_EXPIRED" : "SENSITIVE_DATA_POLICY",
          },
        },
      });
    } else {
      await tx.customerMemoryItem.update({
        where: { id: item.id },
        data: {
          valueText: policyResult.memory.valueText,
          structuredValue: policyResult.memory.structuredValue ?? Prisma.JsonNull,
          sourceStatement: policyResult.memory.sourceStatement ?? null,
          sensitiveDataPolicy: policyResult.policy,
          sensitiveDataPolicyVersion: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION,
          retentionExpiresAt: policyResult.retentionExpiresAt,
        },
      });
    }

    await tx.customerMemoryProfile.updateMany({
      where: { businessId: item.businessId, leadId: item.leadId },
      data: {
        conversationSummary: null,
        summaryConversationId: null,
        summaryUpdatedAt: null,
        reconciliationRequiredAt: now,
        reconciliationReason: "CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_UPDATED",
        memoryRevision: { increment: 1 },
      },
    });
    return { businessId: item.businessId };
  });
  if (result) await cacheService.delByPattern(`business:${result.businessId}:ai-context:*`).catch(() => undefined);
}

export const customerMemoryRetentionService = {
  async maintain(limit = 50) {
    const now = new Date();
    const items = await prisma.customerMemoryItem.findMany({
      where: {
        status: { not: CustomerMemoryStatus.DELETED },
        OR: [
          { sensitiveDataPolicyVersion: null },
          { sensitiveDataPolicyVersion: { not: CUSTOMER_MEMORY_SENSITIVE_DATA_POLICY_VERSION } },
          { retentionExpiresAt: { lte: now } },
        ],
      },
      orderBy: [{ retentionExpiresAt: "asc" }, { createdAt: "asc" }],
      take: limit,
      select: { id: true },
    });
    for (const item of items) await maintainItem(item.id);
    return { processed: items.length };
  },
};
