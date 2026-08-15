import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  KnowledgeDocumentSourceKind,
  KnowledgeStorageProvider,
} from "@prisma/client";
import { XMLParser } from "fast-xml-parser";
import yauzl, { Entry, ZipFile } from "yauzl";
import { AppError } from "../../utils/errors";
import { storageService } from "../storage.service";
import { KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION } from "./knowledge-document-extraction-policy";
import { validateOfficeDocumentArchive } from "./knowledge-document-office-archive-policy";

export type ExtractedSourceSection = {
  ordinal: number;
  sourceKind: KnowledgeDocumentSourceKind;
  sourceLabel: string | null;
  pageNumber: number | null;
  sheetName: string | null;
  slideNumber: number | null;
  paragraphIndex: number | null;
  rowNumber: number | null;
  text: string;
};

export type KnowledgeTextExtractionResult = {
  status: "COMPLETED" | "UNSUPPORTED";
  normalizedText: string;
  contentHash: string;
  language: string | null;
  characterCount: number;
  wordCount: number;
  pageCount: number | null;
  sheetCount: number | null;
  slideCount: number | null;
  warnings: string[];
  sections: ExtractedSourceSection[];
  extractorName: string;
  extractorVersion: string;
  statusCode: string | null;
  statusMessage: string | null;
};

type ExtractionInput = {
  storageProvider: KnowledgeStorageProvider;
  storageObjectKey: string;
  fileExtension: string;
  fileSize: number;
  checksum: string;
};

const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const MAX_SECTIONS = 10_000;
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 20 * 1024 * 1024;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  trimValues: false,
  parseTagValue: false,
  isArray: (name) => ["p", "r", "t", "row", "c", "si", "sheet"].includes(name),
});

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const sensitivePatterns: Array<{ code: string; pattern: RegExp; replacement: string }> = [
  { code: "SENSITIVE_PRIVATE_KEY_REDACTED", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, replacement: "[REDACTED PRIVATE KEY]" },
  { code: "SENSITIVE_CREDENTIAL_REDACTED", pattern: /\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token|secret[_ -]?key|client[_ -]?secret)\s*[:=]\s*[^\s,;]{4,}/gi, replacement: "[REDACTED CREDENTIAL]" },
  { code: "SENSITIVE_OTP_REDACTED", pattern: /\b(?:otp|one[- ]time (?:code|password)|verification code)\s*[:=]?\s*\d{4,8}\b/gi, replacement: "[REDACTED OTP]" },
  { code: "SENSITIVE_CVV_REDACTED", pattern: /\b(?:cvv|cvc|security code)\s*[:=]?\s*\d{3,4}\b/gi, replacement: "[REDACTED CARD SECURITY CODE]" },
  { code: "SENSITIVE_BANK_ACCOUNT_REDACTED", pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi, replacement: "[REDACTED BANK ACCOUNT]" },
  { code: "SENSITIVE_BANK_ACCOUNT_REDACTED", pattern: /\b(?:bank account|account number|account no\.?|acct no\.?|routing number|sort code|swift code|bic)\s*[:=]\s*[A-Z0-9][A-Z0-9 .\/-]{3,40}/gi, replacement: "[REDACTED BANK ACCOUNT]" },
  { code: "SENSITIVE_CARD_REDACTED", pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: "[REDACTED PAYMENT CARD]" },
  { code: "SENSITIVE_IDENTITY_REDACTED", pattern: /\bGHA-\d{9}-\d\b/gi, replacement: "[REDACTED IDENTITY NUMBER]" },
  { code: "SENSITIVE_IDENTITY_REDACTED", pattern: /\b(?:passport|national id|national identification|ghana card|driver'?s licen[cs]e|social security|ssn|tax identification|tax id)\s*(?:number|no\.?|id)?\s*[:=]\s*[A-Z0-9][A-Z0-9 -]{3,40}/gi, replacement: "[REDACTED IDENTITY NUMBER]" },
  { code: "SENSITIVE_MEDICAL_REDACTED", pattern: /\b(?:diagnosis|medical condition|medical history|patient id|prescription|medication|blood type)\s*[:=]\s*[^\n]{2,240}/gi, replacement: "[REDACTED MEDICAL INFORMATION]" },
  { code: "SENSITIVE_MEDICAL_REDACTED", pattern: /\b(?:diagnosed with|patient has|patient suffers from|allergic to)\s+[^\n.;]{2,160}/gi, replacement: "[REDACTED MEDICAL INFORMATION]" },
  { code: "SENSITIVE_PRIVATE_LINK_REDACTED", pattern: /https?:\/\/[^\s<>"']*(?:[?&](?:token|access_token|api_key|key|code|signature|sig|secret|auth|password|x-amz-signature)=[^\s&<>"']+)[^\s<>"']*/gi, replacement: "[REDACTED PRIVATE LINK]" },
  { code: "SENSITIVE_PRIVATE_LINK_REDACTED", pattern: /\b(?:private|password reset|magic|invitation|access)\s+link\s*[:=]\s*https?:\/\/[^\s<>"']+/gi, replacement: "[REDACTED PRIVATE LINK]" },
  { code: "SENSITIVE_PRECISE_ADDRESS_REDACTED", pattern: /\b(?:home|residential|customer|patient|personal|delivery|service)\s+address\s*[:=]\s*[^\n]{5,240}/gi, replacement: "[REDACTED PRECISE ADDRESS]" },
  { code: "SENSITIVE_PRECISE_ADDRESS_REDACTED", pattern: /\b(?:exact location|gps coordinates?)\s*[:=]\s*[^\n]{5,160}/gi, replacement: "[REDACTED PRECISE ADDRESS]" },
];

function redactSensitive(value: string) {
  const warnings = new Set<string>();
  let text = value;
  for (const rule of sensitivePatterns) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      warnings.add(rule.code);
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.replacement);
    }
  }
  return { text, warnings: [...warnings] };
}

function section(
  text: string,
  sourceKind: KnowledgeDocumentSourceKind,
  references: Partial<Omit<ExtractedSourceSection, "ordinal" | "sourceKind" | "text">> = {},
): Omit<ExtractedSourceSection, "ordinal"> | null {
  const cleaned = normalize(text);
  if (!cleaned) return null;
  return {
    sourceKind,
    sourceLabel: references.sourceLabel ?? null,
    pageNumber: references.pageNumber ?? null,
    sheetName: references.sheetName ?? null,
    slideNumber: references.slideNumber ?? null,
    paragraphIndex: references.paragraphIndex ?? null,
    rowNumber: references.rowNumber ?? null,
    text: cleaned,
  };
}

function collectTagText(value: unknown, tag = "t"): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectTagText(item, tag));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = record[tag];
  const ownValues = own === undefined
    ? []
    : (Array.isArray(own) ? own : [own]).flatMap((item) => {
      if (typeof item === "string" || typeof item === "number") return [String(item)];
      if (item && typeof item === "object" && "#text" in item) return [String((item as Record<string, unknown>)["#text"] ?? "")];
      return [];
    });
  return [...ownValues, ...Object.entries(record).filter(([key]) => key !== tag).flatMap(([, child]) => collectTagText(child, tag))];
}

function findTag(value: unknown, tag: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => findTag(item, tag));
  const record = value as Record<string, unknown>;
  const own = record[tag];
  return [
    ...(own === undefined ? [] : Array.isArray(own) ? own : [own]),
    ...Object.entries(record).filter(([key]) => key !== tag).flatMap(([, child]) => findTag(child, tag)),
  ];
}

function openZip(filePath: string) {
  return new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zip) => {
      if (error || !zip) reject(new AppError(422, "The Office document is malformed.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE"));
      else resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry) {
  return new Promise<Buffer>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error("ARCHIVE_ENTRY_UNREADABLE"));
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_ARCHIVE_ENTRY_BYTES) stream.destroy(new Error("ARCHIVE_ENTRY_LIMIT"));
        else chunks.push(Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function forEachOfficeEntry(
  filePath: string,
  wanted: (name: string) => boolean,
  consume: (name: string, data: Buffer) => void | Promise<void>,
) {
  const zip = await openZip(filePath);
  return new Promise<void>((resolve, reject) => {
    let total = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof AppError ? error : new AppError(422, "The Office document is malformed.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE"));
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      zip.close();
      resolve();
    });
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        if (entry.fileName.includes("..") || entry.fileName.includes("\\") || entry.isEncrypted()) {
          throw new Error("UNSAFE_ARCHIVE_ENTRY");
        }
        if (!wanted(entry.fileName) || entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        const data = await readEntry(zip, entry);
        total += data.byteLength;
        if (total > MAX_ARCHIVE_TOTAL_BYTES) throw new Error("ARCHIVE_TOTAL_LIMIT");
        await consume(entry.fileName, data);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

async function forEachOfficeEntryInOrder(
  filePath: string,
  orderedNames: string[],
  consume: (name: string, data: Buffer) => void | Promise<void>,
) {
  const zip = await openZip(filePath);
  const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
    const matches = new Map<string, Entry>();
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof AppError ? error : new AppError(422, "The Office document is malformed.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_ARCHIVE"));
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(matches);
    });
    zip.on("entry", (entry: Entry) => {
      if (entry.fileName.includes("..") || entry.fileName.includes("\\") || entry.isEncrypted()) {
        fail(new Error("UNSAFE_ARCHIVE_ENTRY"));
        return;
      }
      if (orderedNames.includes(entry.fileName)) {
        if (matches.has(entry.fileName)) {
          fail(new Error("DUPLICATE_ARCHIVE_ENTRY"));
          return;
        }
        matches.set(entry.fileName, entry);
      }
      zip.readEntry();
    });
    zip.readEntry();
  });

  try {
    let total = 0;
    for (const name of orderedNames) {
      const entry = entries.get(name);
      if (!entry) {
        throw new AppError(422, "The Office document relationship target is missing.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
      }
      const data = await readEntry(zip, entry);
      total += data.byteLength;
      if (total > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new AppError(422, "The Office document exceeds the extraction limit.", "KNOWLEDGE_DOCUMENT_ARCHIVE_LIMIT_EXCEEDED");
      }
      await consume(name, data);
    }
  } finally {
    zip.close();
  }
}

function resolveRelationshipTarget(ownerPart: string, target: string) {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    throw new AppError(422, "The Office document contains an invalid relationship.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
  }
  let decoded: string;
  try {
    decoded = decodeURI(target);
  } catch {
    throw new AppError(422, "The Office document contains an invalid relationship.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
  }
  const resolved = target.startsWith("/")
    ? path.posix.normalize(decoded.replace(/^\/+/, ""))
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), decoded));
  if (!resolved || resolved === ".." || resolved.startsWith("../") || resolved.includes("\\")) {
    throw new AppError(422, "The Office document contains an unsafe relationship.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
  }
  return resolved;
}

function relationshipTargets(xml: Buffer, ownerPart: string, expectedType: "worksheet" | "slide") {
  const relationships = findTag(xmlParser.parse(xml.toString("utf8")), "Relationship");
  const targets = new Map<string, string>();
  for (const item of relationships) {
    const record = item as Record<string, unknown>;
    const id = String(record["@_Id"] ?? "");
    const type = String(record["@_Type"] ?? "");
    const target = String(record["@_Target"] ?? "");
    const targetMode = String(record["@_TargetMode"] ?? "");
    if (!id || !type.endsWith(`/${expectedType}`)) continue;
    if (targetMode.toLowerCase() === "external" || targets.has(id)) {
      throw new AppError(422, "The Office document contains an invalid relationship.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
    }
    targets.set(id, resolveRelationshipTarget(ownerPart, target));
  }
  return targets;
}

function appendBoundedSection(
  target: Array<Omit<ExtractedSourceSection, "ordinal">>,
  item: Omit<ExtractedSourceSection, "ordinal"> | null,
  state: { characters: number },
) {
  if (!item || target.length >= MAX_SECTIONS || state.characters >= MAX_EXTRACTED_CHARACTERS) return false;
  const remaining = MAX_EXTRACTED_CHARACTERS - state.characters;
  const bounded = item.text.length > remaining ? { ...item, text: item.text.slice(0, remaining) } : item;
  target.push(bounded);
  state.characters += bounded.text.length + 2;
  return target.length < MAX_SECTIONS && state.characters < MAX_EXTRACTED_CHARACTERS;
}

async function extractPdf(buffer: Buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const sections = result.pages
      .map((page) => section(page.text, KnowledgeDocumentSourceKind.PAGE, {
        sourceLabel: `Page ${page.num}`,
        pageNumber: page.num,
      }))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return { sections, pageCount: result.total };
  } catch (error) {
    throw new AppError(422, "The PDF text could not be extracted.", "KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_FAILED", {
      reason: error instanceof Error ? error.name : "PDF_PARSE_ERROR",
    });
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(filePath: string) {
  let xml: Buffer | null = null;
  await forEachOfficeEntry(filePath, (name) => name === "word/document.xml", (_name, data) => { xml = data; });
  if (!xml) throw new AppError(422, "The Word document has no readable body.", "KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_FAILED");
  const parsed = xmlParser.parse((xml as Buffer).toString("utf8"));
  const paragraphs = findTag(parsed, "p");
  const sections: Array<Omit<ExtractedSourceSection, "ordinal">> = [];
  const state = { characters: 0 };
  for (let index = 0; index < paragraphs.length; index += 1) {
    if (!appendBoundedSection(sections, section(
      collectTagText(paragraphs[index]).join(" "),
      KnowledgeDocumentSourceKind.PARAGRAPH,
      { sourceLabel: `Paragraph ${index + 1}`, paragraphIndex: index + 1 },
    ), state)) break;
  }
  return { sections };
}

function cellValue(cell: Record<string, unknown>, sharedStrings: string[]) {
  const raw = Array.isArray(cell.v) ? cell.v[0] : cell.v;
  const value = raw && typeof raw === "object" && "#text" in raw ? (raw as Record<string, unknown>)["#text"] : raw;
  if (cell["@_t"] === "s") return sharedStrings[Number(value)] ?? "";
  if (cell["@_t"] === "inlineStr") return collectTagText(cell.is).join(" ");
  return value === undefined || value === null ? "" : String(value);
}

async function extractXlsx(filePath: string) {
  let sharedXml: Buffer | null = null;
  let workbookXml: Buffer | null = null;
  let workbookRelationshipsXml: Buffer | null = null;
  await forEachOfficeEntry(
    filePath,
    (name) => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" || name === "xl/sharedStrings.xml",
    (name, data) => {
      if (name === "xl/workbook.xml") workbookXml = data;
      else if (name === "xl/_rels/workbook.xml.rels") workbookRelationshipsXml = data;
      else sharedXml = data;
    },
  );
  if (!workbookXml || !workbookRelationshipsXml) {
    throw new AppError(422, "The spreadsheet relationship metadata is missing.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
  }
  const sharedStrings = sharedXml
    ? findTag(xmlParser.parse((sharedXml as Buffer).toString("utf8")), "si").map((item) => collectTagText(item).join(" "))
    : [];
  const targets = relationshipTargets(workbookRelationshipsXml as Buffer, "xl/workbook.xml", "worksheet");
  const sheets = findTag(xmlParser.parse((workbookXml as Buffer).toString("utf8")), "sheet").map((item, index) => {
    const record = item as Record<string, unknown>;
    const relationshipId = String(record["@_id"] ?? "");
    const entryName = targets.get(relationshipId);
    if (!relationshipId || !entryName || !/^xl\/worksheets\/[^/]+\.xml$/.test(entryName)) {
      throw new AppError(422, "The spreadsheet contains an invalid worksheet relationship.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
    }
    return { entryName, sheetName: String(record["@_name"] ?? "") || `Sheet ${index + 1}` };
  });
  const sections: Array<Omit<ExtractedSourceSection, "ordinal">> = [];
  const state = { characters: 0 };
  const sheetByEntry = new Map(sheets.map((sheet) => [sheet.entryName, sheet]));
  await forEachOfficeEntryInOrder(filePath, sheets.map((sheet) => sheet.entryName), (name, xml) => {
    const sheetName = sheetByEntry.get(name)!.sheetName;
    const rows = findTag(xmlParser.parse(xml.toString("utf8")), "row");
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      if (sections.length >= MAX_SECTIONS || state.characters >= MAX_EXTRACTED_CHARACTERS) break;
      const row = rows[rowIndex];
      const rowRecord = row as Record<string, unknown>;
      const cells = (Array.isArray(rowRecord.c) ? rowRecord.c : rowRecord.c ? [rowRecord.c] : []) as Array<Record<string, unknown>>;
      const text = cells.map((cell) => cellValue(cell, sharedStrings)).join(" | ");
      const rowNumber = Number(rowRecord["@_r"] ?? rowIndex + 1);
      const item = section(text, KnowledgeDocumentSourceKind.ROW, {
        sourceLabel: `${sheetName}, row ${rowNumber}`,
        sheetName,
        rowNumber,
      });
      appendBoundedSection(sections, item, state);
    }
  });
  return { sections, sheetCount: sheets.length };
}

async function extractPptx(filePath: string) {
  let presentationXml: Buffer | null = null;
  let presentationRelationshipsXml: Buffer | null = null;
  await forEachOfficeEntry(
    filePath,
    (name) => name === "ppt/presentation.xml" || name === "ppt/_rels/presentation.xml.rels",
    (name, data) => {
      if (name === "ppt/presentation.xml") presentationXml = data;
      else presentationRelationshipsXml = data;
    },
  );
  if (!presentationXml || !presentationRelationshipsXml) {
    throw new AppError(422, "The presentation relationship metadata is missing.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
  }
  const targets = relationshipTargets(presentationRelationshipsXml as Buffer, "ppt/presentation.xml", "slide");
  const slides = findTag(xmlParser.parse((presentationXml as Buffer).toString("utf8")), "sldId").map((item, index) => {
    const relationshipId = String((item as Record<string, unknown>)["@_id"] ?? "");
    const entryName = targets.get(relationshipId);
    if (!relationshipId || !entryName || !/^ppt\/slides\/[^/]+\.xml$/.test(entryName)) {
      throw new AppError(422, "The presentation contains an invalid slide relationship.", "KNOWLEDGE_DOCUMENT_INVALID_OFFICE_RELATIONSHIP");
    }
    return { entryName, slideNumber: index + 1 };
  });
  const sections: Array<Omit<ExtractedSourceSection, "ordinal">> = [];
  const state = { characters: 0 };
  const slideByEntry = new Map(slides.map((slide) => [slide.entryName, slide]));
  await forEachOfficeEntryInOrder(filePath, slides.map((slide) => slide.entryName), (name, xml) => {
    const slideNumber = slideByEntry.get(name)!.slideNumber;
    appendBoundedSection(sections, section(
      collectTagText(xmlParser.parse(xml.toString("utf8"))).join(" "),
      KnowledgeDocumentSourceKind.SLIDE,
      { sourceLabel: `Slide ${slideNumber}`, slideNumber },
    ), state);
  });
  return { sections, slideCount: slides.length };
}

function parseCsv(value: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      if (quoted && value[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function finalize(
  rawSections: Array<Omit<ExtractedSourceSection, "ordinal">>,
  counts: { pageCount?: number; sheetCount?: number; slideCount?: number } = {},
): KnowledgeTextExtractionResult {
  const limited = rawSections.slice(0, MAX_SECTIONS);
  const rawText = limited.map((item) => item.text).join("\n\n").slice(0, MAX_EXTRACTED_CHARACTERS);
  const redacted = redactSensitive(rawText);
  let cursor = 0;
  const sections = limited.flatMap((item) => {
    if (cursor >= MAX_EXTRACTED_CHARACTERS) return [];
    const available = MAX_EXTRACTED_CHARACTERS - cursor;
    const safe = redactSensitive(item.text.slice(0, available)).text;
    cursor += safe.length + 2;
    return [{ ...item, ordinal: 0, text: safe }];
  }).map((item, ordinal) => ({ ...item, ordinal }));
  const normalizedText = redacted.text;
  const warnings = [
    ...redacted.warnings,
    ...(rawSections.length > MAX_SECTIONS || rawText.length >= MAX_EXTRACTED_CHARACTERS ? ["EXTRACTED_TEXT_TRUNCATED"] : []),
  ];
  return {
    status: "COMPLETED",
    normalizedText,
    contentHash: crypto.createHash("sha256").update(normalizedText).digest("hex"),
    language: null,
    characterCount: normalizedText.length,
    wordCount: normalizedText ? normalizedText.split(/\s+/).length : 0,
    pageCount: counts.pageCount ?? null,
    sheetCount: counts.sheetCount ?? null,
    slideCount: counts.slideCount ?? null,
    warnings: [...new Set(warnings)],
    sections,
    extractorName: "BizReply structured document extractor",
    extractorVersion: KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION,
    statusCode: null,
    statusMessage: null,
  };
}

export const knowledgeDocumentTextExtractionService = {
  async extract(input: ExtractionInput): Promise<KnowledgeTextExtractionResult> {
    const extension = input.fileExtension.toLowerCase();
    if (input.fileSize <= 0 || input.fileSize > MAX_SOURCE_FILE_BYTES) {
      throw new AppError(413, "The stored document exceeds the extraction size limit.", "KNOWLEDGE_DOCUMENT_FILE_TOO_LARGE");
    }
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bizreply-knowledge-"));
    const temporaryFile = path.join(temporaryDirectory, "source.document");
    try {
      const downloaded = await storageService.downloadToFile(
        input.storageObjectKey,
        temporaryFile,
        input.storageProvider,
        Math.min(MAX_SOURCE_FILE_BYTES, input.fileSize),
      );
      if (downloaded.fileSize !== input.fileSize) {
        throw new AppError(409, "The stored document failed its integrity check.", "KNOWLEDGE_DOCUMENT_STORED_SIZE_MISMATCH");
      }
      if (downloaded.checksum !== input.checksum) {
        throw new AppError(409, "The stored document failed its integrity check.", "KNOWLEDGE_DOCUMENT_STORED_CHECKSUM_MISMATCH");
      }

      if (["png", "jpg", "jpeg", "webp"].includes(extension)) {
        return {
          ...finalize([]),
          status: "UNSUPPORTED",
          warnings: ["IMAGE_OCR_NOT_IMPLEMENTED"],
          statusCode: "KNOWLEDGE_DOCUMENT_IMAGE_REQUIRES_REVIEW",
          statusMessage: "Image text extraction is not available yet.",
        };
      }

      let extracted: { sections: Array<Omit<ExtractedSourceSection, "ordinal">>; pageCount?: number; sheetCount?: number; slideCount?: number };
      if (extension === "docx" || extension === "xlsx" || extension === "pptx") {
        await validateOfficeDocumentArchive(temporaryFile, extension);
        if (extension === "docx") extracted = await extractDocx(temporaryFile);
        else if (extension === "xlsx") extracted = await extractXlsx(temporaryFile);
        else extracted = await extractPptx(temporaryFile);
      } else {
        const buffer = await readFile(temporaryFile);
        if (extension === "pdf") extracted = await extractPdf(buffer);
        else if (extension === "csv") {
          extracted = {
            sections: parseCsv(buffer.toString("utf8")).slice(0, MAX_SECTIONS).map((row, index) => section(
              row.join(" | "),
              KnowledgeDocumentSourceKind.ROW,
              { sourceLabel: `Row ${index + 1}`, rowNumber: index + 1 },
            )).filter((item): item is NonNullable<typeof item> => Boolean(item)),
          };
        } else if (extension === "txt") {
          extracted = {
            sections: buffer.toString("utf8").split(/\r?\n/, MAX_SECTIONS).map((line, index) => section(
              line,
              KnowledgeDocumentSourceKind.PARAGRAPH,
              { sourceLabel: `Line ${index + 1}`, paragraphIndex: index + 1 },
            )).filter((item): item is NonNullable<typeof item> => Boolean(item)),
          };
        } else {
          throw new AppError(422, "This document format cannot be extracted.", "KNOWLEDGE_DOCUMENT_UNSUPPORTED_FILE_TYPE");
        }
      }

      const result = finalize(extracted.sections, extracted);
      if (!result.normalizedText) {
        return {
          ...result,
          status: "UNSUPPORTED",
          warnings: [...result.warnings, extension === "pdf" ? "OCR_REQUIRED" : "NO_EXTRACTABLE_TEXT"],
          statusCode: extension === "pdf" ? "KNOWLEDGE_DOCUMENT_OCR_REQUIRED" : "KNOWLEDGE_DOCUMENT_NO_EXTRACTABLE_TEXT",
          statusMessage: extension === "pdf"
            ? "This PDF appears to be scanned and requires OCR."
            : "No usable text could be extracted from this document.",
        };
      }
      return result;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

export const knowledgeDocumentTextExtractionPolicy = {
  normalize,
  redactSensitive,
  parseCsv,
  finalize,
  forEachOfficeEntry,
  extractXlsx,
  extractPptx,
  limits: {
    sourceFileBytes: MAX_SOURCE_FILE_BYTES,
    archiveEntryBytes: MAX_ARCHIVE_ENTRY_BYTES,
    archiveTotalBytes: MAX_ARCHIVE_TOTAL_BYTES,
    extractedCharacters: MAX_EXTRACTED_CHARACTERS,
    sections: MAX_SECTIONS,
  },
};
