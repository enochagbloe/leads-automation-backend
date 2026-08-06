export type StaleUploadStorageState =
  | { state: "PRESENT"; fileSize: number }
  | { state: "MISSING" }
  | { state: "UNAVAILABLE" };

export type StaleUploadReconciliationDecision =
  | { action: "QUEUE" }
  | { action: "REMOVE_INCOMPLETE" }
  | { action: "DEFER" }
  | {
    action: "FAIL";
    errorCode: "KNOWLEDGE_DOCUMENT_STORAGE_KEY_MISMATCH"
      | "KNOWLEDGE_DOCUMENT_BUSINESS_SCOPE_MISMATCH"
      | "KNOWLEDGE_DOCUMENT_STORED_SIZE_MISMATCH";
    deleteExpectedObject: boolean;
  };

export function decideStaleUploadReconciliation(input: {
  ownershipMatches: boolean;
  expectedObjectKey: string;
  documentObjectKey: string | null;
  versionObjectKey: string | null;
  requireDocumentObjectKeyMatch?: boolean;
  expectedFileSize: number;
  storage: StaleUploadStorageState;
}): StaleUploadReconciliationDecision {
  if (!input.ownershipMatches) {
    return {
      action: "FAIL",
      errorCode: "KNOWLEDGE_DOCUMENT_BUSINESS_SCOPE_MISMATCH",
      deleteExpectedObject: false,
    };
  }
  if (
    (input.requireDocumentObjectKeyMatch !== false && input.documentObjectKey !== input.expectedObjectKey)
    || input.versionObjectKey !== input.expectedObjectKey
  ) {
    return {
      action: "FAIL",
      errorCode: "KNOWLEDGE_DOCUMENT_STORAGE_KEY_MISMATCH",
      deleteExpectedObject: false,
    };
  }
  if (input.storage.state === "UNAVAILABLE") return { action: "DEFER" };
  if (input.storage.state === "MISSING") return { action: "REMOVE_INCOMPLETE" };
  if (input.storage.fileSize !== input.expectedFileSize) {
    return {
      action: "FAIL",
      errorCode: "KNOWLEDGE_DOCUMENT_STORED_SIZE_MISMATCH",
      deleteExpectedObject: true,
    };
  }
  return { action: "QUEUE" };
}
