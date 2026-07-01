import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

type StoredFileInput = {
  businessId: string;
  fileName: string;
  contentType: string;
  buffer: Buffer;
  folder?: string;
};

function safeFileName(fileName: string, contentType: string) {
  const parsed = path.parse(fileName);
  const base = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "file";
  const ext = contentType === "application/pdf"
    ? ".pdf"
    : parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, "") || ".bin";
  return `${base}${ext}`;
}

function storageRoot() {
  return path.isAbsolute(env.KNOWLEDGE_STORAGE_DIR)
    ? env.KNOWLEDGE_STORAGE_DIR
    : path.join(process.cwd(), env.KNOWLEDGE_STORAGE_DIR);
}

function resolveFileKey(fileKey: string) {
  const root = path.resolve(storageRoot());
  const target = path.resolve(root, fileKey);
  if (!target.startsWith(root + path.sep)) {
    throw new AppError(400, "Invalid file key.", "INVALID_FILE_KEY");
  }
  return target;
}

export const storageService = {
  publicRoot: storageRoot(),

  async uploadBuffer(input: StoredFileInput) {
    const fileName = safeFileName(input.fileName, input.contentType);
    const key = path.join(input.businessId, input.folder ?? "documents", `${crypto.randomUUID()}-${fileName}`);
    const target = path.join(storageRoot(), key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.buffer);
    return {
      fileKey: key,
      fileUrl: "",
      fileName,
      mimeType: input.contentType,
      fileSize: input.buffer.byteLength,
    };
  },

  async readBuffer(fileKey: string) {
    return readFile(resolveFileKey(fileKey));
  },

  async statFile(fileKey: string) {
    const info = await stat(resolveFileKey(fileKey));
    return { fileSize: info.size };
  },

  async deleteFile(fileKey: string) {
    await unlink(resolveFileKey(fileKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      throw error;
    });
  },
};
