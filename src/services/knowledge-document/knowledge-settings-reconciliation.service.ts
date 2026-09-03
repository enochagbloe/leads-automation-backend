import {
  AuditAction,
  KnowledgeFactGovernanceStatus,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  Prisma,
  BusinessRole,
} from "@prisma/client";
import { enqueueKnowledgeRuntimeRefresh } from "./knowledge-runtime-refresh.service";
import { realtimeService } from "../realtime.service";

type ReconciliationField = {
  canonicalField: string;
  value: unknown;
  normalizedValue?: string | null;
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalize(value: unknown) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

export function knowledgeSettingBindingIsOutdated(input: {
  normalizedDocumentValue: string | null;
  documentValue: unknown;
  factValueText?: string | null;
  normalizedSettingsValue?: string | null;
  settingsValue: unknown;
}) {
  const previous = input.normalizedDocumentValue ?? normalize(input.documentValue ?? input.factValueText);
  const next = input.normalizedSettingsValue ?? normalize(input.settingsValue);
  return previous !== next;
}

export async function reconcileKnowledgeAfterSettingsMutation(
  tx: Prisma.TransactionClient,
  input: {
    businessId: string;
    actorUserId: string;
    actorMembershipId: string;
    canonicalEntityType: "SERVICE" | "BUSINESS_PROFILE" | "BUSINESS_AVAILABILITY" | "APPOINTMENT_SETTINGS";
    canonicalEntityId?: string | null;
    fields: ReconciliationField[];
    invalidateAllLinkedFacts?: boolean;
  },
) {
  const changedFields = new Map(input.fields.map((field) => [field.canonicalField, field]));
  if (changedFields.size === 0 && !input.invalidateAllLinkedFacts) return { factIds: [], documentIds: [], reviewIds: [] };

  const bindings = await tx.knowledgeGovernanceReview.findMany({
    where: {
      businessId: input.businessId,
      canonicalEntityType: input.canonicalEntityType,
      ...(input.canonicalEntityId !== undefined
        ? { canonicalEntityId: input.canonicalEntityId }
        : {}),
      ...(input.invalidateAllLinkedFacts ? {} : { canonicalField: { in: [...changedFields.keys()] } }),
      reviewStatus: KnowledgeGovernanceReviewStatus.RESOLVED,
      fact: { governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
      version: { isActive: true },
      document: { deletedAt: null },
    },
    select: {
      id: true,
      factId: true,
      documentId: true,
      versionId: true,
      priority: true,
      canonicalEntityId: true,
      canonicalField: true,
      normalizedDocumentValue: true,
      documentValue: true,
      fact: { select: { id: true, valueText: true } },
    },
  });

  const outdated = bindings.filter((binding) => {
    if (!binding.factId || !binding.canonicalField) return false;
    if (input.invalidateAllLinkedFacts) return true;
    const next = changedFields.get(binding.canonicalField);
    if (!next) return false;
    return knowledgeSettingBindingIsOutdated({
      normalizedDocumentValue: binding.normalizedDocumentValue,
      documentValue: binding.documentValue,
      factValueText: binding.fact?.valueText,
      normalizedSettingsValue: next.normalizedValue,
      settingsValue: next.value,
    });
  });
  if (outdated.length === 0) return { factIds: [], documentIds: [], reviewIds: [] };

  const factIds = [...new Set(outdated.flatMap((item) => item.factId ? [item.factId] : []))];
  const documentIds = [...new Set(outdated.map((item) => item.documentId))];
  const versionIds = [...new Set(outdated.map((item) => item.versionId))];
  await tx.knowledgeDocumentFact.updateMany({
    where: { businessId: input.businessId, id: { in: factIds }, governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
    data: { governanceStatus: KnowledgeFactGovernanceStatus.OUTDATED, governedAt: new Date() },
  });
  await Promise.all([
    tx.knowledgeDocument.updateMany({
      where: { businessId: input.businessId, id: { in: documentIds }, deletedAt: null },
      data: { governanceStatus: KnowledgeGovernanceStatus.OUTDATED },
    }),
    tx.knowledgeDocumentVersion.updateMany({
      where: { businessId: input.businessId, id: { in: versionIds } },
      data: { governanceStatus: KnowledgeGovernanceStatus.OUTDATED },
    }),
  ]);

  const reviewIds: string[] = [];
  for (const binding of outdated) {
    const field = changedFields.get(binding.canonicalField!) ?? { value: null, normalizedValue: "" };
    const comparisonKey = `settings_changed:${binding.factId}:${binding.canonicalEntityId ?? "none"}:${binding.canonicalField}`;
    const review = await tx.knowledgeGovernanceReview.upsert({
      where: { businessId_versionId_comparisonKey: { businessId: input.businessId, versionId: binding.versionId, comparisonKey } },
      create: {
        businessId: input.businessId,
        documentId: binding.documentId,
        versionId: binding.versionId,
        factId: binding.factId,
        comparisonKey,
        comparisonType: KnowledgeGovernanceComparisonType.SETTINGS_CHANGED,
        priority: binding.priority,
        reviewStatus: KnowledgeGovernanceReviewStatus.PENDING_REVIEW,
        canonicalEntityType: input.canonicalEntityType,
        canonicalEntityId: input.canonicalEntityId ?? binding.canonicalEntityId,
        canonicalField: binding.canonicalField,
        existingValue: json(field.value),
        documentValue: binding.documentValue ?? undefined,
        normalizedExistingValue: field.normalizedValue ?? normalize(field.value),
        normalizedDocumentValue: binding.normalizedDocumentValue,
        requiresHumanReview: true,
        blocksAiUse: false,
        resolutionReason: "SETTINGS_CHANGED_AFTER_APPROVAL",
      },
      update: {
        reviewStatus: KnowledgeGovernanceReviewStatus.PENDING_REVIEW,
        existingValue: json(field.value),
        normalizedExistingValue: field.normalizedValue ?? normalize(field.value),
        requiresHumanReview: true,
        blocksAiUse: false,
        reviewedAt: null,
        reviewedByMembershipId: null,
        resolutionAction: null,
        resolutionReason: "SETTINGS_CHANGED_AFTER_APPROVAL",
      },
      select: { id: true },
    });
    reviewIds.push(review.id);
  }

  for (const documentId of documentIds) {
    await enqueueKnowledgeRuntimeRefresh(tx, { businessId: input.businessId, documentId });
  }
  await tx.auditLog.create({
    data: {
      action: AuditAction.KNOWLEDGE_SETTINGS_RECONCILED,
      businessId: input.businessId,
      userId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      metadata: json({
        reason: "SETTINGS_CHANGED_AFTER_APPROVAL",
        canonicalEntityType: input.canonicalEntityType,
        canonicalEntityId: input.canonicalEntityId ?? null,
        fields: [...changedFields.keys()],
        factIds,
        documentIds,
        reviewIds,
      }),
    },
  });
  await tx.auditLog.create({
    data: {
      action: AuditAction.KNOWLEDGE_FACT_MARKED_OUTDATED,
      businessId: input.businessId,
      userId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      metadata: json({ reason: "SETTINGS_CHANGED_AFTER_APPROVAL", factIds, documentIds, reviewIds }),
    },
  });
  return { factIds, documentIds, reviewIds };
}

export function publishKnowledgeSettingsReconciliation(
  businessId: string,
  result: { factIds: string[]; documentIds: string[]; reviewIds: string[] } | null,
) {
  if (!result || result.factIds.length === 0) return;
  const updatedAt = new Date().toISOString();
  for (const factId of result.factIds) {
    realtimeService.publish({
      type: "business.knowledge.fact.outdated",
      businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: { factId, status: "OUTDATED", updatedAt },
    });
  }
  for (const documentId of result.documentIds) {
    realtimeService.publish({
      type: "business.knowledge.document.outdated",
      businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: { documentId, status: "OUTDATED", updatedAt },
    });
  }
  realtimeService.publish({
    type: "business.knowledge.settings_reconciled",
    businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { factIds: result.factIds, documentIds: result.documentIds, reviewItemIds: result.reviewIds, updatedAt },
  });
  realtimeService.publish({
    type: "business.knowledge.runtime_guard.updated",
    businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { documentIds: result.documentIds, status: "OUTDATED", updatedAt },
  });
}
