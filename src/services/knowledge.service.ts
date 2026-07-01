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
import { cacheService } from "./cache.service";
import { knowledgeEmbeddingService } from "./knowledge-embedding.service";
import { knowledgePdfService } from "./knowledge-pdf.service";
import { ConversationActor } from "./message.service";
import { notificationService } from "./notification.service";
import { realtimeService } from "./realtime.service";
import { storageService } from "./storage.service";
import { ACTIVE_SUBSCRIPTION_STATUSES, subscriptionService } from "./subscription.service";

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

function scheduleStorageDelete(label: string, fileKey?: string | null) {
  if (!fileKey) return;
  void storageService.deleteFile(fileKey).catch((error) => {
    console.error("Knowledge storage cleanup failed", { label, fileKey, error });
  });
}

function shouldBroadcastArticle(article: { status: KnowledgeArticleStatus; visibility: KnowledgeAssetVisibility }) {
  return article.status === KnowledgeArticleStatus.PUBLISHED && article.visibility === KnowledgeAssetVisibility.CLIENT_SENDABLE;
}

function shouldBroadcastDocument(document: { status: KnowledgeDocumentStatus; visibility: KnowledgeAssetVisibility }) {
  return document.status === KnowledgeDocumentStatus.ACTIVE && document.visibility === KnowledgeAssetVisibility.CLIENT_SENDABLE;
}

function isArticleRestore(existing: KnowledgeArticleStatus, next?: KnowledgeArticleStatus) {
  return existing === KnowledgeArticleStatus.ARCHIVED && next !== undefined && next !== KnowledgeArticleStatus.ARCHIVED;
}

function isDocumentRestore(existing: KnowledgeDocumentStatus, next: KnowledgeDocumentStatus) {
  return existing === KnowledgeDocumentStatus.ARCHIVED && next === KnowledgeDocumentStatus.ACTIVE;
}

function managerOnly(actor: KnowledgeActor) {
  if (actor.role === BusinessRole.STAFF) {
    throw new AppError(403, "Only an owner or manager can manage knowledge base assets.", "FORBIDDEN");
  }
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

function assetLimitForPlan(planCode: PlanCode, planLimit: number | null | undefined) {
  if (planLimit !== null && planLimit !== undefined) return planLimit;
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_ASSET_LIMIT;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_ASSET_LIMIT;
  return env.KNOWLEDGE_BASIC_ASSET_LIMIT;
}

function aiDraftLimitForPlan(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_AI_DRAFT_LIMIT;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_AI_DRAFT_LIMIT;
  return env.KNOWLEDGE_BASIC_AI_DRAFT_LIMIT;
}

function pdfUploadLimitForPlan(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_PDF_UPLOAD_LIMIT;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_PDF_UPLOAD_LIMIT;
  return env.KNOWLEDGE_BASIC_PDF_UPLOAD_LIMIT;
}

function storageLimitForPlan(planCode: PlanCode) {
  if (planCode === PlanCode.PREMIUM) return env.KNOWLEDGE_PREMIUM_STORAGE_LIMIT_BYTES;
  if (planCode === PlanCode.PLUS) return env.KNOWLEDGE_PLUS_STORAGE_LIMIT_BYTES;
  return env.KNOWLEDGE_BASIC_STORAGE_LIMIT_BYTES;
}

async function activeAssetCount(businessAccountId: string) {
  const whereBusiness = { businessAccountId };
  const [articles, documents] = await Promise.all([
    prisma.knowledgeArticle.count({ where: { status: { not: KnowledgeArticleStatus.ARCHIVED }, business: whereBusiness } }),
    prisma.knowledgeDocument.count({ where: { status: KnowledgeDocumentStatus.ACTIVE, business: whereBusiness } }),
  ]);
  return articles + documents;
}

async function activeStorageUsed(businessAccountId: string) {
  const result = await prisma.knowledgeDocument.aggregate({
    where: {
      status: KnowledgeDocumentStatus.ACTIVE,
      business: { businessAccountId },
    },
    _sum: { fileSize: true },
  });
  return result._sum.fileSize ?? 0;
}

async function activePdfCount(businessAccountId: string) {
  return prisma.knowledgeDocument.count({
    where: {
      status: KnowledgeDocumentStatus.ACTIVE,
      business: { businessAccountId },
    },
  });
}

async function activeAssetCountTx(tx: Prisma.TransactionClient, businessAccountId: string) {
  const whereBusiness = { businessAccountId };
  const [articles, documents] = await Promise.all([
    tx.knowledgeArticle.count({ where: { status: { not: KnowledgeArticleStatus.ARCHIVED }, business: whereBusiness } }),
    tx.knowledgeDocument.count({ where: { status: KnowledgeDocumentStatus.ACTIVE, business: whereBusiness } }),
  ]);
  return articles + documents;
}

async function activeStorageUsedTx(tx: Prisma.TransactionClient, businessAccountId: string) {
  const result = await tx.knowledgeDocument.aggregate({
    where: {
      status: KnowledgeDocumentStatus.ACTIVE,
      business: { businessAccountId },
    },
    _sum: { fileSize: true },
  });
  return result._sum.fileSize ?? 0;
}

async function activePdfCountTx(tx: Prisma.TransactionClient, businessAccountId: string) {
  return tx.knowledgeDocument.count({
    where: {
      status: KnowledgeDocumentStatus.ACTIVE,
      business: { businessAccountId },
    },
  });
}

async function lockKnowledgeQuota(tx: Prisma.TransactionClient, businessAccountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('knowledge_quota'), hashtext(${businessAccountId}))`;
}

async function currentSubscriptionTx(tx: Prisma.TransactionClient, businessAccountId: string) {
  const subscription = await tx.subscription.findFirst({
    where: { businessAccountId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  if (!subscription) throw new AppError(403, "No active subscription", "SUBSCRIPTION_REQUIRED");
  return subscription;
}

async function assertAssetCapacityTx(tx: Prisma.TransactionClient, actor: KnowledgeActor, increment = 1) {
  const subscription = await currentSubscriptionTx(tx, actor.businessAccountId);
  const limit = assetLimitForPlan(subscription.plan.code, subscription.plan.maxKnowledgeItems);
  const current = await activeAssetCountTx(tx, actor.businessAccountId);
  if (current + increment <= limit) return { subscription, current, limit };
  throw new AppError(403, `Your ${subscription.plan.name} plan allows ${limit} active knowledge assets.`, "KNOWLEDGE_ASSET_LIMIT_REACHED", {
    currentPlan: subscription.plan.code,
    currentUsage: current,
    limit,
    attemptedAmount: increment,
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
  const currentStorageUsed = await activeStorageUsedTx(tx, actor.businessAccountId);
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
  const limit = assetLimitForPlan(subscription.plan.code, subscription.plan.maxKnowledgeItems);
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
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  const storageLimit = storageLimitForPlan(subscription.plan.code);
  const currentStorageUsed = await activeStorageUsed(actor.businessAccountId);
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

async function generateArticleWithOpenRouter(actor: KnowledgeActor, input: DraftKnowledgeArticleInput) {
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
      select: { name: true, category: true, description: true, priceType: true, priceDescription: true, durationMinutes: true, isBookable: true },
    }),
    prisma.businessPolicy.findMany({
      where: { businessId: actor.businessId, isActive: true, isArchived: false },
      orderBy: [{ priority: "desc" }, { displayOrder: "asc" }],
      take: 15,
      select: { title: true, category: true, shortSummary: true, content: true },
    }),
  ]);
  const systemPrompt = "You draft concise, factual customer support knowledge base articles for a business. Return strict JSON only.";
  const userPrompt = [
    "Business context:",
    business ? JSON.stringify(business) : "Business profile unavailable.",
    "Services:",
    JSON.stringify(services),
    "Policies:",
    JSON.stringify(policies.map((policy) => ({ ...policy, content: policy.shortSummary ?? policy.content.slice(0, 800) }))),
    "",
    "Create one knowledge base article draft.",
    `Topic: ${input.topic}`,
    input.category ? `Category: ${input.category}` : "",
    input.customerQuestion ? `Customer question: ${input.customerQuestion}` : "",
    "Return JSON with title, summary, body, category, tags, confidence, draftReason.",
    "Body must be practical, specific to the business context, and safe for a human to review before publishing.",
  ].filter(Boolean).join("\n");

  const response = await fetch(`${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": env.OPENROUTER_APP_URL ?? env.APP_URL,
      "X-Title": env.OPENROUTER_APP_NAME,
    },
    body: JSON.stringify({
      model: env.OPENROUTER_DEFAULT_MODEL,
      temperature: 0.25,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      metadata: { businessId: actor.businessId, source: "KNOWLEDGE_ARTICLE_DRAFT" },
    }),
    signal: AbortSignal.timeout(env.OPENROUTER_TIMEOUT_MS),
  });
  const raw = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } | null;
  const content = raw?.choices?.[0]?.message?.content;
  if (!response.ok || !content) throw new AppError(502, raw?.error?.message ?? "AI article draft failed.", "AI_PROVIDER_ERROR");
  const parsed = JSON.parse(content) as Partial<{
    title: string;
    summary: string;
    body: string;
    category: string;
    tags: string[];
    confidence: number;
    draftReason: string;
  }>;
  if (!parsed.title || !parsed.body) throw new AppError(502, "AI article draft response was incomplete.", "AI_RESPONSE_PARSE_ERROR");
  return {
    title: parsed.title.slice(0, 160),
    summary: parsed.summary?.slice(0, 500) ?? null,
    body: parsed.body,
    category: parsed.category ?? input.category ?? null,
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === "string").slice(0, 12) : [],
    aiConfidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : null,
    aiDraftReason: parsed.draftReason ?? input.customerQuestion ?? input.topic,
  };
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
      visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
    } : {}),
  };
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
    managerOnly(actor);
    const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
    const [assetUsed, pdfUsed, storageUsedBytes, aiDraftUsedThisMonth, businesses, articleGroups, documentGroups] = await Promise.all([
      activeAssetCount(actor.businessAccountId),
      activePdfCount(actor.businessAccountId),
      activeStorageUsed(actor.businessAccountId),
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
        _sum: { fileSize: true },
      }),
    ]);
    const articleCountByBusiness = new Map(articleGroups.map((group) => [group.businessId, group._count._all]));
    const documentStatsByBusiness = new Map(documentGroups.map((group) => [group.businessId, {
      activePdfCount: group._count._all,
      usedBytes: group._sum.fileSize ?? 0,
    }]));
    return {
      assetUsage: {
        used: assetUsed,
        limit: assetLimitForPlan(subscription.plan.code, subscription.plan.maxKnowledgeItems),
      },
      pdfUsage: {
        used: pdfUsed,
        limit: pdfUploadLimitForPlan(subscription.plan.code),
      },
      storageUsage: {
        usedBytes: storageUsedBytes,
        limitBytes: storageLimitForPlan(subscription.plan.code),
      },
      aiDraftUsage: {
        usedThisMonth: aiDraftUsedThisMonth,
        monthlyLimit: aiDraftLimitForPlan(subscription.plan.code),
      },
      businessStorageBreakdown: businesses.map((business) => {
        const documentStats = documentStatsByBusiness.get(business.id) ?? { activePdfCount: 0, usedBytes: 0 };
        return {
          businessId: business.id,
          businessName: business.name,
          usedBytes: documentStats.usedBytes,
          activeAssets: (articleCountByBusiness.get(business.id) ?? 0) + documentStats.activePdfCount,
          activePdfCount: documentStats.activePdfCount,
        };
      }),
    };
  },

  async createArticle(actor: KnowledgeActor, input: CreateKnowledgeArticleInput, context: Omit<AuditInput, "action">) {
    managerOnly(actor);
    await validateRelatedIds(actor.businessId, input);
    const article = await prisma.$transaction(async (tx) => {
      await lockKnowledgeQuota(tx, actor.businessAccountId);
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
    managerOnly(actor);
    const existing = await prisma.knowledgeArticle.findFirst({ where: { id: articleId, businessId: actor.businessId } });
    if (!existing) throw new AppError(404, "Knowledge article not found.", "KNOWLEDGE_ARTICLE_NOT_FOUND");
    if (input.relatedServiceIds || input.relatedPolicyIds) await validateRelatedIds(actor.businessId, input);
    const slug = input.title || input.slug ? await uniqueSlug(actor.businessId, input.title ?? existing.title, input.slug ?? existing.slug, articleId) : undefined;
    const oldPdfFileKey = input.body !== undefined ? existing.pdfFileKey : null;
    const article = await prisma.$transaction(async (tx) => {
      if (isArticleRestore(existing.status, input.status)) {
        await lockKnowledgeQuota(tx, actor.businessAccountId);
        await assertAssetCapacityTx(tx, actor);
      }
      return tx.knowledgeArticle.update({
        where: { id: articleId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(slug ? { slug } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.body !== undefined ? { body: input.body, pdfFileKey: null, pdfFileUrl: null, lastPdfGeneratedAt: null } : {}),
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
    scheduleStorageDelete("article.pdf_stale_after_update", oldPdfFileKey);
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
    managerOnly(actor);
    const existing = await prisma.knowledgeArticle.findFirst({ where: { id: articleId, businessId: actor.businessId } });
    if (!existing) throw new AppError(404, "Knowledge article not found.", "KNOWLEDGE_ARTICLE_NOT_FOUND");
    if (status === KnowledgeArticleStatus.PUBLISHED && (!existing.title.trim() || !existing.body.trim())) {
      throw new AppError(422, "Article must have a title and body before publishing.", "VALIDATION_ERROR");
    }
    const article = await prisma.$transaction(async (tx) => {
      if (isArticleRestore(existing.status, status)) {
        await lockKnowledgeQuota(tx, actor.businessAccountId);
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
    managerOnly(actor);
    await Promise.all([assertAssetCapacity(actor), assertAiDraftCapacity(actor)]);
    await validateRelatedIds(actor.businessId, input);
    const draft = await generateArticleWithOpenRouter(actor, input);
    const article = await prisma.$transaction(async (tx) => {
      await lockKnowledgeQuota(tx, actor.businessAccountId);
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
    });
    await Promise.all([
      invalidateKnowledgeCaches(actor.businessId),
      notifyManagersArticleNeedsReview(actor, article),
      auditService.log({ ...context, action: AuditAction.KNOWLEDGE_ARTICLE_AI_DRAFT_CREATED, businessId: actor.businessId, userId: actor.userId, actorMembershipId: actor.membershipId, metadata: { articleId: article.id, topic: input.topic } }),
    ]);
    scheduleEmbeddingSync("article.ai_draft", knowledgeEmbeddingService.syncArticle(article.id));
    realtimeService.publish({
      type: "business.knowledge.article.created",
      businessId: actor.businessId,
      broadcastToStaff: shouldBroadcastArticle(article),
      payload: { article },
    });
    return article;
  },

  async generateStarterArticles(actor: KnowledgeActor, input: GenerateStarterArticlesInput, context: Omit<AuditInput, "action">) {
    managerOnly(actor);
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
      await lockKnowledgeQuota(tx, actor.businessAccountId);
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
    await Promise.all([
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
    managerOnly(actor);
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
        await lockKnowledgeQuota(tx, actor.businessAccountId);
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
            mimeType: input.mimeType,
            fileSize: uploaded.fileSize,
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
        await storageService.deleteFile(stored.fileKey).catch((cleanupError) => {
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
    const buffer = await storageService.readBuffer(document.fileKey);
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
    const buffer = await storageService.readBuffer(file.fileKey);
    return {
      buffer,
      fileName: `${article.slug ?? article.id}.pdf`,
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
    managerOnly(actor);
    const existing = await prisma.knowledgeDocument.findFirst({ where: { id: documentId, businessId: actor.businessId } });
    if (!existing) throw new AppError(404, "Knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
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
    managerOnly(actor);
    const existing = await prisma.knowledgeDocument.findFirst({ where: { id: documentId, businessId: actor.businessId } });
    if (!existing) throw new AppError(404, "Knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
    const document = await prisma.$transaction(async (tx) => {
      if (isDocumentRestore(existing.status, status)) {
        await lockKnowledgeQuota(tx, actor.businessAccountId);
        await assertAssetCapacityTx(tx, actor);
        await assertPdfUploadCapacityTx(tx, actor);
        await assertStorageCapacityTx(tx, actor, existing.fileSize);
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
            visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
          },
        }) : [],
      ]);
      const articleById = new Map(articles.map((article) => [article.id, article]));
      const documentById = new Map(documents.map((document) => [document.id, document]));
      const seen = new Set<string>();
      const semantic: Array<Record<string, unknown>> = [];
      for (const result of vectorResults) {
        const key = `${result.sourceType}:${result.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
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
        visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE,
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
    return {
      data: [
        ...articles.map((article) => ({ type: KnowledgeAssetSendType.ARTICLE_PDF, article })),
        ...documents.map((document) => ({ type: KnowledgeAssetSendType.UPLOADED_DOCUMENT, document })),
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
      : await prisma.knowledgeDocument.findFirst({ where: { id: input.documentId!, businessId: actor.businessId, status: KnowledgeDocumentStatus.ACTIVE, visibility: KnowledgeAssetVisibility.CLIENT_SENDABLE } });
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
