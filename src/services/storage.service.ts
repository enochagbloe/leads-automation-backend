import crypto from "node:crypto";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { KnowledgeStorageProvider } from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

type StoredFileInput = {
  businessId: string;
  fileName: string;
  contentType: string;
  buffer: Buffer;
  folder?: string;
  objectKey?: string;
  storageProvider?: KnowledgeStorageProvider;
};

type StoredFilePathInput = Omit<StoredFileInput, "buffer"> & {
  sourcePath: string;
  fileSize: number;
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

let s3Client: S3Client | null = null;

function s3() {
  if (s3Client) return s3Client;
  s3Client = new S3Client({
    ...(env.KNOWLEDGE_S3_ENDPOINT ? { endpoint: env.KNOWLEDGE_S3_ENDPOINT } : {}),
    region: env.KNOWLEDGE_S3_REGION,
    forcePathStyle: env.KNOWLEDGE_S3_FORCE_PATH_STYLE,
    ...(env.KNOWLEDGE_S3_ACCESS_KEY_ID && env.KNOWLEDGE_S3_SECRET_ACCESS_KEY
      ? {
        credentials: {
          accessKeyId: env.KNOWLEDGE_S3_ACCESS_KEY_ID,
          secretAccessKey: env.KNOWLEDGE_S3_SECRET_ACCESS_KEY,
        },
      }
      : {}),
  });
  return s3Client;
}

function s3Bucket() {
  return env.KNOWLEDGE_S3_BUCKET!;
}

async function streamToBuffer(body: unknown) {
  const stream = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!stream?.transformToByteArray) throw new AppError(503, "Stored file is unavailable.", "STORAGE_UNAVAILABLE");
  return Buffer.from(await stream.transformToByteArray());
}

export function isStorageObjectNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return candidate.$metadata?.httpStatusCode === 404
    || candidate.name === "NotFound"
    || candidate.name === "NoSuchKey"
    || candidate.Code === "NoSuchKey"
    || candidate.code === "ENOENT";
}

export function configuredKnowledgeStorageProvider() {
  return env.KNOWLEDGE_STORAGE_PROVIDER === "s3"
    ? KnowledgeStorageProvider.S3_COMPATIBLE
    : KnowledgeStorageProvider.LOCAL_PRIVATE;
}

export const storageService = {
  publicRoot: storageRoot(),

  async uploadBuffer(input: StoredFileInput) {
    const fileName = safeFileName(input.fileName, input.contentType);
    const key = input.objectKey ?? path.posix.join(input.businessId, input.folder ?? "documents", `${crypto.randomUUID()}-${fileName}`);
    const effectiveProvider = input.storageProvider ?? configuredKnowledgeStorageProvider();
    if (effectiveProvider === KnowledgeStorageProvider.S3_COMPATIBLE) {
      await s3().send(new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: key,
        Body: input.buffer,
        ContentType: input.contentType,
        Metadata: { businessid: input.businessId },
      }));
      return {
        fileKey: key,
        fileUrl: "",
        fileName,
        mimeType: input.contentType,
        fileSize: input.buffer.byteLength,
        storageProvider: KnowledgeStorageProvider.S3_COMPATIBLE,
      };
    }
    const target = path.join(storageRoot(), key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, input.buffer);
    return {
      fileKey: key,
      fileUrl: "",
      fileName,
      mimeType: input.contentType,
      fileSize: input.buffer.byteLength,
      storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
    };
  },

  async uploadFile(input: StoredFilePathInput) {
    const fileName = safeFileName(input.fileName, input.contentType);
    const key = input.objectKey ?? path.posix.join(input.businessId, input.folder ?? "documents", `${crypto.randomUUID()}-${fileName}`);
    const effectiveProvider = input.storageProvider ?? configuredKnowledgeStorageProvider();
    if (effectiveProvider === KnowledgeStorageProvider.S3_COMPATIBLE) {
      await new Upload({
        client: s3(),
        params: {
          Bucket: s3Bucket(),
          Key: key,
          Body: createReadStream(input.sourcePath),
          ContentLength: input.fileSize,
          ContentType: input.contentType,
          Metadata: { businessid: input.businessId },
        },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      }).done();
      return {
        fileKey: key,
        fileUrl: "",
        fileName,
        mimeType: input.contentType,
        fileSize: input.fileSize,
        storageProvider: KnowledgeStorageProvider.S3_COMPATIBLE,
      };
    }
    const target = path.join(storageRoot(), key);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(input.sourcePath, target);
    return {
      fileKey: key,
      fileUrl: "",
      fileName,
      mimeType: input.contentType,
      fileSize: input.fileSize,
      storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
    };
  },

  async readBuffer(fileKey: string, provider?: KnowledgeStorageProvider) {
    const effectiveProvider = provider ?? configuredKnowledgeStorageProvider();
    if (effectiveProvider === KnowledgeStorageProvider.S3_COMPATIBLE) {
      const response = await s3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: fileKey }));
      return streamToBuffer(response.Body);
    }
    return readFile(resolveFileKey(fileKey));
  },

  async downloadToFile(
    fileKey: string,
    destinationPath: string,
    provider?: KnowledgeStorageProvider,
    maximumBytes = env.KNOWLEDGE_UPLOAD_MAX_BYTES,
  ) {
    const effectiveProvider = provider ?? configuredKnowledgeStorageProvider();
    let source: Readable;
    if (effectiveProvider === KnowledgeStorageProvider.S3_COMPATIBLE) {
      const response = await s3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: fileKey }));
      const body = response.Body as AsyncIterable<Uint8Array> | undefined;
      if (!body?.[Symbol.asyncIterator]) {
        throw new AppError(503, "Stored file is unavailable.", "STORAGE_UNAVAILABLE");
      }
      source = Readable.from(body);
    } else {
      source = createReadStream(resolveFileKey(fileKey));
    }

    const hash = crypto.createHash("sha256");
    let fileSize = 0;
    const meter = new Transform({
      transform(chunk: Buffer | Uint8Array | string, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        fileSize += buffer.byteLength;
        if (fileSize > maximumBytes) {
          callback(new AppError(413, "The stored file exceeds the extraction limit.", "KNOWLEDGE_DOCUMENT_FILE_TOO_LARGE"));
          return;
        }
        hash.update(buffer);
        callback(null, buffer);
      },
    });
    await pipeline(source, meter, createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }));
    return { fileSize, checksum: hash.digest("hex") };
  },

  async statFile(fileKey: string, provider?: KnowledgeStorageProvider) {
    const effectiveProvider = provider ?? configuredKnowledgeStorageProvider();
    if (effectiveProvider === KnowledgeStorageProvider.S3_COMPATIBLE) {
      const response = await s3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: fileKey }));
      return { fileSize: response.ContentLength ?? 0 };
    }
    const info = await stat(resolveFileKey(fileKey));
    return { fileSize: info.size };
  },

  async deleteFile(fileKey: string, provider?: KnowledgeStorageProvider) {
    const effectiveProvider = provider ?? configuredKnowledgeStorageProvider();
    if (effectiveProvider === KnowledgeStorageProvider.S3_COMPATIBLE) {
      await s3().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: fileKey }));
      return;
    }
    await unlink(resolveFileKey(fileKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      throw error;
    });
  },

  async createSignedDownloadUrl(fileKey: string, fileName: string, provider: KnowledgeStorageProvider, expiresInSeconds = env.KNOWLEDGE_DOWNLOAD_URL_TTL_SECONDS) {
    if (provider !== KnowledgeStorageProvider.S3_COMPATIBLE) return null;
    return getSignedUrl(s3(), new GetObjectCommand({
      Bucket: s3Bucket(),
      Key: fileKey,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    }), { expiresIn: expiresInSeconds });
  },
};

export async function resolveStorageObjectProvider(
  fileKey: string,
  provider?: KnowledgeStorageProvider | null,
) {
  if (provider) return provider;
  const preferred = configuredKnowledgeStorageProvider();
  let preferredError: unknown;
  try {
    await storageService.statFile(fileKey, preferred);
    return preferred;
  } catch (error) {
    if (!isStorageObjectNotFoundError(error)) throw error;
    preferredError = error;
  }
  const legacy = preferred === KnowledgeStorageProvider.S3_COMPATIBLE
    ? KnowledgeStorageProvider.LOCAL_PRIVATE
    : KnowledgeStorageProvider.S3_COMPATIBLE;
  if (legacy === KnowledgeStorageProvider.S3_COMPATIBLE && !env.KNOWLEDGE_S3_BUCKET) {
    throw preferredError;
  }
  await storageService.statFile(fileKey, legacy);
  return legacy;
}
