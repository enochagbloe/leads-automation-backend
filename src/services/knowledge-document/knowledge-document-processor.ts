import { KnowledgeStorageProvider } from "@prisma/client";
import {
  knowledgeDocumentAnalysisService,
  KnowledgeDocumentAnalysisResult,
} from "./knowledge-document-analysis.service";
import {
  knowledgeDocumentTextExtractionService,
  KnowledgeTextExtractionResult,
} from "./knowledge-document-text-extraction.service";

export type KnowledgeDocumentProcessingInput = {
  processingJobId: string;
  processingAttempt: number;
  processingLeaseId: string;
  businessId: string;
  documentId: string;
  versionId: string;
  versionNumber: number;
  storageProvider: KnowledgeStorageProvider;
  storageObjectKey: string;
  originalFileName: string;
  safeFileName: string;
  fileExtension: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
};

export type KnowledgeDocumentExtractor = (
  input: KnowledgeDocumentProcessingInput,
) => Promise<KnowledgeTextExtractionResult>;

export type KnowledgeDocumentAnalyzer = (
  input: KnowledgeDocumentProcessingInput & { extraction: KnowledgeTextExtractionResult },
) => Promise<KnowledgeDocumentAnalysisResult>;

const defaultExtractor: KnowledgeDocumentExtractor = (input) => knowledgeDocumentTextExtractionService.extract(input);
const defaultAnalyzer: KnowledgeDocumentAnalyzer = (input) => knowledgeDocumentAnalysisService.analyze(input);

let extractor = defaultExtractor;
let analyzer = defaultAnalyzer;

export function registerKnowledgeDocumentExtractor(next: KnowledgeDocumentExtractor | null) {
  extractor = next ?? defaultExtractor;
}

export function registerKnowledgeDocumentAnalyzer(next: KnowledgeDocumentAnalyzer | null) {
  analyzer = next ?? defaultAnalyzer;
}

export function getKnowledgeDocumentExtractor() {
  return extractor;
}

export function getKnowledgeDocumentAnalyzer() {
  return analyzer;
}
