import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { prisma } from "../src/config/prisma";
import {
  knowledgeDocumentUploadOperationService,
  KnowledgeDocumentUploadResponse,
  resolveKnowledgeDocumentUploadReplay,
} from "../src/services/knowledge-document/knowledge-document-upload-operation.service";

test("simultaneous upload requests share one operation and replay its committed snapshot", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const business = await prisma.business.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });
  assert.ok(business, "This integration test requires one test business.");
  const businessId = business.id;

  const suffix = crypto.randomUUID();
  const idempotencyKey = `knowledge-upload-${suffix}`;
  const checksum = `checksum-${suffix}`;
  const documentId = `document-${suffix}`;
  const versionId = `version-${suffix}`;

  async function reserve(operationId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('knowledge_document_upload'), hashtext(${businessId}))`;
      const existing = await knowledgeDocumentUploadOperationService.find(
        tx,
        businessId,
        idempotencyKey,
      );
      if (existing) return { owner: false as const, operation: existing };
      const operation = await knowledgeDocumentUploadOperationService.create(tx, {
        id: operationId,
        businessId,
        idempotencyKey,
        requestChecksum: checksum,
        documentId,
        versionId,
        duplicateDocumentId: null,
      });
      return { owner: true as const, operation };
    });
  }

  try {
    const reservations = await Promise.all([
      reserve(`operation-a-${suffix}`),
      reserve(`operation-b-${suffix}`),
    ]);
    assert.equal(reservations.filter((reservation) => reservation.owner).length, 1);
    assert.equal(reservations.filter((reservation) => !reservation.owner).length, 1);

    const replay = reservations.find((reservation) => !reservation.owner);
    assert.ok(replay);
    assert.deepEqual(resolveKnowledgeDocumentUploadReplay(replay.operation, checksum), {
      statusCode: 202,
      response: {
        code: "UPLOAD_IN_PROGRESS",
        status: "UPLOADING",
        documentId,
        versionId,
        retryable: true,
      },
    });

    const owner = reservations.find((reservation) => reservation.owner);
    assert.ok(owner);
    const committedResponse: KnowledgeDocumentUploadResponse = {
      document: {
        id: documentId,
        processingStatus: "QUEUED",
        title: "Committed title",
      },
      duplicate: false,
      duplicateWarning: null,
      idempotentReplay: false,
    };
    await prisma.$transaction((tx) => knowledgeDocumentUploadOperationService.complete(
      tx,
      owner.operation.id,
      committedResponse,
    ));

    const completed = await prisma.knowledgeDocumentUploadOperation.findUniqueOrThrow({
      where: {
        businessId_idempotencyKey: {
          businessId,
          idempotencyKey,
        },
      },
    });
    assert.deepEqual(resolveKnowledgeDocumentUploadReplay(completed, checksum), {
      statusCode: 201,
      response: committedResponse,
    });
  } finally {
    await prisma.knowledgeDocumentUploadOperation.deleteMany({
      where: { businessId, idempotencyKey },
    });
  }
});
