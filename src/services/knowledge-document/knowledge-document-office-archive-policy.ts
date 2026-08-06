import path from "node:path";
import { Readable } from "node:stream";
import yauzl, { Entry, ZipFile } from "yauzl";
import { AppError } from "../../utils/errors";

const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_ENTRY_NAME_LENGTH = 512;

function archiveError(message: string, code: string) {
  return new AppError(422, message, code);
}

function openArchive(filePath: string) {
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(filePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, archive) => {
      if (error || !archive) {
        reject(archiveError("The Office document archive is malformed.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE"));
        return;
      }
      resolve(archive);
    });
  });
}

function assertSafeEntry(entry: Entry) {
  const name = entry.fileName;
  const segments = name.split("/");
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (
    !name
    || name.length > MAX_ENTRY_NAME_LENGTH
    || name.includes("\0")
    || name.includes("\\")
    || path.posix.isAbsolute(name)
    || segments.includes("..")
    || unixType === 0o120000
  ) {
    throw archiveError("The Office document contains an unsafe archive entry.", "KNOWLEDGE_DOCUMENT_UNSAFE_ARCHIVE_ENTRY");
  }
  if (entry.isEncrypted()) {
    throw archiveError("Encrypted Office documents are not supported.", "KNOWLEDGE_DOCUMENT_ENCRYPTED_ARCHIVE");
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw archiveError("The Office document uses an unsupported compression method.", "KNOWLEDGE_DOCUMENT_UNSUPPORTED_ARCHIVE_COMPRESSION");
  }
  if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    throw archiveError("The Office document expands beyond the per-file safety limit.", "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED");
  }
  const declaredRatio = entry.uncompressedSize === 0
    ? 0
    : entry.compressedSize === 0
      ? Number.POSITIVE_INFINITY
      : entry.uncompressedSize / entry.compressedSize;
  if (declaredRatio > MAX_COMPRESSION_RATIO) {
    throw archiveError("The Office document compression ratio exceeds the safety limit.", "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED");
  }
}

function openEntryStream(archive: ZipFile, entry: Entry) {
  return new Promise<Readable>((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(archiveError("The Office document contains an unreadable entry.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE"));
        return;
      }
      resolve(stream);
    });
  });
}

export async function validateOfficeDocumentArchive(
  filePath: string,
  extension: "docx" | "xlsx" | "pptx",
) {
  const archive = await openArchive(filePath);
  const requiredFolder = extension === "docx" ? "word/" : extension === "xlsx" ? "xl/" : "ppt/";
  if (archive.entryCount <= 0 || archive.entryCount > MAX_ARCHIVE_ENTRIES) {
    archive.close();
    throw archiveError("The Office document contains too many archive entries.", "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED");
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let totalDeclaredBytes = 0;
    let totalExpandedBytes = 0;
    let hasContentTypes = false;
    let hasRequiredFolder = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      archive.close();
      reject(error instanceof AppError
        ? error
        : archiveError("The Office document archive is malformed.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE"));
    };

    archive.on("error", fail);
    archive.on("end", () => {
      if (settled) return;
      settled = true;
      archive.close();
      if (!hasContentTypes || !hasRequiredFolder) {
        reject(archiveError("The file is not a valid Office document package.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE"));
        return;
      }
      resolve();
    });
    archive.on("entry", (entry: Entry) => {
      void (async () => {
        assertSafeEntry(entry);
        totalDeclaredBytes += entry.uncompressedSize;
        if (totalDeclaredBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          throw archiveError("The Office document expands beyond the total safety limit.", "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED");
        }
        hasContentTypes ||= entry.fileName === "[Content_Types].xml";
        hasRequiredFolder ||= entry.fileName.startsWith(requiredFolder);
        if (entry.fileName.endsWith("/")) {
          archive.readEntry();
          return;
        }

        const stream = await openEntryStream(archive, entry);
        let entryExpandedBytes = 0;
        for await (const value of stream) {
          const chunkSize = Buffer.isBuffer(value)
            ? value.byteLength
            : typeof value === "string"
              ? Buffer.byteLength(value)
              : Buffer.from(value as Uint8Array).byteLength;
          entryExpandedBytes += chunkSize;
          totalExpandedBytes += chunkSize;
          if (
            entryExpandedBytes > MAX_ENTRY_UNCOMPRESSED_BYTES
            || totalExpandedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES
          ) {
            stream.destroy();
            throw archiveError("The Office document expands beyond the safety limit.", "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED");
          }
        }
        const actualRatio = entryExpandedBytes === 0
          ? 0
          : entry.compressedSize === 0
            ? Number.POSITIVE_INFINITY
            : entryExpandedBytes / entry.compressedSize;
        if (actualRatio > MAX_COMPRESSION_RATIO) {
          throw archiveError("The Office document compression ratio exceeds the safety limit.", "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED");
        }
        archive.readEntry();
      })().catch(fail);
    });

    archive.readEntry();
  });
}
