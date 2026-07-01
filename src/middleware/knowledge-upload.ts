import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import multer from "multer";
import { RequestHandler } from "express";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { uploadKnowledgeDocumentMetadataSchema } from "../validation/knowledge.schemas";

const tempDir = path.join(os.tmpdir(), "bizreplyai-knowledge-uploads");
mkdirSync(tempDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, tempDir),
    filename: (_req, file, callback) => {
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      callback(null, `${suffix}-${file.originalname.replace(/[^a-zA-Z0-9._-]+/g, "-")}`);
    },
  }),
  limits: {
    fileSize: env.KNOWLEDGE_UPLOAD_MAX_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype !== "application/pdf") {
      callback(Object.assign(new Error("Only PDF files are supported."), {
        statusCode: 422,
        code: "INVALID_FILE_TYPE",
      }));
      return;
    }
    callback(null, true);
  },
});

function parseJsonArray(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value.split(",").map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
}

function normalizeOptional(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

const uploadSingleKnowledgePdf = upload.single("file");

export const uploadKnowledgePdf: RequestHandler = (req, res, next) => {
  uploadSingleKnowledgePdf(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      const contentLength = Number(req.headers["content-length"]);
      return next(new AppError(413, "PDF is too large.", "KNOWLEDGE_UPLOAD_FILE_TOO_LARGE", {
        currentUsage: 0,
        limit: env.KNOWLEDGE_UPLOAD_MAX_BYTES,
        attemptedAmount: Number.isFinite(contentLength) && contentLength > 0
          ? contentLength
          : env.KNOWLEDGE_UPLOAD_MAX_BYTES + 1,
      }));
    }
    if (error) return next(error);
    return next();
  });
};

export const validateKnowledgeUploadMetadata: RequestHandler = (req, _res, next) => {
  if (!req.file) {
    return next(Object.assign(new Error("PDF file is required."), {
      statusCode: 422,
      code: "VALIDATION_ERROR",
      details: { file: ["PDF file is required."] },
    }));
  }
  const result = uploadKnowledgeDocumentMetadataSchema.safeParse({
    ...req.body,
    description: normalizeOptional(req.body.description),
    category: normalizeOptional(req.body.category),
    tags: parseJsonArray(req.body.tags),
    relatedServiceIds: parseJsonArray(req.body.relatedServiceIds),
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
  });
  if (!result.success) {
    return next(Object.assign(new Error("Validation failed"), {
      statusCode: 422,
      code: "VALIDATION_ERROR",
      details: result.error.flatten().fieldErrors,
    }));
  }
  req.body = result.data;
  next();
};
