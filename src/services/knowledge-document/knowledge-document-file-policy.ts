import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { AppError } from "../../utils/errors";
import { validateOfficeDocumentArchive } from "./knowledge-document-office-archive-policy";

type FileRule = {
  mimeTypes: readonly string[];
};

export type KnowledgeDocumentUploadedFile = {
  originalname: string;
  mimetype: string;
  path: string;
  size: number;
};

const RULES: Record<string, FileRule> = {
  pdf: {
    mimeTypes: ["application/pdf"],
  },
  docx: {
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  },
  xlsx: {
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  },
  pptx: {
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  },
  txt: { mimeTypes: ["text/plain"] },
  csv: { mimeTypes: ["text/csv", "application/csv", "text/plain"] },
  png: {
    mimeTypes: ["image/png"],
  },
  jpg: {
    mimeTypes: ["image/jpeg"],
  },
  jpeg: {
    mimeTypes: ["image/jpeg"],
  },
  webp: {
    mimeTypes: ["image/webp"],
  },
};

async function inspectFile(filePath: string, extension: string) {
  const handle = await open(filePath, "r");
  let fileSize: number;
  let header: Buffer;
  let tail: Buffer;
  try {
    const info = await handle.stat();
    fileSize = info.size;
    header = Buffer.alloc(Math.min(fileSize, 16));
    tail = Buffer.alloc(Math.min(fileSize, 4096));
    if (header.length) await handle.read(header, 0, header.length, 0);
    if (tail.length) await handle.read(tail, 0, tail.length, Math.max(0, fileSize - tail.length));
  } finally {
    await handle.close();
  }

  const hash = crypto.createHash("sha256");
  let containsNull = false;
  let validUtf8 = true;
  let streamedBytes = 0;
  const decoder = extension === "txt" || extension === "csv"
    ? new TextDecoder("utf-8", { fatal: true })
    : null;

  for await (const value of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    streamedBytes += chunk.byteLength;
    hash.update(chunk);
    if (decoder) {
      containsNull ||= chunk.includes(0);
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        validUtf8 = false;
      }
    }
  }
  if (decoder && validUtf8) {
    try {
      decoder.decode();
    } catch {
      validUtf8 = false;
    }
  }

  const signatureValid = extension === "pdf"
    ? header.subarray(0, 5).toString("ascii") === "%PDF-" && tail.includes(Buffer.from("%%EOF"))
    : extension === "docx" || extension === "xlsx" || extension === "pptx"
      ? true
      : extension === "txt" || extension === "csv"
        ? !containsNull && validUtf8
        : extension === "png"
          ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : extension === "jpg" || extension === "jpeg"
            ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
            : extension === "webp"
              ? header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP"
              : false;

  return {
    checksum: hash.digest("hex"),
    fileSize,
    signatureValid: signatureValid && streamedBytes === fileSize,
  };
}

export const KNOWLEDGE_DOCUMENT_ALLOWED_MIME_TYPES = Array.from(new Set(
  Object.values(RULES).flatMap((rule) => rule.mimeTypes),
));

export function safeKnowledgeFileName(originalFileName: string, extension: string) {
  const base = path.parse(path.basename(originalFileName)).name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "document";
  return `${base}.${extension}`;
}

export async function validateKnowledgeDocumentFile(
  uploadedFile: KnowledgeDocumentUploadedFile,
  maximumBytes: number,
) {
  const originalFileName = path.basename(uploadedFile.originalname);
  const extension = path.extname(originalFileName).slice(1).toLowerCase();
  const rule = RULES[extension];
  if (!rule) {
    throw new AppError(422, "This document format is not supported.", "KNOWLEDGE_DOCUMENT_UNSUPPORTED_FILE_TYPE", {
      supportedExtensions: Object.keys(RULES),
    });
  }
  if (!rule.mimeTypes.includes(uploadedFile.mimetype)) {
    throw new AppError(422, "The file MIME type does not match an approved document format.", "KNOWLEDGE_DOCUMENT_INVALID_MIME_TYPE");
  }
  if (uploadedFile.size <= 0) {
    throw new AppError(422, "The uploaded document is empty.", "KNOWLEDGE_DOCUMENT_EMPTY_FILE");
  }
  if (uploadedFile.size > maximumBytes) {
    throw new AppError(413, "The document exceeds your plan's file-size limit.", "KNOWLEDGE_DOCUMENT_FILE_TOO_LARGE", {
      currentUsage: 0,
      limit: maximumBytes,
      attemptedAmount: uploadedFile.size,
    });
  }
  const inspected = await inspectFile(uploadedFile.path, extension);
  if (inspected.fileSize !== uploadedFile.size || !inspected.signatureValid) {
    throw new AppError(422, "The document is corrupted or its contents do not match its file type.", "KNOWLEDGE_DOCUMENT_INVALID_SIGNATURE");
  }
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") {
    await validateOfficeDocumentArchive(uploadedFile.path, extension);
  }
  return {
    filePath: uploadedFile.path,
    originalFileName,
    safeFileName: safeKnowledgeFileName(originalFileName, extension),
    extension,
    mimeType: uploadedFile.mimetype,
    fileSize: inspected.fileSize,
    checksum: inspected.checksum,
  };
}
