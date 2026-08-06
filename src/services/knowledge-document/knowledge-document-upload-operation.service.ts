import {
  KnowledgeDocumentUploadOperation,
  KnowledgeDocumentUploadOperationStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";

type TransactionClient = Prisma.TransactionClient;

export type KnowledgeDocumentUploadResponse = {
  document: unknown;
  duplicate: boolean;
  duplicateWarning: { code: string; existingDocumentId: string | null } | null;
  idempotentReplay: boolean;
};

function snapshot(value: KnowledgeDocumentUploadResponse) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function completedSnapshot(value: Prisma.JsonValue | null): KnowledgeDocumentUploadResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(
      409,
      "The completed upload result is unavailable.",
      "KNOWLEDGE_DOCUMENT_UPLOAD_RESULT_UNAVAILABLE",
    );
  }
  const candidate = value as Record<string, unknown>;
  if (!candidate.document || typeof candidate.document !== "object" || Array.isArray(candidate.document)) {
    throw new AppError(
      409,
      "The completed upload result is unavailable.",
      "KNOWLEDGE_DOCUMENT_UPLOAD_RESULT_UNAVAILABLE",
    );
  }
  return candidate as KnowledgeDocumentUploadResponse;
}

export function knowledgeDocumentUploadInProgressResponse(operation: Pick<
  KnowledgeDocumentUploadOperation,
  "documentId" | "versionId"
>) {
  return {
    code: "UPLOAD_IN_PROGRESS" as const,
    status: KnowledgeDocumentUploadOperationStatus.UPLOADING,
    documentId: operation.documentId,
    versionId: operation.versionId,
    retryable: true,
  };
}

export function resolveKnowledgeDocumentUploadReplay(
  operation: KnowledgeDocumentUploadOperation,
  requestChecksum: string,
) {
  if (operation.requestChecksum !== requestChecksum) {
    throw new AppError(
      409,
      "This idempotency key was already used for a different file.",
      "KNOWLEDGE_DOCUMENT_IDEMPOTENCY_CONFLICT",
    );
  }
  if (operation.status === KnowledgeDocumentUploadOperationStatus.UPLOADING) {
    return {
      statusCode: 202 as const,
      response: knowledgeDocumentUploadInProgressResponse(operation),
    };
  }
  if (operation.status === KnowledgeDocumentUploadOperationStatus.COMPLETED) {
    return {
      statusCode: 201 as const,
      response: completedSnapshot(operation.resultSnapshot),
    };
  }
  throw new AppError(
    operation.failureStatusCode ?? 503,
    operation.failureMessage ?? "The document upload failed.",
    operation.failureCode ?? "KNOWLEDGE_DOCUMENT_UPLOAD_FAILED",
    { documentId: operation.documentId, retryable: false },
  );
}

export const knowledgeDocumentUploadOperationService = {
  async find(tx: TransactionClient, businessId: string, idempotencyKey: string) {
    return tx.knowledgeDocumentUploadOperation.findUnique({
      where: { businessId_idempotencyKey: { businessId, idempotencyKey } },
    });
  },

  async create(tx: TransactionClient, input: {
    id: string;
    businessId: string;
    idempotencyKey: string;
    requestChecksum: string;
    documentId: string;
    versionId: string;
    duplicateDocumentId: string | null;
  }) {
    return tx.knowledgeDocumentUploadOperation.create({ data: input });
  },

  async complete(tx: TransactionClient, operationId: string, response: KnowledgeDocumentUploadResponse) {
    const changed = await tx.knowledgeDocumentUploadOperation.updateMany({
      where: {
        id: operationId,
        status: KnowledgeDocumentUploadOperationStatus.UPLOADING,
      },
      data: {
        status: KnowledgeDocumentUploadOperationStatus.COMPLETED,
        resultSnapshot: snapshot(response),
        failureStatusCode: null,
        failureCode: null,
        failureMessage: null,
        completedAt: new Date(),
      },
    });
    if (changed.count !== 1) {
      throw new AppError(
        409,
        "The upload operation changed before completion.",
        "KNOWLEDGE_DOCUMENT_UPLOAD_OPERATION_CHANGED",
      );
    }
  },

  async completeByVersion(tx: TransactionClient, input: {
    businessId: string;
    versionId: string;
    response: KnowledgeDocumentUploadResponse;
  }) {
    return tx.knowledgeDocumentUploadOperation.updateMany({
      where: {
        businessId: input.businessId,
        versionId: input.versionId,
        status: KnowledgeDocumentUploadOperationStatus.UPLOADING,
      },
      data: {
        status: KnowledgeDocumentUploadOperationStatus.COMPLETED,
        resultSnapshot: snapshot(input.response),
        completedAt: new Date(),
      },
    });
  },

  async fail(input: {
    operationId: string | null;
    businessId: string;
    statusCode: number;
    code: string;
    message: string;
  }) {
    if (!input.operationId) return;
    await prisma.knowledgeDocumentUploadOperation.updateMany({
      where: {
        id: input.operationId,
        businessId: input.businessId,
        status: KnowledgeDocumentUploadOperationStatus.UPLOADING,
      },
      data: {
        status: KnowledgeDocumentUploadOperationStatus.FAILED,
        failureStatusCode: input.statusCode,
        failureCode: input.code,
        failureMessage: input.message.slice(0, 300),
        completedAt: new Date(),
      },
    });
  },

  async failByVersion(tx: TransactionClient, input: {
    businessId: string;
    versionId: string;
    statusCode: number;
    code: string;
    message: string;
  }) {
    return tx.knowledgeDocumentUploadOperation.updateMany({
      where: {
        businessId: input.businessId,
        versionId: input.versionId,
        status: KnowledgeDocumentUploadOperationStatus.UPLOADING,
      },
      data: {
        status: KnowledgeDocumentUploadOperationStatus.FAILED,
        failureStatusCode: input.statusCode,
        failureCode: input.code,
        failureMessage: input.message.slice(0, 300),
        completedAt: new Date(),
      },
    });
  },
};
