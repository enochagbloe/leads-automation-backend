import {
  KnowledgeDocumentProcessingStatus,
  KnowledgeStorageProvider,
} from "@prisma/client";
import crypto from "node:crypto";
import { PDFParse } from "pdf-parse";
import { AppError } from "../../utils/errors";
import { storageService } from "../storage.service";

export type KnowledgeDocumentProcessingInput = {
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

export type KnowledgeDocumentProcessingResult = {
  processingStatus: typeof KnowledgeDocumentProcessingStatus.READY
    | typeof KnowledgeDocumentProcessingStatus.NEEDS_REVIEW;
  chunks: Array<{ chunkText: string; pageNumber: number | null; tokenCount: number }>;
  statusCode?: string | null;
  statusMessage?: string | null;
};

export type KnowledgeDocumentProcessor = (
  input: KnowledgeDocumentProcessingInput,
) => Promise<KnowledgeDocumentProcessingResult>;

const CHUNK_MAX_CHARS = 1_400;
const CHUNK_OVERLAP_CHARS = 160;
const CHUNK_LIMIT = 80;

function normalizedText(value: string) {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function textChunks(value: string) {
  const text = normalizedText(value);
  const chunks: KnowledgeDocumentProcessingResult["chunks"] = [];
  let start = 0;
  while (start < text.length && chunks.length < CHUNK_LIMIT) {
    const hardEnd = Math.min(text.length, start + CHUNK_MAX_CHARS);
    const slice = text.slice(start, hardEnd);
    const boundary = hardEnd < text.length
      ? Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "))
      : -1;
    const end = boundary > CHUNK_MAX_CHARS * 0.55 ? start + boundary + 1 : hardEnd;
    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        chunkText,
        pageNumber: null,
        tokenCount: Math.max(1, Math.ceil(chunkText.length / 4)),
      });
    }
    if (end >= text.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

async function extractPdf(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    return normalizedText((await parser.getText()).text ?? "");
  } finally {
    await parser.destroy();
  }
}

const defaultProcessor: KnowledgeDocumentProcessor = async (input) => {
  const buffer = await storageService.readBuffer(input.storageObjectKey, input.storageProvider);
  if (buffer.byteLength !== input.fileSize) {
    throw new AppError(409, "The stored document failed its integrity check.", "KNOWLEDGE_DOCUMENT_STORED_SIZE_MISMATCH");
  }
  if (crypto.createHash("sha256").update(buffer).digest("hex") !== input.checksum) {
    throw new AppError(409, "The stored document failed its integrity check.", "KNOWLEDGE_DOCUMENT_STORED_CHECKSUM_MISMATCH");
  }

  let extractedText: string | null = null;
  if (input.fileExtension === "txt" || input.fileExtension === "csv") {
    extractedText = normalizedText(buffer.toString("utf8"));
  } else if (input.fileExtension === "pdf") {
    extractedText = await extractPdf(buffer);
  }

  if (extractedText === null) {
    return {
      processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      chunks: [],
      statusCode: "KNOWLEDGE_DOCUMENT_SPECIALIZED_EXTRACTION_REQUIRED",
      statusMessage: "This file is stored safely but requires a specialized content extractor.",
    };
  }
  const chunks = textChunks(extractedText);
  if (!chunks.length) {
    return {
      processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      chunks: [],
      statusCode: "KNOWLEDGE_DOCUMENT_NO_EXTRACTABLE_TEXT",
      statusMessage: "No usable text could be extracted from this document.",
    };
  }
  return { processingStatus: KnowledgeDocumentProcessingStatus.READY, chunks };
};

let processor: KnowledgeDocumentProcessor = defaultProcessor;

export function registerKnowledgeDocumentProcessor(nextProcessor: KnowledgeDocumentProcessor | null) {
  processor = nextProcessor ?? defaultProcessor;
}

export function getKnowledgeDocumentProcessor() {
  return processor;
}
