export const KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION = "knowledge-text-v2-security-v2";

export function knowledgeDocumentExtractionIsReusable(input: {
  status: string;
  extractorVersion: string | null;
  normalizedText: string | null;
  contentHash: string | null;
}) {
  return input.status === "COMPLETED"
    && input.extractorVersion === KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION
    && Boolean(input.normalizedText)
    && Boolean(input.contentHash);
}
