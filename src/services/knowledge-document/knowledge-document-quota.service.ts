import { KnowledgeDocumentStatus, Prisma } from "@prisma/client";
import { AppError } from "../../utils/errors";
import {
  assertKnowledgeAssetCapacity,
  currentKnowledgeHubSubscription,
  knowledgeDocumentLimit,
  knowledgeStorageLimit,
  maximumKnowledgeFileSize,
} from "../knowledge-hub-capability.service";
import {
  assertKnowledgeStorageUsageMeasured,
  calculateKnowledgeStorageUsage,
} from "../knowledge-storage-usage.service";
import { KnowledgeDocumentActor } from "./knowledge-document.types";

export { maximumKnowledgeFileSize };

export async function currentKnowledgePlan(actor: KnowledgeDocumentActor, tx: Prisma.TransactionClient) {
  return currentKnowledgeHubSubscription(tx, actor.businessAccountId);
}

export async function assertKnowledgeDocumentCapacity(
  tx: Prisma.TransactionClient,
  actor: KnowledgeDocumentActor,
  attemptedBytes: number,
  increments: { assets?: number; documents?: number } = {},
) {
  const assetIncrement = increments.assets ?? 1;
  const documentIncrement = increments.documents ?? 1;
  const { subscription } = await assertKnowledgeAssetCapacity(tx, actor, assetIncrement);
  const [documentCount, storage] = await Promise.all([
    tx.knowledgeDocument.count({
      where: {
        business: { businessAccountId: actor.businessAccountId },
        status: KnowledgeDocumentStatus.ACTIVE,
        deletedAt: null,
      },
    }),
    calculateKnowledgeStorageUsage(tx, actor.businessAccountId),
  ]);
  const activeDocumentLimit = knowledgeDocumentLimit(subscription.plan.code);
  if (documentCount + documentIncrement > activeDocumentLimit) {
    throw new AppError(403, "Your plan's active document limit has been reached.", "KNOWLEDGE_DOCUMENT_LIMIT_REACHED", {
      currentPlan: subscription.plan.code,
      currentUsage: documentCount,
      limit: activeDocumentLimit,
    });
  }
  assertKnowledgeStorageUsageMeasured(storage);
  const currentStorage = storage.totalBytes;
  const maximumStorage = knowledgeStorageLimit(subscription.plan.code);
  if (currentStorage + attemptedBytes > maximumStorage) {
    throw new AppError(403, "Your plan's Knowledge Hub storage limit has been reached.", "KNOWLEDGE_STORAGE_LIMIT_REACHED", {
      currentPlan: subscription.plan.code,
      currentUsage: currentStorage,
      limit: maximumStorage,
      attemptedAmount: attemptedBytes,
    });
  }
  return { subscription, currentStorage, maximumStorage };
}
