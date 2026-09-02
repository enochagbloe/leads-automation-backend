import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { prisma } from "../src/config/prisma";
import { backfillKnowledgeGovernance } from "../src/services/knowledge-document/knowledge-governance-backfill.service";
import { loadCustomerSafeKnowledgeFacts } from "../src/services/knowledge-document/knowledge-approved-facts.service";
import { serviceService } from "../src/services/service.service";

test("legacy knowledge is governed, service archive withdraws facts, and revisions commit atomically", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const owner = await prisma.businessMember.findFirstOrThrow({ where: { role: "BUSINESS_OWNER", status: "ACTIVE" }, include: { business: true } });
  const businessId = owner.businessId;
  const suffix = crypto.randomUUID();
  const serviceId = `recovery-service-${suffix}`;
  const documentId = `recovery-doc-${suffix}`;
  const versionId = `recovery-version-${suffix}`;
  const actor = { businessId, businessAccountId: owner.business.businessAccountId, userId: owner.userId, membershipId: owner.id, role: owner.role };
  const revision = async () => (await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).knowledgeRuntimeRevision;
  try {
    const before = await revision();
    await prisma.service.create({ data: { id: serviceId, businessId, name: `Recovery consultation ${suffix}`, slug: `recovery-${suffix}`, basePrice: "500", currency: "GHS", priceType: "FIXED", isActive: true } });
    assert.ok(await revision() > before);
    const committed = await revision();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.service.update({ where: { id: serviceId }, data: { basePrice: "999" } });
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(await revision(), committed, "rolled-back mutations must not advance the revision");
    await prisma.knowledgeDocument.create({ data: {
      id: documentId, businessId, title: `Legacy ${suffix}`, fileUrl: "", fileName: "legacy.txt", mimeType: "text/plain", fileSize: 20,
      originalFileName: "legacy.txt", safeFileName: "legacy.txt", fileExtension: "txt", checksum: suffix,
      visibility: "CLIENT_SENDABLE", processingStatus: "READY", governanceStatus: "REVIEW_REQUIRED",
    } });
    await prisma.knowledgeDocumentVersion.create({ data: {
      id: versionId, businessId, documentId, versionNumber: 1, originalFileName: "legacy.txt", safeFileName: "legacy.txt", fileExtension: "txt",
      storageProvider: "LOCAL_PRIVATE", fileSize: 20, mimeType: "text/plain", checksum: suffix,
      processingStatus: "READY", governanceStatus: "REVIEW_REQUIRED", isActive: true,
    } });
    await prisma.knowledgeDocument.update({ where: { id: documentId }, data: { activeVersionId: versionId } });
    const extraction = await prisma.knowledgeDocumentExtraction.create({ data: { businessId, documentId, versionId, status: "COMPLETED", normalizedText: "Legacy pricing" } });
    const analysis = await prisma.knowledgeDocumentAnalysis.create({ data: { businessId, documentId, versionId, extractionId: extraction.id, status: "COMPLETED", detectedDocumentType: "PRICING_INFORMATION" } });
    const fact = await prisma.knowledgeDocumentFact.create({ data: {
      businessId, documentId, versionId, analysisId: analysis.id, factType: "PRICE", label: "Consultation price",
      valueText: `Recovery consultation ${suffix} GHS 500`, currency: "GHS", numericValue: "500", sourceKind: "DOCUMENT",
    } });
    await backfillKnowledgeGovernance(100);
    assert.equal((await prisma.knowledgeDocumentFact.findUniqueOrThrow({ where: { id: fact.id } })).governanceStatus, "APPROVED");
    assert.equal((await loadCustomerSafeKnowledgeFacts(businessId, { documentId })).length, 1);
    const reviews = await prisma.knowledgeGovernanceReview.count({ where: { documentId } });
    await backfillKnowledgeGovernance(100);
    assert.equal(await prisma.knowledgeGovernanceReview.count({ where: { documentId } }), reviews);
    await serviceService.archive(actor, serviceId, {});
    assert.equal((await prisma.knowledgeDocumentFact.findUniqueOrThrow({ where: { id: fact.id } })).governanceStatus, "OUTDATED");
    assert.equal((await loadCustomerSafeKnowledgeFacts(businessId, { documentId })).length, 0);
    await serviceService.restore(actor, serviceId, {});
    assert.equal((await loadCustomerSafeKnowledgeFacts(businessId, { documentId })).length, 0, "restore must not silently reapprove old facts");
  } finally {
    await prisma.knowledgeDocument.deleteMany({ where: { id: documentId } });
    await prisma.service.deleteMany({ where: { id: serviceId } });
    await prisma.$disconnect();
  }
});
