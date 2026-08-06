import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { BusinessRole, MembershipStatus } from "@prisma/client";
import yazl from "yazl";
import { AppError } from "../src/utils/errors";
import {
  safeKnowledgeFileName,
  validateKnowledgeDocumentFile,
} from "../src/services/knowledge-document/knowledge-document-file-policy";
import { canManageKnowledgeDocuments } from "../src/services/knowledge-document/knowledge-document.types";
import {
  registerKnowledgeDocumentMalwareScanner,
  scanKnowledgeDocument,
} from "../src/services/knowledge-document/knowledge-document-malware-scanner.service";

function officeArchive(entries: Array<{ name: string; contents: Buffer; compress?: boolean }>) {
  const archive = new yazl.ZipFile();
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries) {
    archive.addBuffer(entry.contents, entry.name, { compress: entry.compress ?? true });
  }
  archive.end();
  return result;
}

async function uploadedFile(input: {
  name: string;
  mimeType: string;
  contents: Buffer;
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-ingestion-test-"));
  const filePath = path.join(directory, "upload");
  await writeFile(filePath, input.contents);
  return {
    directory,
    file: {
      fieldname: "file",
      originalname: input.name,
      encoding: "7bit",
      mimetype: input.mimeType,
      destination: directory,
      filename: "upload",
      path: filePath,
      size: input.contents.byteLength,
      buffer: input.contents,
      stream: null,
    },
  };
}

test("valid PDF metadata, signature and checksum are accepted", async () => {
  const fixture = await uploadedFile({
    name: "../Company Policy (Final).PDF",
    mimeType: "application/pdf",
    contents: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF"),
  });
  try {
    const result = await validateKnowledgeDocumentFile(fixture.file, 1024);
    assert.equal(result.originalFileName, "Company Policy (Final).PDF");
    assert.equal(result.safeFileName, "company-policy-final.pdf");
    assert.equal(result.extension, "pdf");
    assert.equal(result.filePath, fixture.file.path);
    assert.equal("buffer" in result, false);
    assert.match(result.checksum, /^[a-f0-9]{64}$/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("extension, MIME and signature must agree", async () => {
  const fixture = await uploadedFile({
    name: "policy.pdf",
    mimeType: "application/pdf",
    contents: Buffer.from("This is not a PDF"),
  });
  try {
    await assert.rejects(
      validateKnowledgeDocumentFile(fixture.file, 1024),
      (error: unknown) => error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_INVALID_SIGNATURE",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an empty ZIP is not accepted as an Office document", async () => {
  const fixture = await uploadedFile({
    name: "proposal.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    contents: Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]),
  });
  try {
    await assert.rejects(
      validateKnowledgeDocumentFile(fixture.file, 1024),
      (error: unknown) => error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a structurally valid Office package is parsed and accepted", async () => {
  const contents = await officeArchive([
    { name: "[Content_Types].xml", contents: Buffer.from("<Types></Types>") },
    { name: "word/document.xml", contents: Buffer.from("<document>Hello</document>") },
  ]);
  const fixture = await uploadedFile({
    name: "proposal.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    contents,
  });
  try {
    const result = await validateKnowledgeDocumentFile(fixture.file, 2 * 1024 * 1024);
    assert.equal(result.extension, "docx");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("high-ratio Office archives are rejected before processing", async () => {
  const contents = await officeArchive([
    { name: "[Content_Types].xml", contents: Buffer.from("<Types></Types>") },
    { name: "word/document.xml", contents: Buffer.alloc(1024 * 1024, 0x41) },
  ]);
  const fixture = await uploadedFile({
    name: "compressed-bomb.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    contents,
  });
  try {
    await assert.rejects(
      validateKnowledgeDocumentFile(fixture.file, 2 * 1024 * 1024),
      (error: unknown) => error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("required malware scanning fails closed when no scanner is configured", async () => {
  registerKnowledgeDocumentMalwareScanner(null);
  await assert.rejects(
    scanKnowledgeDocument({
      businessId: "business-1",
      fileName: "document.pdf",
      mimeType: "application/pdf",
      checksum: "a".repeat(64),
      filePath: "/tmp/not-opened-without-scanner",
      fileSize: 128,
    }, { required: true }),
    (error: unknown) => error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_MALWARE_SCANNER_REQUIRED",
  );
});

test("only a clean scanner result satisfies required scanning", async () => {
  registerKnowledgeDocumentMalwareScanner(async () => ({ status: "CLEAN", scanner: "TEST_SCANNER" }));
  try {
    const result = await scanKnowledgeDocument({
      businessId: "business-1",
      fileName: "document.pdf",
      mimeType: "application/pdf",
      checksum: "a".repeat(64),
      filePath: "/tmp/not-opened-by-test-scanner",
      fileSize: 128,
    }, { required: true });
    assert.equal(result.status, "CLEAN");
    assert.equal(result.scanner, "TEST_SCANNER");
  } finally {
    registerKnowledgeDocumentMalwareScanner(null);
  }
});

test("backend file-size policy is enforced", async () => {
  const fixture = await uploadedFile({
    name: "policy.txt",
    mimeType: "text/plain",
    contents: Buffer.from("A valid but oversized text file"),
  });
  try {
    await assert.rejects(
      validateKnowledgeDocumentFile(fixture.file, 5),
      (error: unknown) => error instanceof AppError && error.code === "KNOWLEDGE_DOCUMENT_FILE_TOO_LARGE",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Knowledge Hub management requires an explicit manager grant", () => {
  assert.equal(canManageKnowledgeDocuments({
    role: BusinessRole.BUSINESS_OWNER,
    status: MembershipStatus.ACTIVE,
    canManageKnowledgeHub: false,
  }), true);
  assert.equal(canManageKnowledgeDocuments({
    role: BusinessRole.MANAGER,
    status: MembershipStatus.ACTIVE,
    canManageKnowledgeHub: false,
  }), false);
  assert.equal(canManageKnowledgeDocuments({
    role: BusinessRole.MANAGER,
    status: MembershipStatus.ACTIVE,
    canManageKnowledgeHub: true,
  }), true);
  assert.equal(canManageKnowledgeDocuments({
    role: BusinessRole.STAFF,
    status: MembershipStatus.ACTIVE,
    canManageKnowledgeHub: true,
  }), false);
  assert.equal(canManageKnowledgeDocuments({
    role: BusinessRole.MANAGER,
    status: MembershipStatus.DISABLED,
    canManageKnowledgeHub: true,
  }), false);
});

test("safe filenames cannot retain path traversal", () => {
  assert.equal(safeKnowledgeFileName("../../Quarterly Results.xlsx", "xlsx"), "quarterly-results.xlsx");
});
