import path from "node:path";

export function knowledgeDocumentStorageKey(input: {
  businessId: string;
  documentId: string;
  versionId: string;
  safeFileName: string;
}) {
  return path.posix.join(
    "businesses",
    input.businessId,
    "knowledge",
    input.documentId,
    "versions",
    input.versionId,
    input.safeFileName,
  );
}
