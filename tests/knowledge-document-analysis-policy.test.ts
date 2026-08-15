import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { ZipFile } from "yazl";
import {
  KnowledgeDocumentAnalysisConfidence,
  KnowledgeDocumentAudience,
  KnowledgeDocumentDetectedType,
  KnowledgeDocumentFactType,
  KnowledgeDocumentRecommendedClassification,
  KnowledgeDocumentSourceKind,
} from "@prisma/client";
import { knowledgeDocumentAnalysisPolicy } from "../src/services/knowledge-document/knowledge-document-analysis.service";
import { knowledgeDocumentAnalysisUsageFromCheckpoint } from "../src/services/ai-usage.service";
import {
  ExtractedSourceSection,
  knowledgeDocumentTextExtractionPolicy,
} from "../src/services/knowledge-document/knowledge-document-text-extraction.service";

function source(text: string, ordinal = 0): ExtractedSourceSection {
  return {
    ordinal,
    sourceKind: KnowledgeDocumentSourceKind.PAGE,
    sourceLabel: `Page ${ordinal + 1}`,
    pageNumber: ordinal + 1,
    sheetName: null,
    slideNumber: null,
    paragraphIndex: null,
    rowNumber: null,
    text,
  };
}

test("normalization preserves meaningful line boundaries", () => {
  assert.equal(
    knowledgeDocumentTextExtractionPolicy.normalize("Price:\t GHS 50\r\n\r\n\r\nDeposit: 10%"),
    "Price: GHS 50\n\nDeposit: 10%",
  );
});

test("CSV parsing preserves quoted commas and escaped quotes", () => {
  assert.deepEqual(
    knowledgeDocumentTextExtractionPolicy.parseCsv('Service,Note\nConsultation,"Accra, Ghana"\nAudit,"Say ""hello"""'),
    [["Service", "Note"], ["Consultation", "Accra, Ghana"], ["Audit", 'Say "hello"']],
  );
});

test("Office archive extraction consumes selected entries sequentially", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bizreply-office-test-"));
  const archivePath = path.join(directory, "document.docx");
  try {
    const archive = new ZipFile();
    archive.addBuffer(Buffer.from("first"), "word/first.xml");
    archive.addBuffer(Buffer.from("second"), "word/second.xml");
    archive.end();
    await pipeline(archive.outputStream, createWriteStream(archivePath));

    let activeConsumers = 0;
    let maximumActiveConsumers = 0;
    const values: string[] = [];
    await knowledgeDocumentTextExtractionPolicy.forEachOfficeEntry(
      archivePath,
      (name) => name.startsWith("word/"),
      async (_name, data) => {
        activeConsumers += 1;
        maximumActiveConsumers = Math.max(maximumActiveConsumers, activeConsumers);
        await new Promise((resolve) => setTimeout(resolve, 2));
        values.push(data.toString("utf8"));
        activeConsumers -= 1;
      },
    );

    assert.equal(maximumActiveConsumers, 1);
    assert.deepEqual(values, ["first", "second"]);
    assert.equal(knowledgeDocumentTextExtractionPolicy.limits.archiveEntryBytes, 8 * 1024 * 1024);
    assert.equal(knowledgeDocumentTextExtractionPolicy.limits.archiveTotalBytes, 20 * 1024 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("XLSX citations follow workbook relationships instead of worksheet filenames", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bizreply-xlsx-order-test-"));
  const archivePath = path.join(directory, "document.xlsx");
  try {
    const archive = new ZipFile();
    archive.addBuffer(Buffer.from([
      '<workbook xmlns:r="relationships"><sheets>',
      '<sheet name="Sales" sheetId="1" r:id="rId9"/>',
      '<sheet name="Pricing" sheetId="2" r:id="rId2"/>',
      "</sheets></workbook>",
    ].join("")), "xl/workbook.xml");
    archive.addBuffer(Buffer.from([
      "<Relationships>",
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/>',
      "</Relationships>",
    ].join("")), "xl/_rels/workbook.xml.rels");
    archive.addBuffer(Buffer.from('<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>Pricing content</t></is></c></row></sheetData></worksheet>'), "xl/worksheets/sheet1.xml");
    archive.addBuffer(Buffer.from('<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>Sales content</t></is></c></row></sheetData></worksheet>'), "xl/worksheets/sheet7.xml");
    archive.end();
    await pipeline(archive.outputStream, createWriteStream(archivePath));

    const result = await knowledgeDocumentTextExtractionPolicy.extractXlsx(archivePath);
    assert.deepEqual(result.sections.map((item) => [item.sheetName, item.text]), [
      ["Sales", "Sales content"],
      ["Pricing", "Pricing content"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PPTX citations follow presentation relationships instead of slide filenames", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bizreply-pptx-order-test-"));
  const archivePath = path.join(directory, "document.pptx");
  try {
    const archive = new ZipFile();
    archive.addBuffer(Buffer.from([
      '<p:presentation xmlns:p="presentation" xmlns:r="relationships"><p:sldIdLst>',
      '<p:sldId id="256" r:id="rId9"/>',
      '<p:sldId id="257" r:id="rId2"/>',
      "</p:sldIdLst></p:presentation>",
    ].join("")), "ppt/presentation.xml");
    archive.addBuffer(Buffer.from([
      "<Relationships>",
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide8.xml"/>',
      "</Relationships>",
    ].join("")), "ppt/_rels/presentation.xml.rels");
    archive.addBuffer(Buffer.from('<p:sld xmlns:p="presentation"><p:t>Second logical slide</p:t></p:sld>'), "ppt/slides/slide1.xml");
    archive.addBuffer(Buffer.from('<p:sld xmlns:p="presentation"><p:t>First logical slide</p:t></p:sld>'), "ppt/slides/slide8.xml");
    archive.end();
    await pipeline(archive.outputStream, createWriteStream(archivePath));

    const result = await knowledgeDocumentTextExtractionPolicy.extractPptx(archivePath);
    assert.deepEqual(result.sections.map((item) => [item.slideNumber, item.text]), [
      [1, "First logical slide"],
      [2, "Second logical slide"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credentials are redacted before persistence", () => {
  const result = knowledgeDocumentTextExtractionPolicy.redactSensitive("api_key=secret-value-123");
  assert.equal(result.text, "[REDACTED CREDENTIAL]");
  assert.deepEqual(result.warnings, ["SENSITIVE_CREDENTIAL_REDACTED"]);
});

test("OTP and card details are redacted", () => {
  const result = knowledgeDocumentTextExtractionPolicy.redactSensitive("OTP 123456 and card 4111 1111 1111 1111");
  assert.match(result.text, /REDACTED OTP/);
  assert.match(result.text, /REDACTED PAYMENT CARD/);
});

test("bank accounts and identity numbers are redacted", () => {
  const result = knowledgeDocumentTextExtractionPolicy.redactSensitive(
    "Account number: 012345678901\nGhana Card: GHA-123456789-1\nIBAN GB82 WEST 1234 5698 7654 32",
  );
  assert.doesNotMatch(result.text, /012345678901|GHA-123456789-1|GB82 WEST/);
  assert.ok(result.warnings.includes("SENSITIVE_BANK_ACCOUNT_REDACTED"));
  assert.ok(result.warnings.includes("SENSITIVE_IDENTITY_REDACTED"));
});

test("medical information, private links, and precise personal addresses are redacted", () => {
  const result = knowledgeDocumentTextExtractionPolicy.redactSensitive([
    "Diagnosis: hypertension",
    "Private link: https://example.com/report?token=private-token",
    "Customer address: 14 Example Street, Accra",
  ].join("\n"));
  assert.doesNotMatch(result.text, /hypertension|private-token|14 Example Street/);
  assert.ok(result.warnings.includes("SENSITIVE_MEDICAL_REDACTED"));
  assert.ok(result.warnings.includes("SENSITIVE_PRIVATE_LINK_REDACTED"));
  assert.ok(result.warnings.includes("SENSITIVE_PRECISE_ADDRESS_REDACTED"));
});

test("public business URLs and business addresses remain available", () => {
  const value = "Website: https://example.com/services\nBusiness address: 10 High Street, Accra";
  const result = knowledgeDocumentTextExtractionPolicy.redactSensitive(value);
  assert.equal(result.text, value);
  assert.deepEqual(result.warnings, []);
});

test("pricing documents are classified deterministically", () => {
  assert.equal(
    knowledgeDocumentAnalysisPolicy.deterministicDocumentType("Our consultation price is GHS 500."),
    KnowledgeDocumentDetectedType.PRICING_INFORMATION,
  );
});

test("payment instruction documents are classified deterministically", () => {
  assert.equal(
    knowledgeDocumentAnalysisPolicy.deterministicDocumentType("Pay by mobile money to complete the booking."),
    KnowledgeDocumentDetectedType.PAYMENT_INSTRUCTIONS,
  );
});

test("internal and sensitive wording produces review warnings", () => {
  const warnings = knowledgeDocumentAnalysisPolicy.deterministicWarnings(
    "Internal only. Password details must not be shared.",
    [],
  );
  assert.ok(warnings.includes("POTENTIALLY_INTERNAL_CONTENT"));
  assert.ok(warnings.includes("POTENTIALLY_SENSITIVE_CONTENT"));
});

test("prices retain exact page references", () => {
  const facts = knowledgeDocumentAnalysisPolicy.deterministicFacts([source("Site inspection costs GHS 5,000.")]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.factType, KnowledgeDocumentFactType.PRICE);
  assert.equal(facts[0]!.numericValue, "5000");
  assert.equal(facts[0]!.pageNumber, 1);
  assert.equal(facts[0]!.sourceExcerpt, "GHS 5,000");
});

test("deposit and discount facts are extracted separately", () => {
  const facts = knowledgeDocumentAnalysisPolicy.deterministicFacts([
    source("A deposit of GHS 200 is required. A discount of 10% applies."),
  ]);
  assert.ok(facts.some((fact) => fact.factType === KnowledgeDocumentFactType.DEPOSIT));
  assert.ok(facts.some((fact) => fact.factType === KnowledgeDocumentFactType.DISCOUNT));
});

test("conflicting source-backed facts require a warning", () => {
  const facts = knowledgeDocumentAnalysisPolicy.deterministicFacts([
    source("Price GHS 100", 0),
    source("Price GHS 200", 1),
  ]);
  assert.deepEqual(knowledgeDocumentAnalysisPolicy.conflictWarnings(facts), ["POTENTIALLY_CONFLICTING_FACTS"]);
});

test("AI facts are rejected when the value is unrelated to the verified excerpt", () => {
  const fact = knowledgeDocumentAnalysisPolicy.factFromAi({
    factType: KnowledgeDocumentFactType.PRICE,
    label: "Invented premium package price",
    valueText: "Premium package costs GHS 9,999",
    currency: "GHS",
    numericValue: "9999",
    sourceOrdinal: 0,
    sourceExcerpt: "Our office is open Monday to Friday.",
    confidence: 0.99,
  }, [source("Our office is open Monday to Friday.")]);

  assert.equal(fact, null);
});

test("AI numeric and currency claims must occur in the verified excerpt", () => {
  const fact = knowledgeDocumentAnalysisPolicy.factFromAi({
    factType: KnowledgeDocumentFactType.PRICE,
    label: "Consultation",
    valueText: "Consultation costs GHS 500",
    currency: "USD",
    numericValue: "900",
    sourceOrdinal: 0,
    sourceExcerpt: "Consultation costs GHS 500.",
    confidence: 0.95,
  }, [source("Consultation costs GHS 500.")]);

  assert.equal(fact, null);
});

test("accepted AI facts store only source-grounded fields", () => {
  const fact = knowledgeDocumentAnalysisPolicy.factFromAi({
    factType: KnowledgeDocumentFactType.PRICE,
    label: "Do not trust this AI label",
    valueText: "Consultation costs GHS 5,000",
    currency: "GH₵",
    numericValue: "5000.00",
    sourceOrdinal: 0,
    sourceExcerpt: "Consultation costs GHS 5,000.",
    confidence: 0.95,
  }, [source("Consultation costs GHS 5,000.")]);

  assert.ok(fact);
  assert.equal(fact.label, "Price");
  assert.equal(fact.valueText, "Consultation costs GHS 5,000.");
  assert.equal(fact.currency, "GHS");
  assert.equal(fact.numericValue, "5000");
});

test("durable provider checkpoints are runtime validated before reuse", () => {
  const checkpoint = knowledgeDocumentAnalysisPolicy.providerCheckpoint({
    rawText: '{"shortSummary":"Stored result"}',
    provider: "OPENROUTER",
    finalModelUsed: "test-model",
    providerRequestCount: 1,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    requestId: "request-1",
  });
  assert.deepEqual(knowledgeDocumentAnalysisPolicy.parseProviderCheckpoint(checkpoint), checkpoint);
  assert.equal(knowledgeDocumentAnalysisPolicy.parseProviderCheckpoint({ ...checkpoint, providerRequestCount: -1 }), null);
});

test("usage reconciliation accepts only bounded provider checkpoint accounting", () => {
  assert.deepEqual(knowledgeDocumentAnalysisUsageFromCheckpoint({
    providerRequestCount: 2,
    totalTokens: 450,
    requestId: "provider-request-1",
  }), {
    providerRequestCount: 2,
    tokens: 450,
    providerRequestId: "provider-request-1",
  });
  assert.equal(knowledgeDocumentAnalysisUsageFromCheckpoint({ providerRequestCount: -1 }), null);
  assert.equal(knowledgeDocumentAnalysisUsageFromCheckpoint({ providerRequestCount: 101 }), null);
  assert.equal(knowledgeDocumentAnalysisUsageFromCheckpoint({ providerRequestCount: 1, totalTokens: -5 }), null);
});

test("durable provider output is sanitized before checkpoint persistence", () => {
  const rawText = JSON.stringify({
    suggestedTitle: "Customer medical record",
    detectedDocumentType: KnowledgeDocumentDetectedType.OTHER,
    shortSummary: "Diagnosis: hypertension",
    detectedPurpose: "Private link: https://example.com/report?token=private-token",
    likelyAudience: KnowledgeDocumentAudience.INTERNAL,
    recommendedClassification: KnowledgeDocumentRecommendedClassification.INTERNAL_ONLY,
    classificationReason: "Diagnosis: hypertension requires internal handling",
    classificationConfidence: 0.92,
    analysisConfidence: KnowledgeDocumentAnalysisConfidence.LOW,
    requiresHumanReview: true,
    topics: ["Patient ID: PATIENT-12345"],
    relatedServiceSuggestions: [],
    warnings: [],
    facts: [],
  });
  const sanitized = JSON.parse(knowledgeDocumentAnalysisPolicy.sanitizedProviderRawText(rawText, 1)) as {
    shortSummary: string;
    detectedPurpose: string;
    classificationReason: string;
    classificationConfidence: number;
    topics: string[];
    warnings: string[];
  };
  assert.doesNotMatch(JSON.stringify(sanitized), /hypertension|private-token|PATIENT-12345/);
  assert.equal(sanitized.classificationConfidence, 0.92);
  assert.ok(sanitized.warnings.includes("SENSITIVE_MEDICAL_REDACTED"));
  assert.ok(sanitized.warnings.includes("SENSITIVE_PRIVATE_LINK_REDACTED"));
});

test("deterministic fallback is internal-only for protected content", () => {
  const section = source("Confidential internal only payment instruction. Password: secret123");
  const extraction = knowledgeDocumentTextExtractionPolicy.finalize([section]);
  const result = knowledgeDocumentAnalysisPolicy.baseResult({
    processingJobId: "job-1",
    processingAttempt: 1,
    businessId: "business-1",
    documentId: "document-1",
    versionId: "version-1",
    originalFileName: "internal-guide.pdf",
    extraction,
  });
  assert.equal(result.likelyAudience, KnowledgeDocumentAudience.INTERNAL);
  assert.equal(result.recommendedClassification, KnowledgeDocumentRecommendedClassification.INTERNAL_ONLY);
  assert.match(result.classificationReason, /internal/i);
  assert.equal(result.classificationConfidence, 0.9);
  assert.equal(result.requiresHumanReview, true);
});

test("finalized extraction keeps structured source references", () => {
  const result = knowledgeDocumentTextExtractionPolicy.finalize([
    source("First page", 0),
    source("Second page", 1),
  ], { pageCount: 2 });
  assert.equal(result.pageCount, 2);
  assert.equal(result.sections[1]!.ordinal, 1);
  assert.equal(result.sections[1]!.sourceLabel, "Page 2");
  assert.equal(result.contentHash.length, 64);
});

test("sampling a large section set records incomplete analysis coverage", () => {
  const compacted = knowledgeDocumentAnalysisPolicy.compactSections(
    Array.from({ length: 201 }, (_, ordinal) => source(`Section ${ordinal + 1}`, ordinal)),
  );
  assert.equal(compacted.totalSectionCount, 201);
  assert.equal(compacted.includedSectionCount, 160);
  assert.ok(compacted.warnings.includes("ANALYSIS_SECTION_SAMPLING_APPLIED"));
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisCoverageRequiresReview(compacted.warnings), true);
});

test("character-limited analysis records truncation and requires review", () => {
  const compacted = knowledgeDocumentAnalysisPolicy.compactSections([
    source("A".repeat(30_000), 0),
    source("B".repeat(30_000), 1),
    source("Final policy text", 2),
  ]);
  assert.equal(compacted.includedCharacterCount, 48_000);
  assert.ok(compacted.warnings.includes("ANALYSIS_INPUT_TRUNCATED"));
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisCoverageRequiresReview(compacted.warnings), true);
});

test("complete analysis coverage does not force review", () => {
  const compacted = knowledgeDocumentAnalysisPolicy.compactSections([
    source("Complete short document", 0),
  ]);
  assert.deepEqual(compacted.warnings, []);
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisCoverageRequiresReview(compacted.warnings), false);
});

test("mandatory uncertainty signals force human review independently of the provider", () => {
  const safeBase = {
    providerRequiresHumanReview: false,
    detectedDocumentType: KnowledgeDocumentDetectedType.SERVICE_INFORMATION,
    likelyAudience: KnowledgeDocumentAudience.CUSTOMER,
    recommendedClassification: KnowledgeDocumentRecommendedClassification.AI_REFERENCE_ONLY,
    analysisConfidence: KnowledgeDocumentAnalysisConfidence.HIGH,
    warnings: [] as string[],
  };

  assert.equal(knowledgeDocumentAnalysisPolicy.analysisRequiresHumanReview(safeBase), false);
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisRequiresHumanReview({
    ...safeBase,
    analysisConfidence: KnowledgeDocumentAnalysisConfidence.LOW,
  }), true);
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisRequiresHumanReview({
    ...safeBase,
    likelyAudience: KnowledgeDocumentAudience.UNKNOWN,
  }), true);
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisRequiresHumanReview({
    ...safeBase,
    recommendedClassification: KnowledgeDocumentRecommendedClassification.UNKNOWN,
  }), true);
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisRequiresHumanReview({
    ...safeBase,
    detectedDocumentType: KnowledgeDocumentDetectedType.OTHER,
  }), true);
  assert.equal(knowledgeDocumentAnalysisPolicy.analysisRequiresHumanReview({
    ...safeBase,
    warnings: ["UNVERIFIABLE_FACTS_REMOVED"],
  }), true);
});

test("deterministic fallback preserves incomplete coverage warnings", () => {
  const extraction = knowledgeDocumentTextExtractionPolicy.finalize(
    Array.from({ length: 201 }, (_, ordinal) => source(`Section ${ordinal + 1}`, ordinal)),
  );
  const result = knowledgeDocumentAnalysisPolicy.baseResult({
    processingJobId: "job-1",
    processingAttempt: 1,
    businessId: "business-1",
    documentId: "document-1",
    versionId: "version-1",
    originalFileName: "large-document.pdf",
    extraction,
  });
  assert.ok(result.warnings.includes("ANALYSIS_SECTION_SAMPLING_APPLIED"));
  assert.equal(result.requiresHumanReview, true);
});
