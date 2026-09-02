import type { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";

export async function loadCustomerSafeKnowledgeFacts(
  businessId: string,
  options: { documentId?: string; ids?: string[]; query?: string; limit?: number } = {},
  db: Prisma.TransactionClient = prisma,
) {
  const facts = await db.knowledgeDocumentFact.findMany({
    where: {
      businessId, governanceStatus: "APPROVED",
      ...(options.documentId ? { documentId: options.documentId } : {}),
      ...(options.ids ? { id: { in: options.ids } } : {}),
      ...(options.query ? { OR: [
        { label: { contains: options.query, mode: "insensitive" as const } },
        { valueText: { contains: options.query, mode: "insensitive" as const } },
      ] } : {}),
      document: { status: "ACTIVE", deletedAt: null, visibility: "CLIENT_SENDABLE", processingStatus: { in: ["READY", "NEEDS_REVIEW"] } },
      version: { isActive: true, analysis: { is: { status: "COMPLETED" } } },
      governanceReviews: { none: { blocksAiUse: true, reviewStatus: { not: "RESOLVED" } } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: options.limit ?? 80,
    include: {
      document: { select: { title: true, activeVersionId: true } },
      governanceReviews: { select: { canonicalEntityType: true, canonicalEntityId: true } },
    },
  });
  const linkedServiceIds = (fact: typeof facts[number]) => [
    ...(fact.canonicalEntityType === "SERVICE" && fact.canonicalEntityId ? [fact.canonicalEntityId] : []),
    ...fact.governanceReviews.flatMap((review) => review.canonicalEntityType === "SERVICE" && review.canonicalEntityId ? [review.canonicalEntityId] : []),
  ];
  const ids = [...new Set(facts.flatMap(linkedServiceIds))];
  const active = ids.length ? await db.service.findMany({
    where: { businessId, id: { in: ids }, isActive: true, isArchived: false }, select: { id: true },
  }) : [];
  const activeIds = new Set(active.map((service) => service.id));
  return facts.filter((fact) => fact.versionId === fact.document.activeVersionId
    && linkedServiceIds(fact).every((id) => activeIds.has(id)));
}
