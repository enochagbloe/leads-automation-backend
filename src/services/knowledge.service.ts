import crypto from "node:crypto";
import {
  AuditAction,
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessRole,
  ConversationChannel,
  ConversationStatus,
  KnowledgeArticle,
  KnowledgeArticleSource,
  KnowledgeArticleStatus,
  KnowledgeAssetSendType,
  KnowledgeAssetVisibility,
  KnowledgeDocumentStatus,
  KnowledgeDocumentProcessingStatus,
  KnowledgeGovernanceStatus,
  KnowledgeStorageProvider,
  MembershipStatus,
  PlanCode,
  Prisma,
} from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { PDFParse } from "pdf-parse";
import PDFDocument from "pdfkit";
import { readFile, unlink } from "node:fs/promises";
import {
  CreateKnowledgeArticleInput,
  DraftKnowledgeArticleInput,
  GenerateStarterArticlesInput,
  KnowledgeArticleListQuery,
  KnowledgeDocumentListQuery,
  KnowledgeSearchQuery,
  SendKnowledgeAssetInput,
  UpdateKnowledgeArticleInput,
  UpdateKnowledgeDocumentInput,
  UploadKnowledgeDocumentInput,
  UploadKnowledgeDocumentMetadataInput,
} from "../validation/knowledge.schemas";
import { AuditInput, auditService } from "./audit.service";
import { AiCompletionResult, aiProvider } from "./ai-provider.service";
import { cacheService } from "./cache.service";
import { knowledgeEmbeddingService } from "./knowledge-embedding.service";
import { customerSafeKnowledgeDocumentWhere } from "./knowledge-document/knowledge-document-runtime-policy";
import { loadCustomerSafeKnowledgeFacts } from "./knowledge-document/knowledge-approved-facts.service";
import {
  assertKnowledgeAssetCapacity as assertAssetCapacityTx,
  currentKnowledgeHubSubscription as currentSubscriptionTx,
  knowledgeAiDraftLimit as aiDraftLimitForPlan,
  knowledgeAssetLimit,
  knowledgeDocumentLimit as pdfUploadLimitForPlan,
  knowledgeStorageLimit as storageLimitForPlan,
} from "./knowledge-hub-capability.service";
import { knowledgePdfService } from "./knowledge-pdf.service";
import {
  assertKnowledgeStorageUsageMeasured,
  calculateKnowledgeStorageUsage,
  calculateKnowledgeStorageUsageByBusiness,
  reconcileKnowledgeArticlePdfSizes,
} from "./knowledge-storage-usage.service";
import { ConversationActor } from "./message.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { resolveStorageObjectProvider, storageService } from "./storage.service";
import { subscriptionService } from "./subscription.service";
import {
  assertCanManageKnowledgeDocuments,
  throwKnowledgeDocumentNotFound,
} from "./knowledge-document/knowledge-document.types";

type KnowledgeActor = ConversationActor;

const KNOWLEDGE_PROMPT_VERSION = "knowledge-articles-v1";
const MEDIA_SEND_NOT_READY = "WHATSAPP_DOCUMENT_SEND_NOT_CONFIGURED";
const DOCUMENT_CHUNK_MAX_CHARS = 1400;
const DOCUMENT_CHUNK_OVERLAP_CHARS = 160;
const DOCUMENT_CHUNK_LIMIT = 80;
const SUSPICIOUS_PDF_MARKERS = [
  "/JavaScript",
  "/JS",
  "/OpenAction",
  "/AA",
  "/Launch",
  "/EmbeddedFile",
  "/Filespec",
  "/RichMedia",
  "/XFA",
  "/AcroForm",
  "/SubmitForm",
  "/GoToR",
  "/URI",
];

function documentDownloadUrl(documentId: string) {
  return `/api/business/knowledge/documents/${documentId}/download`;
}

function articleDownloadUrl(articleId: string) {
  return `/api/business/knowledge/articles/${articleId}/download`;
}

function scheduleEmbeddingSync(label: string, task: Promise<unknown>) {
  void task.catch((error) => {
    console.error("Knowledge embedding sync failed", { label, error });
  });
}

function scheduleStorageDelete(
  label: string,
  fileKey?: string | null,
  provider?: KnowledgeStorageProvider | null,
) {
  if (!fileKey) return;
  void resolveStorageObjectProvider(fileKey, provider)
    .then((resolvedProvider) => storageService.deleteFile(fileKey, resolvedProvider))
    .catch((error) => {
      console.error("Knowledge storage cleanup failed", { label, fileKey, error });
    });
}

function shouldBroadcastArticle(article: { status: KnowledgeArticleStatus; visibility: KnowledgeAssetVisibility }) {
  return article.status === KnowledgeArticleStatus.PUBLISHED && article.visibility === KnowledgeAssetVisibility.CLIENT_SENDABLE;
}

function shouldBroadcastDocument(document: {
  status: KnowledgeDocumentStatus;
  processingStatus: KnowledgeDocumentProcessingStatus;
  governanceStatus: KnowledgeGovernanceStatus;
  visibility: KnowledgeAssetVisibility;
}) {
  return document.status === KnowledgeDocumentStatus.ACTIVE
    && document.processingStatus === KnowledgeDocumentProcessingStatus.READY
    && document.governanceStatus === KnowledgeGovernanceStatus.APPROVED
    && document.visibility === KnowledgeAssetVisibility.CLIENT_SENDABLE;
}

function isArticleRestore(existing: KnowledgeArticleStatus, next?: KnowledgeArticleStatus) {
  return existing === KnowledgeArticleStatus.ARCHIVED && next !== undefined && next !== KnowledgeArticleStatus.ARCHIVED;
}

function isDocumentRestore(existing: KnowledgeDocumentStatus, next: KnowledgeDocumentStatus) {
  return existing === KnowledgeDocumentStatus.ARCHIVED && next === KnowledgeDocumentStatus.ACTIVE;
}

async function managerOnly(
  actor: KnowledgeActor,
  context?: Omit<AuditInput, "action">,
  operation = "KNOWLEDGE_HUB_MUTATION",
) {
  await assertCanManageKnowledgeDocuments(actor, context, operation);
}

async function throwKnowledgeArticleNotFound(
  actor: KnowledgeActor,
  articleId: string,
  context: Omit<AuditInput, "action">,
  operation: string,
): Promise<never> {
  const foreignArticle = await prisma.knowledgeArticle.findFirst({
    where: { id: articleId, businessId: { not: actor.businessId } },
    select: { id: true },
  });
  if (foreignArticle) {
    await auditService.log({
      ...context,
      action: AuditAction.KNOWLEDGE_ARTICLE_SCOPE_VIOLATION,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: json({
        securityEvent: true,
        operation,
        requestedArticleId: articleId,
        requestedBusinessId: actor.businessId,
      }),
    });
  }
  throw new AppError(404, "Knowledge article not found.", "KNOWLEDGE_ARTICLE_NOT_FOUND");
}

function slugify(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "article";
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

type KnowledgeDbClient = Prisma.TransactionClient | typeof prisma;

async function uniqueSlug(businessId: string, title: string, requested?: string | null, excludeId?: string, client: KnowledgeDbClient = prisma) {
  const base = slugify(requested || title);
  for (let i = 0; i < 50; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await client.knowledgeArticle.findFirst({
      where: { businessId, slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (!existing) return slug;
  }
  return `${base}-${Date.now()}`;
}

async function activeAssetCount(businessAccountId: string) {
  const whereBusiness = { businessAccountId };
  const [articles, documents] = await Promise.all([
    prisma.knowledgeArticle.count({ where: { status: { not: KnowledgeArticleStatus.ARCHIVED }, business: whereBusiness } }),
    prisma.knowledgeDocument.count({ where: { status: KnowledgeDocumentStatus.ACTIVE, business: whereBusiness } }),
  ]);
  return articles + documents;
}

async function activePdfCount(businessAccountId: string) {
  return prisma.knowledgeDocument.count({
    where: {
      status: KnowledgeDocumentStatus.ACTIVE,
      business: { businessAccountId },
    },
  });
}

async function activePdfCountTx(tx: Prisma.TransactionClient, businessAccountId: string) {
  return tx.knowledgeDocument.count({
    where: {
      status: KnowledgeDocumentStatus.ACTIVE,
      business: { businessAccountId },
    },
  });
}

async function assertAiDraftCapacityTx(tx: Prisma.TransactionClient, actor: KnowledgeActor, increment = 1) {
  const subscription = await currentSubscriptionTx(tx, actor.businessAccountId);
  const limit = aiDraftLimitForPlan(subscription.plan.code);
  const current = await tx.knowledgeArticle.count({
    where: {
      source: KnowledgeArticleSource.AI_DRAFT,
      createdAt: { gte: subscription.currentPeriodStart },
      business: { businessAccountId: actor.businessAccountId },
    },
  });
  if (current + increment <= limit) return { subscription, current, limit };
  throw new AppError(403, "Your plan has reached the monthly AI article draft limit.", "KNOWLEDGE_AI_DRAFT_LIMIT_REACHED", {
    currentPlan: subscription.plan.code,
    currentUsage: current,
    limit,
    attemptedAmount: increment,
  });
}

async function assertPdfUploadCapacityTx(tx: Prisma.TransactionClient, actor: KnowledgeActor, increment = 1) {
  const subscription = await currentSubscriptionTx(tx, actor.businessAccountId);
  const pdfUploadLimit = pdfUploadLimitForPlan(subscription.plan.code);
  const currentPdfCount = await activePdfCountTx(tx, actor.businessAccountId);
  if (currentPdfCount + increment <= pdfUploadLimit) {
    return { subscription, currentPdfCount, pdfUploadLimit };
  }
  throw new AppError(
    403,
    "Your plan has reached the PDF upload limit.",
    "KNOWLEDGE_PDF_UPLOAD_LIMIT_REACHED",
    {
      currentPlan: subscription.plan.code,
      currentUsage: currentPdfCount,
      limit: pdfUploadLimit,
      attemptedAmount: increment,
    },
  );
}

async function assertStorageCapacityTx(tx: Prisma.TransactionClient, actor: KnowledgeActor, attemptedUploadSize: number) {
  const subscription = await currentSubscriptionTx(tx, actor.businessAccountId);
  const storageLimit = storageLimitForPlan(subscription.plan.code);
  const usage = await calculateKnowledgeStorageUsage(tx, actor.businessAccountId);
  assertKnowledgeStorageUsageMeasured(usage);
  const currentStorageUsed = usage.totalBytes;
  if (currentStorageUsed + attemptedUploadSize <= storageLimit) {
    return { subscription, currentStorageUsed, storageLimit };
  }
  throw new AppError(
    403,
    "Your plan has reached the knowledge storage limit.",
    "KNOWLEDGE_STORAGE_LIMIT_REACHED",
    {
      currentPlan: subscription.plan.code,
      currentUsage: currentStorageUsed,
      limit: storageLimit,
      attemptedAmount: attemptedUploadSize,
    },
  );
}

async function assertAssetCapacity(actor: KnowledgeActor, increment = 1) {
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  const limit = knowledgeAssetLimit(subscription.plan);
  const current = await activeAssetCount(actor.businessAccountId);
  if (current + increment <= limit) return { subscription, current, limit };
  throw new AppError(403, `Your ${subscription.plan.name} plan allows ${limit} active knowledge assets.`, "KNOWLEDGE_ASSET_LIMIT_REACHED", {
    currentPlan: subscription.plan.code,
    currentUsage: current,
    limit,
    attemptedAmount: increment,
  });
}

async function assertAiDraftCapacity(actor: KnowledgeActor, increment = 1) {
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  const limit = aiDraftLimitForPlan(subscription.plan.code);
  const since = subscription.currentPeriodStart;
  const current = await prisma.knowledgeArticle.count({
    where: {
      source: KnowledgeArticleSource.AI_DRAFT,
      createdAt: { gte: since },
      business: { businessAccountId: actor.businessAccountId },
    },
  });
  if (current + increment <= limit) return { subscription, current, limit };
  throw new AppError(403, "Your plan has reached the monthly AI article draft limit.", "KNOWLEDGE_AI_DRAFT_LIMIT_REACHED", {
    currentPlan: subscription.plan.code,
    currentUsage: current,
    limit,
    attemptedAmount: increment,
  });
}

async function assertPdfUploadCapacity(actor: KnowledgeActor, increment = 1) {
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  const pdfUploadLimit = pdfUploadLimitForPlan(subscription.plan.code);
  const currentPdfCount = await activePdfCount(actor.businessAccountId);
  if (currentPdfCount + increment <= pdfUploadLimit) {
    return { subscription, currentPdfCount, pdfUploadLimit };
  }
  throw new AppError(
    403,
    "Your plan has reached the PDF upload limit.",
    "KNOWLEDGE_PDF_UPLOAD_LIMIT_REACHED",
    {
      currentPlan: subscription.plan.code,
      currentUsage: currentPdfCount,
      limit: pdfUploadLimit,
      attemptedAmount: increment,
    },
  );
}

async function assertStorageCapacity(actor: KnowledgeActor, attemptedUploadSize: number) {
  await reconcileKnowledgeArticlePdfSizes(actor.businessAccountId);
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  const storageLimit = storageLimitForPlan(subscription.plan.code);
  const usage = await calculateKnowledgeStorageUsage(prisma, actor.businessAccountId);
  assertKnowledgeStorageUsageMeasured(usage);
  const currentStorageUsed = usage.totalBytes;
  if (currentStorageUsed + attemptedUploadSize <= storageLimit) {
    return { subscription, currentStorageUsed, storageLimit };
  }
  throw new AppError(
    403,
    "Your plan has reached the knowledge storage limit.",
    "KNOWLEDGE_STORAGE_LIMIT_REACHED",
    {
      currentPlan: subscription.plan.code,
      currentUsage: currentStorageUsed,
      limit: storageLimit,
      attemptedAmount: attemptedUploadSize,
    },
  );
}

async function validateRelatedIds(businessId: string, input: { relatedServiceIds?: string[]; relatedPolicyIds?: string[] }) {
  const [services, policies] = await Promise.all([
    input.relatedServiceIds?.length ? prisma.service.count({ where: { businessId, id: { in: input.relatedServiceIds }, isArchived: false } }) : 0,
    input.relatedPolicyIds?.length ? prisma.businessPolicy.count({ where: { businessId, id: { in: input.relatedPolicyIds }, isArchived: false } }) : 0,
  ]);
  if (input.relatedServiceIds?.length && services !== new Set(input.relatedServiceIds).size) {
    throw new AppError(422, "One or more related services are invalid.", "VALIDATION_ERROR");
  }
  if (input.relatedPolicyIds?.length && policies !== new Set(input.relatedPolicyIds).size) {
    throw new AppError(422, "One or more related policies are invalid.", "VALIDATION_ERROR");
  }
}

async function invalidateKnowledgeCaches(businessId: string) {
  await Promise.all([
    cacheService.delByPattern(`business:${businessId}:knowledge:*`),
    cacheService.delByPattern(`business:${businessId}:ai-context:*`),
  ]);
}

async function notifyManagersArticleNeedsReview(actor: KnowledgeActor, article: { id: string; title: string }) {
  const recipients = await prisma.businessMember.findMany({
    where: {
      businessId: actor.businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] },
    },
    select: { id: true },
  });
  await notificationService.createNotificationsForRecipients({
    businessId: actor.businessId,
    businessAccountId: actor.businessAccountId,
    recipientMembershipIds: recipients.map((recipient) => recipient.id),
    type: BusinessNotificationType.KNOWLEDGE_ARTICLE_NEEDS_REVIEW,
    priority: BusinessNotificationPriority.NORMAL,
    title: "AI knowledge article needs review",
    message: `"${article.title}" is ready for owner or manager review.`,
    entityType: BusinessNotificationEntityType.KNOWLEDGE_ARTICLE,
    entityId: article.id,
    actions: [
      { label: "Review article", action: "OPEN_URL", variant: "default", href: `/knowledge/articles/${article.id}` },
    ],
    createdById: actor.userId,
    metadata: { articleId: article.id },
  });
}

type GeneratedKnowledgeDraft = {
  title: string;
  summary: string | null;
  body: string;
  category: string | null;
  tags: string[];
  aiConfidence: number | null;
  aiDraftReason: string;
};

function cleanJsonText(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseGeneratedDraft(rawText: string, input: DraftKnowledgeArticleInput): GeneratedKnowledgeDraft {
  let parsed: Partial<{
    title: string;
    summary: string | null;
    body: string;
    category: string | null;
    tags: string[];
    aiConfidence: number;
    confidence: number;
    aiDraftReason: string;
    draftReason: string;
  }>;
  try {
    parsed = JSON.parse(cleanJsonText(rawText)) as typeof parsed;
  } catch {
    throw new AppError(502, "AI article draft response was not valid JSON.", "AI_OUTPUT_PARSE_FAILED");
  }
  const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 160) : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!title || body.length < 40) {
    throw new AppError(502, "AI article draft response did not include meaningful article content.", "AI_OUTPUT_EMPTY");
  }
  const confidence = typeof parsed.aiConfidence === "number"
    ? parsed.aiConfidence
    : typeof parsed.confidence === "number"
      ? parsed.confidence
      : null;
  return {
    title,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 500) : null,
    body,
    category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : input.category ?? null,
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()).slice(0, 12) : [],
    aiConfidence: confidence === null ? null : Math.max(0, Math.min(1, confidence)),
    aiDraftReason: (typeof parsed.aiDraftReason === "string" && parsed.aiDraftReason.trim())
      ? parsed.aiDraftReason.trim()
      : (typeof parsed.draftReason === "string" && parsed.draftReason.trim())
        ? parsed.draftReason.trim()
        : input.notes ?? input.customerQuestion ?? input.topic,
  };
}

async function buildKnowledgeDraftPrompt(actor: KnowledgeActor, input: DraftKnowledgeArticleInput, output: "json" | "markdown" = "json") {
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_DEFAULT_MODEL) {
    throw new AppError(503, "AI provider is not configured.", "AI_PROVIDER_ERROR");
  }
  const [business, services, policies] = await Promise.all([
    prisma.business.findFirst({
      where: { id: actor.businessId, deletedAt: null },
      select: { name: true, industry: true, description: true, city: true, country: true, serviceArea: true, defaultCurrency: true },
    }),
    prisma.service.findMany({
      where: { businessId: actor.businessId, isActive: true, isArchived: false },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      take: 20,
      select: { id: true, name: true, category: true, description: true, priceType: true, priceDescription: true, durationMinutes: true, isBookable: true },
    }),
    prisma.businessPolicy.findMany({
      where: { businessId: actor.businessId, isActive: true, isArchived: false },
      orderBy: [{ priority: "desc" }, { displayOrder: "asc" }],
      take: 15,
      select: { title: true, category: true, shortSummary: true, content: true },
    }),
  ]);
  const selectedServices = input.relatedServiceIds.length
    ? services.filter((service) => input.relatedServiceIds.includes(service.id))
    : [];
  const systemPrompt = output === "json"
    ? [
      "You draft clear, customer-friendly business knowledge base articles.",
      "Use only known business, service, and policy information from the prompt.",
      "Do not invent prices, refund policies, delivery timelines, deliverables, availability, or guarantees.",
      "If a detail is missing, write conservatively and flag it for owner review.",
      "Return strict JSON only. Do not wrap the JSON in markdown fences.",
    ].join(" ")
    : [
      "You draft clear, customer-friendly business knowledge base articles in readable markdown.",
      "Use only known business, service, and policy information from the prompt.",
      "Do not invent prices, refund policies, delivery timelines, deliverables, availability, or guarantees.",
      "If a detail is missing, write conservatively and flag it for owner review.",
      "Write only the article markdown. Do not return JSON.",
    ].join(" ");
  const userPrompt = [
    "Business context:",
    business ? JSON.stringify(business) : "Business profile unavailable.",
    "All active services:",
    JSON.stringify(services),
    "Selected related services:",
    JSON.stringify(selectedServices),
    "Policies:",
    JSON.stringify(policies.map((policy) => ({ ...policy, content: policy.shortSummary ?? policy.content.slice(0, 800) }))),
    "",
    "Create one knowledge base article draft.",
    `Topic: ${input.topic}`,
    input.category ? `Category: ${input.category}` : "",
    `Visibility: ${input.visibility}`,
    input.customerQuestion ? `Customer question: ${input.customerQuestion}` : "",
    input.notes ? `Owner notes: ${input.notes}` : "",
    output === "json"
      ? "Return JSON with title, summary, body, category, tags, aiConfidence, aiDraftReason."
      : "Write a complete markdown article with an H1 title and useful headings, for example Overview, What is included, Pricing, Important notes, and Next step where relevant.",
    output === "json" ? "The body must be readable markdown-like text with useful headings." : "",
    "The body must be practical, specific to the business context, and safe for a human to review before publishing.",
  ].filter(Boolean).join("\n");
  return { systemPrompt, userPrompt };
}

async function structureMarkdownDraft(actor: KnowledgeActor, input: DraftKnowledgeArticleInput, markdown: string) {
  const result = await aiProvider.generateCompletion({
    businessId: actor.businessId,
    systemPrompt: "Convert the provided article markdown into strict JSON only. Do not add business facts. Preserve the article body markdown exactly except for minor cleanup.",
    userPrompt: [
      `Topic: ${input.topic}`,
      input.category ? `Requested category: ${input.category}` : "",
      `Requested visibility: ${input.visibility}`,
      input.notes ? `Owner notes: ${input.notes}` : "",
      "Return JSON with title, summary, body, category, tags, aiConfidence, aiDraftReason.",
      "Article markdown:",
      markdown,
    ].filter(Boolean).join("\n"),
    temperature: 0,
    maxTokens: 1600,
    responseFormat: { type: "json_object" },
    metadata: { source: "KNOWLEDGE_ARTICLE_DRAFT_STRUCTURE" },
  });
  return parseGeneratedDraft(result.rawText, input);
}

async function generateArticleWithOpenRouter(actor: KnowledgeActor, input: DraftKnowledgeArticleInput) {
  const prompt = await buildKnowledgeDraftPrompt(actor, input);
  const result = await aiProvider.generateCompletion({
    businessId: actor.businessId,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    temperature: 0.25,
    maxTokens: 1400,
    responseFormat: { type: "json_object" },
    metadata: { source: "KNOWLEDGE_ARTICLE_DRAFT" },
  });
  return parseGeneratedDraft(result.rawText, input);
}

function decodePdf(input: UploadKnowledgeDocumentInput) {
  if (!input.fileName.toLowerCase().endsWith(".pdf")) {
    throw new AppError(422, "Only .pdf files are supported.", "INVALID_FILE_TYPE");
  }
  const base64 = input.fileBase64.includes(",") ? input.fileBase64.split(",").pop()! : input.fileBase64;
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength > env.KNOWLEDGE_UPLOAD_MAX_BYTES) {
    throw new AppError(413, "PDF is too large.", "KNOWLEDGE_UPLOAD_FILE_TOO_LARGE", {
      currentUsage: 0,
      limit: env.KNOWLEDGE_UPLOAD_MAX_BYTES,
      attemptedAmount: buffer.byteLength,
    });
  }
  if (buffer.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new AppError(422, "Only valid PDF files are supported.", "INVALID_FILE_TYPE");
  }
  const tail = buffer.subarray(Math.max(0, buffer.byteLength - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    throw new AppError(422, "PDF appears incomplete or corrupted.", "INVALID_PDF");
  }
  return buffer;
}

function assertNoHighRiskPdfFeatures(buffer: Buffer) {
  const content = buffer.toString("latin1");
  const found = SUSPICIOUS_PDF_MARKERS.filter((marker) => content.includes(marker));
  if (found.length) {
    throw new AppError(422, "PDF contains unsupported active or embedded content.", "UNSAFE_PDF_CONTENT", { markers: found });
  }
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

function normalizeExtractedText(value: string) {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function chunkText(text: string) {
  const normalized = normalizeExtractedText(text);
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length && chunks.length < DOCUMENT_CHUNK_LIMIT) {
    const hardEnd = Math.min(normalized.length, start + DOCUMENT_CHUNK_MAX_CHARS);
    const slice = normalized.slice(start, hardEnd);
    const breakAt = hardEnd < normalized.length
      ? Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "))
      : -1;
    const end = breakAt > DOCUMENT_CHUNK_MAX_CHARS * 0.55 ? start + breakAt + 1 : hardEnd;
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(0, end - DOCUMENT_CHUNK_OVERLAP_CHARS);
  }
  return chunks;
}

async function extractPdfText(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    const text = normalizeExtractedText(parsed.text ?? "");
    if (!text) {
      throw new AppError(422, "PDF text could not be extracted. Upload a text-based PDF.", "PDF_TEXT_EXTRACTION_FAILED");
    }
    return text;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("password") || message.includes("encrypted")) {
      throw new AppError(422, "Password-protected or encrypted PDFs are not supported.", "ENCRYPTED_PDF_NOT_SUPPORTED");
    }
    throw new AppError(422, "PDF could not be parsed safely.", "INVALID_PDF");
  } finally {
    await parser.destroy();
  }
}

function chunksFromExtractedText(text: string) {
  const chunks = chunkText(text);
  if (!chunks.length) {
    throw new AppError(422, "PDF text could not be extracted. Upload a text-based PDF.", "PDF_TEXT_EXTRACTION_FAILED");
  }
  return chunks.map((chunk, index) => ({
    chunkText: chunk,
    pageNumber: null as number | null,
    tokenCount: estimateTokens(chunk),
    index,
  }));
}

function collectPdf(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function renderSanitizedPdf(input: { title: string; fileName: string; text: string }) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    bufferPages: true,
    info: {
      Title: input.title,
      Subject: "Sanitized uploaded knowledge document",
      Creator: "BizReply AI",
      Producer: "BizReply AI",
    },
  });
  const result = collectPdf(doc);
  doc.font("Helvetica-Bold").fontSize(18).text(input.title, { lineGap: 4 });
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(9).fillColor("#6b7280").text(`Sanitized from ${input.fileName}`);
  doc.moveDown(1);
  doc.fillColor("#111827").font("Helvetica").fontSize(10).text(input.text, {
    width: doc.page.width - 112,
    lineGap: 3,
    align: "left",
  });
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(i);
    doc.fillColor("#6b7280").font("Helvetica").fontSize(8).text(`Page ${i + 1} of ${pages.count}`, 56, doc.page.height - 42, {
      width: doc.page.width - 112,
      align: "right",
    });
  }
  doc.end();
  return result;
}

async function sanitizeUploadedPdf(input: UploadKnowledgeDocumentMetadataInput, uploadedFile: Express.Multer.File) {
  const original = decodePdf({ ...input, fileBase64: (await readFile(uploadedFile.path)).toString("base64") });
  assertNoHighRiskPdfFeatures(original);
  const extractedText = await extractPdfText(original);
  return {
    buffer: await renderSanitizedPdf({ title: input.title, fileName: input.fileName, text: extractedText }),
    chunks: chunksFromExtractedText(extractedText),
    originalSize: original.byteLength,
  };
}

function articleAccessWhere(actor: KnowledgeActor, articleId?: string): Prisma.KnowledgeArticleWhereInput {
  return {
    businessId: actor.businessId,
    ...(articleId ? { id: articleId } : {}),
    ...(actor.role === BusinessRole.STAFF ? {
      status: KnowledgeArticleStatus.PUBLISHED,
      visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
    } : {}),
  };
}

function documentAccessWhere(actor: KnowledgeActor, documentId?: string): Prisma.KnowledgeDocumentWhereInput {
  return {
    businessId: actor.businessId,
    ...(documentId ? { id: documentId } : {}),
    ...(actor.role === BusinessRole.STAFF ? {
      status: KnowledgeDocumentStatus.ACTIVE,
      processingStatus: KnowledgeDocumentProcessingStatus.READY,
      governanceStatus: KnowledgeGovernanceStatus.APPROVED,
      visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
      ...customerSafeKnowledgeDocumentWhere,
    } : {}),
  };
}

async function saveGeneratedKnowledgeDraft(
  actor: KnowledgeActor,
  input: DraftKnowledgeArticleInput,
  draft: GeneratedKnowledgeDraft,
  context: Omit<AuditInput, "action">,
) {
  const article = await prisma.$transaction(async (tx) => {
    await assertAssetCapacityTx(tx, actor);
    await assertAiDraftCapacityTx(tx, actor);
    return tx.knowledgeArticle.create({
      data: {
        businessId: actor.businessId,
        title: draft.title,
        slug: await uniqueSlug(actor.businessId, draft.title, undefined, undefined, tx),
        summary: draft.summary,
        body: draft.body,
        category: draft.category,
        tags: draft.tags,
        relatedServiceIds: input.relatedServiceIds,
        relatedPolicyIds: input.relatedPolicyIds,
        status: KnowledgeArticleStatus.NEEDS_REVIEW,
        source: KnowledgeArticleSource.AI_DRAFT,
        visibility: input.visibility,
        aiGenerated: true,
        aiPromptVersion: KNOWLEDGE_PROMPT_VERSION,
        aiDraftReason: draft.aiDraftReason,
        aiConfidence: draft.aiConfidence,
        createdByMembershipId: actor.membershipId,
        updatedByMembershipId: actor.membershipId,
      },
    });
  }).catch((error: unknown) => {
    if (error instanceof AppError) throw error;
    throw new AppError(500, "AI draft article could not be saved.", "ARTICLE_SAVE_FAILED");
  });
  const sideEffects = await Promise.allSettled([
    invalidateKnowledgeCaches(actor.businessId),
    notifyManagersArticleNeedsReview(actor, article),
    auditService.log({
      ...context,
      action: AuditAction.KNOWLEDGE_ARTICLE_AI_DRAFT_CREATED,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: { articleId: article.id, topic: input.topic },
    }),
  ]);
  for (const result of sideEffects) {
    if (result.status === "rejected") console.error("AI knowledge draft side effect failed", { error: result.reason });
  }
  scheduleEmbeddingSync("article.ai_draft", knowledgeEmbeddingService.syncArticle(article.id));
  realtimeService.publish({
    type: "business.knowledge.article.created",
    businessId: actor.businessId,
    broadcastToStaff: shouldBroadcastArticle(article),
    payload: { article },
  });
  return article;
}

export const knowledgeService = {
  async listArticles(actor: KnowledgeActor, query: KnowledgeArticleListQuery) {
    const key = `business:${actor.businessId}:knowledge:articles:${actor.membershipId}:${JSON.stringify(query)}`;
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const filters: Prisma.KnowledgeArticleWhereInput[] = [articleAccessWhere(actor)];
    if (query.status && actor.role !== BusinessRole.STAFF) filters.push({ status: query.status });
    if (query.visibility && actor.role !== BusinessRole.STAFF) filters.push({ visibility: query.visibility });
    if (query.category) filters.push({ category: { equals: query.category, mode: "insensitive" } });
    if (query.search) filters.push({
      OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { summary: { contains: query.search, mode: "insensitive" } },
        { body: { contains: query.search, mode: "insensitive" } },
        { category: { contains: query.search, mode: "insensitive" } },
      ],
    });
    const where = { AND: filters };
    const [data, total] = await prisma.$transaction([
      prisma.knowledgeArticle.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.knowledgeArticle.count({ where }),
    ]);
    const result = { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    await cacheService.set(key, result, 30);
    return result;
  },

  async stats(actor: KnowledgeActor) {
    await managerOnly(actor, undefined, "KNOWLEDGE_HUB_STATS");
    await reconcileKnowledgeArticlePdfSizes(actor.businessAccountId);
    const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
    const [assetUsed, pdfUsed, storageUsage, storageByBusiness, aiDraftUsedThisMonth, businesses, articleGroups, documentGroups] = await Promise.all([
      activeAssetCount(actor.businessAccountId),
      activePdfCount(actor.businessAccountId),
      calculateKnowledgeStorageUsage(prisma, actor.businessAccountId),
      calculateKnowledgeStorageUsageByBusiness(prisma, actor.businessAccountId),
      prisma.knowledgeArticle.count({
        where: {
          source: KnowledgeArticleSource.AI_DRAFT,
          createdAt: { gte: subscription.currentPeriodStart },
          business: { businessAccountId: actor.businessAccountId },
        },
      }),
      prisma.business.findMany({
        where: { businessAccountId: actor.businessAccountId, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.knowledgeArticle.groupBy({
        by: ["businessId"],
        where: {
          status: { not: KnowledgeArticleStatus.ARCHIVED },
          business: { businessAccountId: actor.businessAccountId },
        },
        _count: { _all: true },
      }),
      prisma.knowledgeDocument.groupBy({
        by: ["businessId"],
        where: {
          status: KnowledgeDocumentStatus.ACTIVE,
          business: { businessAccountId: actor.businessAccountId },
        },
        _count: { _all: true },
      }),
    ]);
    assertKnowledgeStorageUsageMeasured(storageUsage);
    const articleCountByBusiness = new Map(articleGroups.map((group) => [group.businessId, group._count._all]));
    const documentStatsByBusiness = new Map(documentGroups.map((group) => [group.businessId, {
      activePdfCount: group._count._all,
    }]));
    return {
      assetUsage: {
        used: assetUsed,
        limit: knowledgeAssetLimit(subscription.plan),
      },
      pdfUsage: {
        used: pdfUsed,
        limit: pdfUploadLimitForPlan(subscription.plan.code),
      },
      storageUsage: {
        usedBytes: storageUsage.totalBytes,
        limitBytes: storageLimitForPlan(subscription.plan.code),
        documentVersionBytes: storageUsage.documentVersionBytes,
        articlePdfBytes: storageUsage.articlePdfBytes,
      },
      aiDraftUsage: {
        usedThisMonth: aiDraftUsedThisMonth,
        monthlyLimit: aiDraftLimitForPlan(subscription.plan.code),
      },
      businessStorageBreakdown: businesses.map((business) => {
        const documentStats = documentStatsByBusiness.get(business.id) ?? { activePdfCount: 0 };
        const businessStorage = storageByBusiness.get(business.id);
        return {
          businessId: business.id,
          businessName: business.name,
          usedBytes: businessStorage?.totalBytes ?? 0,
          documentVersionBytes: businessStorage?.documentVersionBytes ?? 0,
          articlePdfBytes: businessStorage?.articlePdfBytes ?? 0,
          activeAssets: (articleCountByBusiness.get(business.id) ?? 0) + documentStats.activePdfCount,
          activePdfCount: documentStats.activePdfCount,
        };
      }),
    };
  },

  async createArticle(actor: KnowledgeActor, input: CreateKnowledgeArticleInput, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "KNOWLEDGE_ARTICLE_CREATE");
    await validateRelatedIds(actor.businessId, input);
    const article = await prisma.$transaction(async (tx) => {
      await assertAssetCapacityTx(tx, actor);
      const slug = await uniqueSlug(actor.businessId, input.title, input.slug, undefined, tx);
      return tx.knowledgeArticle.create({
        data: {
          businessId: actor.businessId,
          title: input.title,
          slug,
          summary: input.summary ?? null,
          body: input.body,
          category: input.category ?? null,
          tags: input.tags,
          relatedServiceIds: input.relatedServiceIds,
          relatedPolicyIds: input.relatedPolicyIds,
          visibility: input.visibility,
          status: input.status,
          source: KnowledgeArticleSource.MANUAL,
          createdByMembershipId: actor.membershipId,
          updatedByMembershipId: actor.membershipId,
        },
      });
    });
    await Promise.all([
      invalidateKnowledgeCaches(actor.businessId),
      auditService.log({ ...context, action: AuditAction.KNOWLEDGE_ARTICLE_CREATED, businessId: actor.businessId, userId: actor.userId, actorMembershipId: actor.membershipId, metadata: { articleId: article.id } }),
    ]);
    scheduleEmbeddingSync("article.created", knowledgeEmbeddingService.syncArticle(article.id));
    realtimeService.publish({
      type: "business.knowledge.article.created",
      businessId: actor.businessId,
      broadcastToStaff: shouldBroadcastArticle(article),
      payload: { article },
    });
    return article;
  },

  async detailArticle(actor: KnowledgeActor, articleId: string) {
    const article = await prisma.knowledgeArticle.findFirst({ where: articleAccessWhere(actor, articleId) });
    if (!article) throw new AppError(404, "Knowledge article not found.", "KNOWLEDGE_ARTICLE_NOT_FOUND");
    return article;
  },

  async updateArticle(actor: KnowledgeActor, articleId: string, input: UpdateKnowledgeArticleInput, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "KNOWLEDGE_ARTICLE_UPDATE");
    const existing = await prisma.knowledgeArticle.findFirst({ where: { id: articleId, businessId: actor.businessId } });
    if (!existing) return throwKnowledgeArticleNotFound(actor, articleId, context, "KNOWLEDGE_ARTICLE_UPDATE");
    if (input.relatedServiceIds || input.relatedPolicyIds) await validateRelatedIds(actor.businessId, input);
    const slug = input.title || input.slug ? await uniqueSlug(actor.businessId, input.title ?? existing.title, input.slug ?? existing.slug, articleId) : undefined;
    const oldPdfFileKey = input.body !== undefined
      ? existing.pdfStorageObjectKey ?? existing.pdfFileKey
      : null;
    const oldPdfStorageProvider = input.body !== undefined ? existing.pdfStorageProvider : null;
    const article = await prisma.$transaction(async (tx) => {
      if (isArticleRestore(existing.status, input.status)) {
        await assertAssetCapacityTx(tx, actor);
      }
      return tx.knowledgeArticle.update({
        where: { id: articleId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(slug ? { slug } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.body !== undefined ? {
            body: input.body,
            pdfFileKey: null,
            pdfFileUrl: null,
            pdfFileSize: null,
            pdfStorageProvider: null,
            pdfStorageObjectKey: null,
            lastPdfGeneratedAt: null,
          } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.relatedServiceIds !== undefined ? { relatedServiceIds: input.relatedServiceIds } : {}),
          ...(input.relatedPolicyIds !== undefined ? { relatedPolicyIds: input.relatedPolicyIds } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedByMembershipId: actor.membershipId,
        },
      });
    });
    await Promise.all([
      invalidateKnowledgeCaches(actor.businessId),
      auditService.log({ ...context, action: AuditAction.KNOWLEDGE_ARTICLE_UPDATED, businessId: actor.businessId, userId: actor.userId, actorMembershipId: actor.membershipId, metadata: { articleId } }),
    ]);
    scheduleStorageDelete("article.pdf_stale_after_update", oldPdfFileKey, oldPdfStorageProvider);
    scheduleEmbeddingSync("article.updated", knowledgeEmbeddingService.syncArticle(article.id));
    realtimeService.publish({
      type: "business.knowledge.article.updated",
      businessId: actor.businessId,
      broadcastToStaff: shouldBroadcastArticle(article),
      payload: { articleId, article },
    });
    return article;
  },

  async updateArticleStatus(actor: KnowledgeActor, articleId: string, status: KnowledgeArticleStatus, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "KNOWLEDGE_ARTICLE_STATUS_UPDATE");
    const existing = await prisma.knowledgeArticle.findFirst({ where: { id: articleId, businessId: actor.businessId } });
    if (!existing) return throwKnowledgeArticleNotFound(actor, articleId, context, "KNOWLEDGE_ARTICLE_STATUS_UPDATE");
    if (status === KnowledgeArticleStatus.PUBLISHED && (!existing.title.trim() || !existing.body.trim())) {
      throw new AppError(422, "Article must have a title and body before publishing.", "VALIDATION_ERROR");
    }
    const article = await prisma.$transaction(async (tx) => {
      if (isArticleRestore(existing.status, status)) {
        await assertAssetCapacityTx(tx, actor);
      }
      return tx.knowledgeArticle.update({
        where: { id: articleId },
        data: {
          status,
          ...(status === KnowledgeArticleStatus.PUBLISHED ? {
            publishedAt: new Date(),
            publishedByMembershipId: actor.membershipId,
            reviewedAt: existing.reviewedAt ?? new Date(),
            reviewedByMembershipId: existing.reviewedByMembershipId ?? actor.membershipId,
          } : {}),
          updatedByMembershipId: actor.membershipId,
        },
      });
    });
    const action = status === KnowledgeArticleStatus.PUBLISHED
      ? AuditAction.KNOWLEDGE_ARTICLE_PUBLISHED
      : status === KnowledgeArticleStatus.ARCHIVED
        ? AuditAction.KNOWLEDGE_ARTICLE_ARCHIVED
        : AuditAction.KNOWLEDGE_ARTICLE_UPDATED;
    await Promise.all([
      invalidateKnowledgeCaches(actor.businessId),
      auditService.log({ ...context, action, businessId: actor.businessId, userId: actor.userId, actorMembershipId: actor.membershipId, metadata: { articleId, status } }),
    ]);
    scheduleEmbeddingSync("article.status", knowledgeEmbeddingService.syncArticle(article.id));
    realtimeService.publish({
      type: "business.knowledge.article.updated",
      businessId: actor.businessId,
      broadcastToStaff: shouldBroadcastArticle(article),
      payload: { articleId, changes: { status } },
    });
    return article;
  },

  async archiveArticle(actor: KnowledgeActor, articleId: string, context: Omit<AuditInput, "action">) {
    return this.updateArticleStatus(actor, articleId, KnowledgeArticleStatus.ARCHIVED, context);
  },

  async draftArticle(actor: KnowledgeActor, input: DraftKnowledgeArticleInput, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "KNOWLEDGE_ARTICLE_AI_DRAFT");
    await Promise.all([assertAssetCapacity(actor), assertAiDraftCapacity(actor)]);
    await validateRelatedIds(actor.businessId, input);
    const draft = await generateArticleWithOpenRouter(actor, input);
    return saveGeneratedKnowledgeDraft(actor, input, draft, context);
  },

  async assertCanDraftArticle(actor: KnowledgeActor, input: DraftKnowledgeArticleInput) {
    await managerOnly(actor, undefined, "KNOWLEDGE_ARTICLE_AI_DRAFT");
    await Promise.all([assertAssetCapacity(actor), assertAiDraftCapacity(actor)]);
    await validateRelatedIds(actor.businessId, input);
  },

  async streamDraftArticle(
    actor: KnowledgeActor,
    input: DraftKnowledgeArticleInput,
    context: Omit<AuditInput, "action">,
    onEvent: (event: string, data: Record<string, unknown>) => void | Promise<void>,
  ) {
    const prompt = await buildKnowledgeDraftPrompt(actor, input, "markdown");
    await onEvent("draft_started", { status: "started", message: "AI is drafting the article..." });
    let streamedText = "";
    const completion: AiCompletionResult = await aiProvider.streamCompletion({
      businessId: actor.businessId,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      temperature: 0.25,
      maxTokens: 1400,
      metadata: { source: "KNOWLEDGE_ARTICLE_DRAFT" },
    }, {
      onToken: async (token) => {
        streamedText += token;
        await onEvent("draft_delta", { field: "body", delta: token });
      },
    });
    const markdown = (completion.rawText || streamedText).trim();
    if (!markdown) throw new AppError(502, "AI article draft response was empty.", "AI_OUTPUT_EMPTY");
    const draft = await structureMarkdownDraft(actor, input, markdown);
    await onEvent("draft_metadata", {
      title: draft.title,
      summary: draft.summary,
      category: draft.category,
      tags: draft.tags,
      visibility: input.visibility,
      status: KnowledgeArticleStatus.NEEDS_REVIEW,
      source: KnowledgeArticleSource.AI_DRAFT,
      aiGenerated: true,
      aiConfidence: draft.aiConfidence,
      aiDraftReason: draft.aiDraftReason,
    });
    const article = await saveGeneratedKnowledgeDraft(actor, input, draft, context);
    await onEvent("draft_saved", {
      articleId: article.id,
      status: article.status,
      source: article.source,
      aiGenerated: article.aiGenerated,
    });
    await onEvent("draft_completed", { success: true, articleId: article.id });
    return article;
  },

  async generateStarterArticles(actor: KnowledgeActor, input: GenerateStarterArticlesInput, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "KNOWLEDGE_ARTICLE_STARTER_GENERATION");
    const topics = (input.categories?.length ? input.categories : ["Services and pricing", "Booking appointments", "Business hours", "Payment and cancellation"]).slice(0, input.count);
    await Promise.all([assertAssetCapacity(actor, topics.length), assertAiDraftCapacity(actor, topics.length)]);
    const drafts: Array<Awaited<ReturnType<typeof generateArticleWithOpenRouter>>> = [];
    for (const topic of topics) {
      drafts.push(await generateArticleWithOpenRouter(actor, {
        topic,
        category: topic,
        relatedServiceIds: [],
        relatedPolicyIds: [],
        visibility: KnowledgeAssetVisibility.INTERNAL_ONLY,
      }));
    }
    const created = await prisma.$transaction(async (tx) => {
      await assertAssetCapacityTx(tx, actor, drafts.length);
      await assertAiDraftCapacityTx(tx, actor, drafts.length);
      const rows: KnowledgeArticle[] = [];
      for (const [index, draft] of drafts.entries()) {
        rows.push(await tx.knowledgeArticle.create({
          data: {
            businessId: actor.businessId,
            title: draft.title,
            slug: await uniqueSlug(actor.businessId, draft.title, undefined, undefined, tx),
            summary: draft.summary,
            body: draft.body,
            category: draft.category ?? topics[index],
            tags: draft.tags,
            relatedServiceIds: [],
            relatedPolicyIds: [],
            status: KnowledgeArticleStatus.NEEDS_REVIEW,
            source: KnowledgeArticleSource.AI_DRAFT,
            visibility: KnowledgeAssetVisibility.INTERNAL_ONLY,
            aiGenerated: true,
            aiPromptVersion: KNOWLEDGE_PROMPT_VERSION,
            aiDraftReason: draft.aiDraftReason,
            aiConfidence: draft.aiConfidence,
            createdByMembershipId: actor.membershipId,
            updatedByMembershipId: actor.membershipId,
          },
        }));
      }
      return rows;
    });
    const sideEffects = await Promise.allSettled([
      invalidateKnowledgeCaches(actor.businessId),
      ...created.map((article, index) => notifyManagersArticleNeedsReview(actor, article)
        .then(() => auditService.log({
          ...context,
          action: AuditAction.KNOWLEDGE_ARTICLE_AI_DRAFT_CREATED,
          businessId: actor.businessId,
          userId: actor.userId,
          actorMembershipId: actor.membershipId,
          metadata: { articleId: article.id, topic: topics[index], starterBatch: true },
        }))),
    ]);
    for (const result of sideEffects) {
      if (result.status === "rejected") {
        console.error("Starter knowledge article side effect failed", { error: result.reason });
      }
    }
    for (const article of created) {
      scheduleEmbeddingSync("article.starter_draft", knowledgeEmbeddingService.syncArticle(article.id));
      realtimeService.publish({
        type: "business.knowledge.article.created",
        businessId: actor.businessId,
        broadcastToStaff: shouldBroadcastArticle(article),
        payload: { article },
      });
    }
    return { data: created };
  },

  async listDocuments(actor: KnowledgeActor, query: KnowledgeDocumentListQuery) {
    const key = `business:${actor.businessId}:knowledge:documents:${actor.membershipId}:${JSON.stringify(query)}`;
    const cached = await cacheService.get<unknown>(key);
    if (cached) return cached;
    const filters: Prisma.KnowledgeDocumentWhereInput[] = [documentAccessWhere(actor)];
    if (query.status && actor.role !== BusinessRole.STAFF) filters.push({ status: query.status });
    if (query.visibility && actor.role !== BusinessRole.STAFF) filters.push({ visibility: query.visibility });
    if (query.category) filters.push({ category: { equals: query.category, mode: "insensitive" } });
    if (query.search) filters.push({
      OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
        { category: { contains: query.search, mode: "insensitive" } },
      ],
    });
    const where = { AND: filters };
    const [data, total] = await prisma.$transaction([
      prisma.knowledgeDocument.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.knowledgeDocument.count({ where }),
    ]);
    const result = { data, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } };
    await cacheService.set(key, result, 30);
    return result;
  },

  async uploadDocument(actor: KnowledgeActor, input: UploadKnowledgeDocumentMetadataInput, uploadedFile: Express.Multer.File, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "LEGACY_KNOWLEDGE_DOCUMENT_UPLOAD");
    let stored: Awaited<ReturnType<typeof storageService.uploadBuffer>> | null = null;
    try {
      await Promise.all([assertAssetCapacity(actor), assertPdfUploadCapacity(actor)]);
      await validateRelatedIds(actor.businessId, { relatedServiceIds: input.relatedServiceIds });
      const sanitized = await sanitizeUploadedPdf(input, uploadedFile);
      await assertStorageCapacity(actor, sanitized.buffer.byteLength);
      stored = await storageService.uploadBuffer({
        businessId: actor.businessId,
        folder: "documents",
        fileName: input.fileName,
        contentType: input.mimeType,
        buffer: sanitized.buffer,
      });
      const uploaded = stored;
      const document = await prisma.$transaction(async (tx) => {
        await assertAssetCapacityTx(tx, actor);
        await assertPdfUploadCapacityTx(tx, actor);
        await assertStorageCapacityTx(tx, actor, uploaded.fileSize);
        const created = await tx.knowledgeDocument.create({
          data: {
            businessId: actor.businessId,
            title: input.title,
            description: input.description ?? null,
            category: input.category ?? null,
            tags: input.tags,
            relatedServiceIds: input.relatedServiceIds,
            visibility: input.visibility,
            fileUrl: documentDownloadUrl("pending"),
            fileKey: uploaded.fileKey,
            fileName: uploaded.fileName,
            originalFileName: input.fileName,
            safeFileName: uploaded.fileName,
            fileExtension: "pdf",
            mimeType: input.mimeType,
            fileSize: uploaded.fileSize,
            checksum: crypto.createHash("sha256").update(sanitized.buffer).digest("hex"),
            uploadedByMembershipId: actor.membershipId,
          },
        });
        await tx.knowledgeDocument.update({
          where: { id: created.id },
          data: { fileUrl: documentDownloadUrl(created.id) },
        });
        created.fileUrl = documentDownloadUrl(created.id);
        await tx.knowledgeDocumentChunk.createMany({
          data: sanitized.chunks.map((chunk) => ({
            businessId: actor.businessId,
            documentId: created.id,
            chunkText: chunk.chunkText,
            pageNumber: chunk.pageNumber,
            tokenCount: chunk.tokenCount,
          })),
        });
        return created;
      });
      await Promise.all([
        invalidateKnowledgeCaches(actor.businessId),
        auditService.log({ ...context, action: AuditAction.KNOWLEDGE_DOCUMENT_UPLOADED, businessId: actor.businessId, userId: actor.userId, actorMembershipId: actor.membershipId, metadata: { documentId: document.id, fileName: document.fileName, originalSize: sanitized.originalSize, sanitizedSize: sanitized.buffer.byteLength, chunksCreated: sanitized.chunks.length, sanitized: true, uploadMode: "multipart" } }),
      ]);
      scheduleEmbeddingSync("document.uploaded", knowledgeEmbeddingService.syncDocument(document.id));
      realtimeService.publish({
        type: "business.knowledge.document.uploaded",
        businessId: actor.businessId,
        broadcastToStaff: shouldBroadcastDocument(document),
        payload: { document },
      });
      stored = null;
      return document;
    } catch (error) {
      if (stored?.fileKey) {
        await storageService.deleteFile(stored.fileKey, stored.storageProvider).catch((cleanupError) => {
          console.error("Failed to clean up uploaded knowledge document after error", { fileKey: stored?.fileKey, error: cleanupError });
        });
      }
      throw error;
    } finally {
      await unlink(uploadedFile.path).catch(() => undefined);
    }
  },

  async downloadDocument(actor: KnowledgeActor, documentId: string) {
    const document = await prisma.knowledgeDocument.findFirst({ where: documentAccessWhere(actor, documentId) });
    if (!document) throw new AppError(404, "Knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
    if (!document.fileKey) throw new AppError(404, "Document file is unavailable.", "KNOWLEDGE_ASSET_FILE_NOT_FOUND");
    const redirectUrl = await storageService.createSignedDownloadUrl(
      document.fileKey,
      document.fileName,
      document.storageProvider,
    );
    if (redirectUrl) {
      return {
        redirectUrl,
        fileName: document.fileName,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
      };
    }
    const buffer = await storageService.readBuffer(document.fileKey, document.storageProvider);
    return {
      buffer,
      fileName: document.fileName,
      mimeType: document.mimeType,
      fileSize: document.fileSize,
    };
  },

  async downloadArticlePdf(actor: KnowledgeActor, articleId: string) {
    const article = await prisma.knowledgeArticle.findFirst({ where: articleAccessWhere(actor, articleId) });
    if (!article) throw new AppError(404, "Knowledge article not found.", "KNOWLEDGE_ARTICLE_NOT_FOUND");
    const file = await knowledgePdfService.getOrGenerateArticlePdf(actor.businessId, articleId, { userId: actor.userId, actorMembershipId: actor.membershipId });
    if (!file?.fileKey) throw new AppError(404, "Article PDF is unavailable.", "KNOWLEDGE_ASSET_FILE_NOT_FOUND");
    const fileName = `${article.slug ?? article.id}.pdf`;
    const redirectUrl = await storageService.createSignedDownloadUrl(
      file.fileKey,
      fileName,
      file.storageProvider,
    );
    if (redirectUrl) {
      return {
        redirectUrl,
        fileName,
        mimeType: "application/pdf",
        fileSize: file.fileSize,
      };
    }
    const buffer = await storageService.readBuffer(file.fileKey, file.storageProvider);
    return {
      buffer,
      fileName,
      mimeType: "application/pdf",
      fileSize: buffer.byteLength,
    };
  },

  async detailDocument(actor: KnowledgeActor, documentId: string) {
    const document = await prisma.knowledgeDocument.findFirst({
      where: documentAccessWhere(actor, documentId),
      include: { _count: { select: { chunks: true } } },
    });
    if (!document) throw new AppError(404, "Knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
    return document;
  },

  async updateDocument(actor: KnowledgeActor, documentId: string, input: UpdateKnowledgeDocumentInput, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "KNOWLEDGE_DOCUMENT_UPDATE");
    const existing = await prisma.knowledgeDocument.findFirst({
      where: {
        id: documentId,
        businessId: actor.businessId,
        deletedAt: null,
        status: { not: KnowledgeDocumentStatus.DELETED },
      },
    });
    if (!existing) return throwKnowledgeDocumentNotFound(actor, documentId, context, "KNOWLEDGE_DOCUMENT_UPDATE");
    if (input.relatedServiceIds) await validateRelatedIds(actor.businessId, { relatedServiceIds: input.relatedServiceIds });
    const document = await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.relatedServiceIds !== undefined ? { relatedServiceIds: input.relatedServiceIds } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      },
    });
    await Promise.all([
      invalidateKnowledgeCaches(actor.businessId),
      auditService.log({ ...context, action: AuditAction.KNOWLEDGE_DOCUMENT_UPDATED, businessId: actor.businessId, userId: actor.userId, actorMembershipId: actor.membershipId, metadata: { documentId } }),
    ]);
    scheduleEmbeddingSync("document.updated", knowledgeEmbeddingService.syncDocument(document.id));
    realtimeService.publish({
      type: "business.knowledge.document.updated",
      businessId: actor.businessId,
      broadcastToStaff: shouldBroadcastDocument(document),
      payload: { documentId, document },
    });
    return document;
  },

  async updateDocumentStatus(actor: KnowledgeActor, documentId: string, status: KnowledgeDocumentStatus, context: Omit<AuditInput, "action">) {
    await managerOnly(actor, context, "KNOWLEDGE_DOCUMENT_STATUS_UPDATE");
    const existing = await prisma.knowledgeDocument.findFirst({ where: { id: documentId, businessId: actor.businessId } });
    if (!existing) return throwKnowledgeDocumentNotFound(actor, documentId, context, "KNOWLEDGE_DOCUMENT_STATUS_UPDATE");
    const document = await prisma.$transaction(async (tx) => {
      if (isDocumentRestore(existing.status, status)) {
        await assertAssetCapacityTx(tx, actor);
        await assertPdfUploadCapacityTx(tx, actor);
        // Archived objects already count as retained storage; restoring does not add bytes.
        await assertStorageCapacityTx(tx, actor, 0);
      }
      return tx.knowledgeDocument.update({ where: { id: documentId }, data: { status } });
    });
    await Promise.all([
      invalidateKnowledgeCaches(actor.businessId),
      auditService.log({ ...context, action: status === KnowledgeDocumentStatus.ARCHIVED ? AuditAction.KNOWLEDGE_DOCUMENT_ARCHIVED : AuditAction.KNOWLEDGE_DOCUMENT_UPDATED, businessId: actor.businessId, userId: actor.userId, actorMembershipId: actor.membershipId, metadata: { documentId, status } }),
    ]);
    scheduleEmbeddingSync("document.status", knowledgeEmbeddingService.syncDocument(document.id));
    realtimeService.publish({
      type: "business.knowledge.document.updated",
      businessId: actor.businessId,
      broadcastToStaff: shouldBroadcastDocument(document),
      payload: { documentId, changes: { status } },
    });
    return document;
  },

  async archiveDocument(actor: KnowledgeActor, documentId: string, context: Omit<AuditInput, "action">) {
    return this.updateDocumentStatus(actor, documentId, KnowledgeDocumentStatus.ARCHIVED, context);
  },

  async search(actor: KnowledgeActor, query: KnowledgeSearchQuery) {
    const vectorResults = await knowledgeEmbeddingService.search(actor.businessId, query.query, query.limit * 2).catch((error) => {
      console.error("Knowledge vector search failed; falling back to lexical search", { businessId: actor.businessId, error });
      return [];
    });
    if (vectorResults.length) {
      const articleIds = vectorResults.filter((result) => result.sourceType === "ARTICLE").map((result) => result.sourceId);
      const documentIds = Array.from(new Set(vectorResults.filter((result) => result.sourceType === "DOCUMENT_CHUNK").map((result) => result.sourceId)));
      const [articles, documents] = await Promise.all([
        articleIds.length ? prisma.knowledgeArticle.findMany({
          where: {
            businessId: actor.businessId,
            id: { in: articleIds },
            status: KnowledgeArticleStatus.PUBLISHED,
            visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
          },
        }) : [],
        documentIds.length ? prisma.knowledgeDocument.findMany({
          where: {
            businessId: actor.businessId,
            id: { in: documentIds },
            status: KnowledgeDocumentStatus.ACTIVE,
            processingStatus: KnowledgeDocumentProcessingStatus.READY,
            governanceStatus: KnowledgeGovernanceStatus.APPROVED,
            visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
            ...customerSafeKnowledgeDocumentWhere,
          },
        }) : [],
      ]);
      const articleById = new Map(articles.map((article) => [article.id, article]));
      const factIds = vectorResults.flatMap((result) => result.sourceType === "DOCUMENT_FACT" && result.chunkId ? [result.chunkId] : []);
      const facts = factIds.length ? await loadCustomerSafeKnowledgeFacts(actor.businessId, { ids: factIds, limit: factIds.length }) : [];
      const factById = new Map(facts.map((fact) => [fact.id, fact]));
      const documentById = new Map(documents.map((document) => [document.id, document]));
      const seen = new Set<string>();
      const semantic: Array<Record<string, unknown>> = [];
      for (const result of vectorResults) {
        const key = `${result.sourceType}:${result.sourceType === "DOCUMENT_FACT" ? result.chunkId : result.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (result.sourceType === "DOCUMENT_FACT") {
          const fact = result.chunkId ? factById.get(result.chunkId) : undefined;
          if (fact) semantic.push({ type: "KNOWLEDGE_FACT", sendable: false, fact: {
            id: fact.id, documentId: fact.documentId, documentTitle: fact.document.title,
            label: fact.label, valueText: fact.valueText, pageNumber: fact.pageNumber,
          }, score: result.score, retrieval: "semantic" });
          continue;
        }
        if (result.sourceType === "ARTICLE") {
          const article = articleById.get(result.sourceId);
          if (article) semantic.push({ type: KnowledgeAssetSendType.ARTICLE_PDF, article, score: result.score, retrieval: "semantic" });
          continue;
        }
        const document = documentById.get(result.sourceId);
        if (document) semantic.push({ type: KnowledgeAssetSendType.UPLOADED_DOCUMENT, document, score: result.score, matchedChunkId: result.chunkId, retrieval: "semantic" });
        if (semantic.length >= query.limit) break;
      }
      if (semantic.length) return { data: semantic.slice(0, query.limit) };
    }

    const articles = await prisma.knowledgeArticle.findMany({
      where: {
        businessId: actor.businessId,
        status: KnowledgeArticleStatus.PUBLISHED,
        visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
        OR: [
          { title: { contains: query.query, mode: "insensitive" } },
          { summary: { contains: query.query, mode: "insensitive" } },
          { body: { contains: query.query, mode: "insensitive" } },
          { category: { contains: query.query, mode: "insensitive" } },
        ],
      },
      take: query.limit,
      orderBy: { updatedAt: "desc" },
    });
    const remaining = Math.max(0, query.limit - articles.length);
    const documents = remaining ? await prisma.knowledgeDocument.findMany({
      where: {
        businessId: actor.businessId,
        status: KnowledgeDocumentStatus.ACTIVE,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        governanceStatus: KnowledgeGovernanceStatus.APPROVED,
        visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
        ...customerSafeKnowledgeDocumentWhere,
        OR: [
          { title: { contains: query.query, mode: "insensitive" } },
          { description: { contains: query.query, mode: "insensitive" } },
          { category: { contains: query.query, mode: "insensitive" } },
          { chunks: { some: { chunkText: { contains: query.query, mode: "insensitive" } } } },
        ],
      },
      take: remaining,
      orderBy: { updatedAt: "desc" },
    }) : [];
    const factLimit = Math.max(0, query.limit - articles.length - documents.length);
    const facts = factLimit ? await loadCustomerSafeKnowledgeFacts(actor.businessId, { query: query.query, limit: factLimit }) : [];
    return {
      data: [
        ...articles.map((article) => ({ type: KnowledgeAssetSendType.ARTICLE_PDF, article })),
        ...documents.map((document) => ({ type: KnowledgeAssetSendType.UPLOADED_DOCUMENT, document })),
        ...facts.map((fact) => ({ type: "KNOWLEDGE_FACT", sendable: false, fact: {
          id: fact.id, documentId: fact.documentId, documentTitle: fact.document.title,
          label: fact.label, valueText: fact.valueText, pageNumber: fact.pageNumber,
        } })),
      ],
    };
  },

  async sendToConversation(actor: KnowledgeActor, conversationId: string, input: SendKnowledgeAssetInput, context: Omit<AuditInput, "action">) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessId: actor.businessId, deletedAt: null },
      include: { lead: { select: { id: true, phone: true } } },
    });
    if (!conversation) throw new AppError(404, "Conversation not found.", "CONVERSATION_NOT_FOUND");
    if (actor.role === BusinessRole.STAFF && conversation.assignedStaffId !== actor.membershipId) {
      throw new AppError(403, "You do not have access to this conversation.", "FORBIDDEN");
    }
    if (conversation.status === ConversationStatus.PLAN_LIMIT_BLOCKED) {
      throw new AppError(423, "This conversation is locked because billing or quota needs attention.", "CONVERSATION_ACCESS_BLOCKED");
    }
    if (conversation.status === ConversationStatus.CLOSED) {
      throw new AppError(422, "Cannot send knowledge assets to a closed conversation.", "CONVERSATION_CLOSED");
    }

    const asset = input.assetType === KnowledgeAssetSendType.ARTICLE_PDF
      ? await prisma.knowledgeArticle.findFirst({ where: { id: input.articleId!, businessId: actor.businessId, status: KnowledgeArticleStatus.PUBLISHED, visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE } })
      : await prisma.knowledgeDocument.findFirst({
        where: {
          id: input.documentId!,
          businessId: actor.businessId,
          status: KnowledgeDocumentStatus.ACTIVE,
          processingStatus: KnowledgeDocumentProcessingStatus.READY,
          governanceStatus: KnowledgeGovernanceStatus.APPROVED,
          visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
          ...customerSafeKnowledgeDocumentWhere,
        },
      });
    if (!asset) throw new AppError(404, "Knowledge asset is not sendable.", "KNOWLEDGE_ASSET_NOT_SENDABLE");

    await auditService.log({
      ...context,
      action: AuditAction.KNOWLEDGE_ASSET_SENT_TO_CUSTOMER,
      businessId: actor.businessId,
      userId: actor.userId,
      actorMembershipId: actor.membershipId,
      metadata: json({
        conversationId,
        assetType: input.assetType,
        articleId: input.articleId ?? null,
        documentId: input.documentId ?? null,
        blocked: true,
        reason: MEDIA_SEND_NOT_READY,
        channel: conversation.channel as ConversationChannel,
      }),
    });
    throw new AppError(
      501,
      "Sending knowledge PDFs to WhatsApp is not available yet. Use the protected download endpoint until media sending is implemented.",
      "FEATURE_NOT_READY",
      { reason: MEDIA_SEND_NOT_READY, assetType: input.assetType, assetId: input.articleId ?? input.documentId },
    );
  },
};
