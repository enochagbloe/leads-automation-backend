import {
  AuditAction,
  BusinessRole,
  CustomerMemoryCategory,
  CustomerMemorySourceType,
  CustomerMemoryStatus,
  CustomerMemorySuppressionMode,
  CustomerMemoryTruthType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { cacheService } from "../cache.service";
import { isBackendOwnedCustomerMemory } from "./customer-memory-category-policy";
import { CustomerMemoryActor, ExtractedMemory } from "./customer-memory.types";
import { customerMemoryResolverService } from "./customer-memory-resolver.service";
import { usableCustomerMemoryPolicyWhere } from "./customer-memory-sensitive-data-policy";
import { customerMemoryStoreService, lockCustomerMemoryLeadScope } from "./customer-memory-store.service";

function assertManager(role: BusinessRole) {
  if (role !== BusinessRole.BUSINESS_OWNER && role !== BusinessRole.MANAGER) {
    throw new AppError(403, "Customer memory is available to owners and managers.", "CUSTOMER_MEMORY_FORBIDDEN");
  }
}

async function assertLead(businessId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId, deletedAt: null }, select: { id: true } });
  if (!lead) throw new AppError(404, "Customer memory not found.", "CUSTOMER_MEMORY_NOT_FOUND");
}

async function invalidateMemoryContext(businessId: string) {
  await cacheService.delByPattern(`business:${businessId}:ai-context:*`);
}

const FORGOTTEN_MEMORY_DATA = {
  valueText: "[REDACTED]",
  structuredValue: Prisma.DbNull,
  sourceStatement: null,
  activeKey: null,
  status: CustomerMemoryStatus.DELETED,
} satisfies Prisma.CustomerMemoryItemUpdateManyMutationInput;

function invalidateStoredSummary(deletedAt: Date, reason: string) {
  return {
    conversationSummary: null,
    summaryConversationId: null,
    summaryUpdatedAt: null,
    reconciliationRequiredAt: deletedAt,
    reconciliationReason: reason,
    memoryRevision: { increment: 1 },
  } satisfies Prisma.CustomerMemoryProfileUpdateManyMutationInput;
}

type DeletionAuditItem = {
  id: string;
  category: CustomerMemoryCategory;
  memoryKey: string;
};

async function createDeletionAudits(
  tx: Prisma.TransactionClient,
  actor: CustomerMemoryActor,
  items: DeletionAuditItem[],
  deletedAt: Date,
) {
  if (!items.length) return;
  await tx.auditLog.createMany({
    data: items.map((item) => ({
      businessId: actor.businessId,
      actorMembershipId: actor.membershipId,
      action: AuditAction.CUSTOMER_MEMORY_DELETED,
      metadata: {
        memoryId: item.id,
        category: item.category,
        memoryKey: item.memoryKey,
        deletedAt: deletedAt.toISOString(),
      },
    })),
  });
}

export const customerMemoryManagementService = {
  async detail(actor: CustomerMemoryActor & { role: BusinessRole }, leadId: string, includeHistory = false) {
    assertManager(actor.role);
    await assertLead(actor.businessId, leadId);
    const runtime = await customerMemoryResolverService.resolve({
      businessId: actor.businessId,
      leadId,
      mode: "RUNTIME_READ_ONLY",
    });
    const items = await prisma.customerMemoryItem.findMany({
      where: {
        businessId: actor.businessId,
        leadId,
        ...usableCustomerMemoryPolicyWhere(),
        ...(includeHistory
          ? { status: { not: CustomerMemoryStatus.DELETED }, deletedAt: null }
          : { status: CustomerMemoryStatus.ACTIVE, activeKey: "ACTIVE", deletedAt: null }),
      },
      orderBy: { learnedAt: "desc" },
      take: includeHistory ? 200 : 100,
    });
    return { runtime, items };
  },

  async correct(actor: CustomerMemoryActor & { role: BusinessRole }, leadId: string, memoryId: string, input: ExtractedMemory) {
    assertManager(actor.role);
    await assertLead(actor.businessId, leadId);
    const existing = await prisma.customerMemoryItem.findFirst({
      where: {
        id: memoryId,
        businessId: actor.businessId,
        leadId,
        deletedAt: null,
        ...usableCustomerMemoryPolicyWhere(),
      },
    });
    if (!existing) throw new AppError(404, "Customer memory item not found.", "CUSTOMER_MEMORY_ITEM_NOT_FOUND");
    if (isBackendOwnedCustomerMemory(existing)) {
      throw new AppError(
        409,
        "This memory is controlled by backend state. Update the lead, appointment, assignment, or human-takeover source instead.",
        "CUSTOMER_MEMORY_BACKEND_OWNED",
        { category: existing.category, sourceType: existing.sourceType },
      );
    }
    const profile = await prisma.customerMemoryProfile.findUnique({
      where: { businessId_leadId: { businessId: actor.businessId, leadId } },
      select: { memoryEnabled: true },
    });
    if (profile?.memoryEnabled === false) throw new AppError(409, "Customer memory has been deleted.", "CUSTOMER_MEMORY_DISABLED");
    const result = await customerMemoryStoreService.apply({
      businessId: actor.businessId,
      leadId,
      conversationId: existing.sourceConversationId,
      memories: [{
        ...input,
        operation: "UPSERT",
        category: existing.category,
        memoryKey: existing.memoryKey,
        truthType: CustomerMemoryTruthType.STAFF_CONFIRMED,
        sourceType: CustomerMemorySourceType.MANUAL_CORRECTION,
      }],
      actorMembershipId: actor.membershipId,
      writeAuthority: "MANUAL",
      force: true,
    });
    await invalidateMemoryContext(actor.businessId);
    return result;
  },

  async deleteItem(actor: CustomerMemoryActor & { role: BusinessRole }, leadId: string, memoryId: string) {
    assertManager(actor.role);
    const deleted = await prisma.$transaction(async (tx) => {
      await lockCustomerMemoryLeadScope(tx, actor.businessId, leadId);
      const item = await tx.customerMemoryItem.findFirst({
        where: { id: memoryId, businessId: actor.businessId, leadId, deletedAt: null },
        select: {
          id: true,
          category: true,
          memoryKey: true,
          sourceConversationId: true,
          sourceMessageId: true,
        },
      });
      if (!item) return null;
      const deletedAt = new Date();
      const suppressionMode = item.sourceMessageId
        ? CustomerMemorySuppressionMode.SOURCE_OCCURRENCE
        : CustomerMemorySuppressionMode.MEMORY_KEY;
      const suppressionKey = suppressionMode === CustomerMemorySuppressionMode.SOURCE_OCCURRENCE
        ? `occurrence:${item.category}:${item.memoryKey}`
        : `key:${item.category}:${item.memoryKey}`;
      await tx.customerMemoryItemTombstone.upsert({
        where: {
          businessId_leadId_suppressionKey: {
            businessId: actor.businessId,
            leadId,
            suppressionKey,
          },
        },
        create: {
          businessId: actor.businessId,
          leadId,
          deletedMemoryId: item.id,
          category: item.category,
          memoryKey: item.memoryKey,
          mode: suppressionMode,
          suppressionKey,
          sourceConversationId: item.sourceConversationId,
          sourceMessageId: item.sourceMessageId,
          suppressThrough: suppressionMode === CustomerMemorySuppressionMode.SOURCE_OCCURRENCE ? deletedAt : null,
          deletedByMembershipId: actor.membershipId,
          deletedAt,
        },
        update: {
          deletedMemoryId: item.id,
          sourceConversationId: item.sourceConversationId,
          sourceMessageId: item.sourceMessageId,
          suppressThrough: suppressionMode === CustomerMemorySuppressionMode.SOURCE_OCCURRENCE ? deletedAt : null,
          deletedByMembershipId: actor.membershipId,
          deletedAt,
        },
      });
      const itemsToDelete = await tx.customerMemoryItem.findMany({
        where: {
          businessId: actor.businessId,
          leadId,
          category: item.category,
          memoryKey: item.memoryKey,
          deletedAt: null,
        },
        select: { id: true, category: true, memoryKey: true },
      });
      const changed = await tx.customerMemoryItem.updateMany({
        where: {
          businessId: actor.businessId,
          leadId,
          category: item.category,
          memoryKey: item.memoryKey,
          deletedAt: null,
        },
        data: { ...FORGOTTEN_MEMORY_DATA, deletedAt },
      });
      if (changed.count === 0) return null;
      await tx.customerMemoryProfile.upsert({
        where: { businessId_leadId: { businessId: actor.businessId, leadId } },
        create: {
          businessId: actor.businessId,
          leadId,
          memoryRevision: 1,
          reconciliationRequiredAt: deletedAt,
          reconciliationReason: "MEMORY_ITEM_DELETED",
        },
        update: invalidateStoredSummary(deletedAt, "MEMORY_ITEM_DELETED"),
      });
      await createDeletionAudits(tx, actor, itemsToDelete, deletedAt);
      return item;
    });
    if (!deleted) throw new AppError(404, "Customer memory item not found.", "CUSTOMER_MEMORY_ITEM_NOT_FOUND");
    await invalidateMemoryContext(actor.businessId);
    return { deleted: true, suppressionMode: deleted.sourceMessageId
      ? CustomerMemorySuppressionMode.SOURCE_OCCURRENCE
      : CustomerMemorySuppressionMode.MEMORY_KEY };
  },

  async archiveItem(actor: CustomerMemoryActor & { role: BusinessRole }, leadId: string, memoryId: string) {
    assertManager(actor.role);
    const archived = await prisma.$transaction(async (tx) => {
      await lockCustomerMemoryLeadScope(tx, actor.businessId, leadId);
      const item = await tx.customerMemoryItem.findFirst({
        where: {
          id: memoryId,
          businessId: actor.businessId,
          leadId,
          deletedAt: null,
          status: { notIn: [CustomerMemoryStatus.ARCHIVED, CustomerMemoryStatus.DELETED] },
        },
        select: { id: true, category: true, memoryKey: true },
      });
      if (!item) return null;
      const archivedAt = new Date();
      const changed = await tx.customerMemoryItem.updateMany({
        where: { id: item.id, businessId: actor.businessId, leadId, deletedAt: null, status: { not: CustomerMemoryStatus.DELETED } },
        data: { status: CustomerMemoryStatus.ARCHIVED, activeKey: null },
      });
      if (changed.count !== 1) return null;
      await tx.customerMemoryProfile.upsert({
        where: { businessId_leadId: { businessId: actor.businessId, leadId } },
        create: {
          businessId: actor.businessId,
          leadId,
          memoryRevision: 1,
          reconciliationRequiredAt: archivedAt,
          reconciliationReason: "MEMORY_ITEM_ARCHIVED",
        },
        update: invalidateStoredSummary(archivedAt, "MEMORY_ITEM_ARCHIVED"),
      });
      await tx.auditLog.create({
        data: {
          businessId: actor.businessId,
          actorMembershipId: actor.membershipId,
          action: AuditAction.CUSTOMER_MEMORY_ARCHIVED,
          metadata: {
            memoryId: item.id,
            category: item.category,
            memoryKey: item.memoryKey,
            archivedAt: archivedAt.toISOString(),
          },
        },
      });
      return item;
    });
    if (!archived) throw new AppError(404, "Customer memory item not found.", "CUSTOMER_MEMORY_ITEM_NOT_FOUND");
    await invalidateMemoryContext(actor.businessId);
    return { archived: true };
  },

  async deleteCustomerMemory(actor: CustomerMemoryActor & { role: BusinessRole }, leadId: string) {
    assertManager(actor.role);
    await assertLead(actor.businessId, leadId);
    const result = await prisma.$transaction(async (tx) => {
      await lockCustomerMemoryLeadScope(tx, actor.businessId, leadId);
      const deletedAt = new Date();
      const items = await tx.customerMemoryItem.findMany({
        where: { businessId: actor.businessId, leadId, deletedAt: null },
        select: { id: true, category: true, memoryKey: true },
      });
      const changed = await tx.customerMemoryItem.updateMany({
        where: { businessId: actor.businessId, leadId, deletedAt: null },
        data: { ...FORGOTTEN_MEMORY_DATA, deletedAt },
      });
      await tx.customerMemoryProfile.upsert({
        where: { businessId_leadId: { businessId: actor.businessId, leadId } },
        create: { businessId: actor.businessId, leadId, memoryEnabled: false, memoryRevision: 1, deletedAt },
        update: {
          memoryEnabled: false,
          memoryRevision: { increment: 1 },
          deletedAt,
          conversationSummary: null,
          summaryConversationId: null,
          summaryUpdatedAt: null,
          reconciliationRequiredAt: null,
          reconciliationReason: null,
        },
      });
      await tx.customerMemoryExtractionJob.updateMany({
        where: { businessId: actor.businessId, leadId, status: { not: "COMPLETED" } },
        data: { status: "COMPLETED", completedAt: new Date(), processingStartedAt: null, lastErrorCode: "CUSTOMER_MEMORY_DELETED" },
      });
      await createDeletionAudits(tx, actor, items, deletedAt);
      return changed.count;
    });
    await invalidateMemoryContext(actor.businessId);
    return { deleted: true, deletedItemCount: result };
  },

  async deleteConversationMemory(actor: CustomerMemoryActor & { role: BusinessRole }, leadId: string, conversationId: string) {
    assertManager(actor.role);
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, businessId: actor.businessId, leadId }, select: { id: true } });
    if (!conversation) throw new AppError(404, "Conversation memory not found.", "CUSTOMER_MEMORY_NOT_FOUND");
    const changed = await prisma.$transaction(async (tx) => {
      await lockCustomerMemoryLeadScope(tx, actor.businessId, leadId);
      const deletedAt = new Date();
      await tx.customerMemoryConversationTombstone.upsert({
        where: { conversationId },
        create: {
          businessId: actor.businessId,
          leadId,
          conversationId,
          deletedByMembershipId: actor.membershipId,
          deletedAt,
        },
        update: {
          deletedByMembershipId: actor.membershipId,
          deletedAt,
        },
      });
      const items = await tx.customerMemoryItem.findMany({
        where: { businessId: actor.businessId, leadId, sourceConversationId: conversationId, deletedAt: null },
        select: { id: true, category: true, memoryKey: true },
      });
      const redacted = await tx.customerMemoryItem.updateMany({
        where: { businessId: actor.businessId, leadId, sourceConversationId: conversationId, deletedAt: null },
        data: { ...FORGOTTEN_MEMORY_DATA, deletedAt },
      });
      await tx.customerMemoryExtractionJob.updateMany({
        where: { businessId: actor.businessId, leadId, conversationId, status: { not: "COMPLETED" } },
        data: { status: "COMPLETED", completedAt: new Date(), processingStartedAt: null, lastErrorCode: "CONVERSATION_MEMORY_DELETED" },
      });
      await tx.customerMemoryProfile.upsert({
        where: { businessId_leadId: { businessId: actor.businessId, leadId } },
        create: {
          businessId: actor.businessId,
          leadId,
          memoryRevision: 1,
          reconciliationRequiredAt: deletedAt,
          reconciliationReason: "CONVERSATION_MEMORY_DELETED",
        },
        update: invalidateStoredSummary(deletedAt, "CONVERSATION_MEMORY_DELETED"),
      });
      await createDeletionAudits(tx, actor, items, deletedAt);
      return redacted.count;
    });
    await invalidateMemoryContext(actor.businessId);
    return { deleted: true, deletedItemCount: changed };
  },

  async regenerateSummary(actor: CustomerMemoryActor & { role: BusinessRole }, leadId: string) {
    assertManager(actor.role);
    await assertLead(actor.businessId, leadId);
    const profile = await prisma.customerMemoryProfile.findUnique({
      where: { businessId_leadId: { businessId: actor.businessId, leadId } },
      select: { memoryEnabled: true },
    });
    if (profile?.memoryEnabled === false) throw new AppError(409, "Customer memory has been deleted.", "CUSTOMER_MEMORY_DISABLED");
    await prisma.customerMemoryProfile.updateMany({
      where: { businessId: actor.businessId, leadId },
      data: { conversationSummary: null, summaryUpdatedAt: null },
    });
    return customerMemoryResolverService.resolve({
      businessId: actor.businessId,
      leadId,
      mode: "RECONCILE",
    });
  },
};
