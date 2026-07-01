import { AuditAction, Prisma } from "@prisma/client";
import PDFDocument from "pdfkit";
import { prisma } from "../config/prisma";
import { auditService } from "./audit.service";
import { storageService } from "./storage.service";

type ArticlePdfInput = {
  title: string;
  summary: string | null;
  body: string;
  category: string | null;
  tags: string[];
  updatedAt: Date;
  business: {
    name: string;
    phone: string | null;
    email: string | null;
    website: string | null;
  };
};

const PAGE_MARGIN = 56;
const FOOTER_HEIGHT = 44;

function articleDownloadUrl(articleId: string) {
  return `/api/business/knowledge/articles/${articleId}/download`;
}

function safePdfFileName(value: string) {
  const base = value.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "knowledge-article";
  return `${base}.pdf`;
}

function collectPdf(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function pageBottom(doc: PDFKit.PDFDocument) {
  return doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT;
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (doc.y + height > pageBottom(doc)) {
    doc.addPage();
  }
}

function writeParagraph(doc: PDFKit.PDFDocument, text: string, options: PDFKit.Mixins.TextOptions = {}) {
  const trimmed = text.trim();
  if (!trimmed) {
    doc.moveDown(0.6);
    return;
  }
  const width = doc.page.width - PAGE_MARGIN * 2;
  const height = doc.heightOfString(trimmed, { width, ...options });
  ensureSpace(doc, height + 12);
  doc.text(trimmed, PAGE_MARGIN, doc.y, { width, lineGap: 3, ...options });
  doc.moveDown(0.65);
}

function writeMetaPill(doc: PDFKit.PDFDocument, label: string) {
  const textWidth = Math.min(doc.widthOfString(label) + 18, 220);
  ensureSpace(doc, 24);
  doc.roundedRect(PAGE_MARGIN, doc.y, textWidth, 20, 6).fill("#eef2ff");
  doc.fillColor("#3730a3").font("Helvetica-Bold").fontSize(8).text(label, PAGE_MARGIN + 9, doc.y - 16, {
    width: textWidth - 18,
    lineBreak: false,
  });
  doc.fillColor("#111827").moveDown(1);
}

function writeHeader(doc: PDFKit.PDFDocument, article: ArticlePdfInput) {
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text(article.business.name, PAGE_MARGIN, 28, {
    width: doc.page.width - PAGE_MARGIN * 2,
    align: "left",
  });
  doc.moveTo(PAGE_MARGIN, 48).lineTo(doc.page.width - PAGE_MARGIN, 48).strokeColor("#e5e7eb").lineWidth(1).stroke();
  doc.fillColor("#111827");
}

function writeFooters(doc: PDFKit.PDFDocument, article: ArticlePdfInput) {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(i);
    const pageNumber = i + 1;
    const footerY = doc.page.height - 42;
    doc.moveTo(PAGE_MARGIN, footerY - 10).lineTo(doc.page.width - PAGE_MARGIN, footerY - 10).strokeColor("#e5e7eb").lineWidth(1).stroke();
    doc.fillColor("#6b7280").font("Helvetica").fontSize(8);
    const contact = [article.business.phone, article.business.email, article.business.website].filter(Boolean).join(" | ");
    doc.text(contact || "BizReply AI knowledge article", PAGE_MARGIN, footerY, {
      width: doc.page.width - PAGE_MARGIN * 2 - 80,
      lineBreak: false,
    });
    doc.text(`Page ${pageNumber} of ${pages.count}`, PAGE_MARGIN, footerY, {
      width: doc.page.width - PAGE_MARGIN * 2,
      align: "right",
      lineBreak: false,
    });
  }
}

function writeArticleBody(doc: PDFKit.PDFDocument, article: ArticlePdfInput) {
  writeHeader(doc, article);
  doc.y = 82;
  if (article.category) writeMetaPill(doc, article.category);
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(24);
  writeParagraph(doc, article.title, { lineGap: 5 });
  doc.fillColor("#6b7280").font("Helvetica").fontSize(9);
  writeParagraph(doc, `Last updated ${article.updatedAt.toISOString().slice(0, 10)}`);

  if (article.tags.length) {
    doc.fillColor("#4b5563").font("Helvetica").fontSize(9);
    writeParagraph(doc, `Tags: ${article.tags.join(", ")}`);
  }

  if (article.summary) {
    ensureSpace(doc, 72);
    doc.roundedRect(PAGE_MARGIN, doc.y, doc.page.width - PAGE_MARGIN * 2, 64, 8).fill("#f9fafb");
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text("Summary", PAGE_MARGIN + 16, doc.y - 52);
    doc.fillColor("#374151").font("Helvetica").fontSize(10).text(article.summary, PAGE_MARGIN + 16, doc.y + 2, {
      width: doc.page.width - PAGE_MARGIN * 2 - 32,
      lineGap: 3,
    });
    doc.y += 72;
  }

  doc.fillColor("#111827").font("Helvetica").fontSize(11);
  for (const block of article.body.split(/\n{2,}/)) {
    const line = block.trim();
    if (!line) continue;
    if (/^#{1,3}\s+/.test(line)) {
      ensureSpace(doc, 40);
      doc.fillColor("#111827").font("Helvetica-Bold").fontSize(15);
      writeParagraph(doc, line.replace(/^#{1,3}\s+/, ""));
      doc.fillColor("#111827").font("Helvetica").fontSize(11);
      continue;
    }
    if (/^[-*]\s+/m.test(line)) {
      for (const item of line.split("\n").map((entry) => entry.replace(/^[-*]\s+/, "").trim()).filter(Boolean)) {
        ensureSpace(doc, 28);
        doc.circle(PAGE_MARGIN + 4, doc.y + 6, 2).fill("#111827");
        doc.fillColor("#111827").font("Helvetica").fontSize(11).text(item, PAGE_MARGIN + 16, doc.y - 7, {
          width: doc.page.width - PAGE_MARGIN * 2 - 16,
          lineGap: 3,
        });
        doc.moveDown(0.4);
      }
      continue;
    }
    doc.fillColor("#111827").font("Helvetica").fontSize(11);
    writeParagraph(doc, line);
  }
}

async function createArticlePdf(article: ArticlePdfInput) {
  const doc = new PDFDocument({
    size: "A4",
    margin: PAGE_MARGIN,
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: article.title,
      Author: article.business.name,
      Subject: article.summary ?? "Knowledge base article",
      Keywords: article.tags.join(", "),
      Creator: "BizReply AI",
      Producer: "BizReply AI",
    },
  });
  const result = collectPdf(doc);
  writeArticleBody(doc, article);
  writeFooters(doc, article);
  doc.end();
  return result;
}

export const knowledgePdfService = {
  async getOrGenerateArticlePdf(
    businessId: string,
    articleId: string,
    context: { userId?: string | null; actorMembershipId?: string | null } = {},
  ) {
    const article = await prisma.knowledgeArticle.findFirst({
      where: { id: articleId, businessId },
      include: { business: { select: { name: true, phone: true, email: true, website: true } } },
    });
    if (!article) return null;
    if (article.pdfFileKey && article.pdfFileUrl && article.lastPdfGeneratedAt && article.lastPdfGeneratedAt >= article.updatedAt) {
      try {
        const info = await storageService.statFile(article.pdfFileKey);
        return {
          fileKey: article.pdfFileKey,
          fileUrl: articleDownloadUrl(article.id),
          fileName: safePdfFileName(article.slug ?? article.title),
          mimeType: "application/pdf",
          fileSize: info.fileSize,
        };
      } catch (error) {
        console.error("Cached article PDF is missing or unreadable; regenerating", { articleId, fileKey: article.pdfFileKey, error });
      }
    }

    const buffer = await createArticlePdf(article);
    const oldFileKey = article.pdfFileKey;
    const stored = await storageService.uploadBuffer({
      businessId,
      folder: "article-pdfs",
      fileName: safePdfFileName(article.slug ?? article.title),
      contentType: "application/pdf",
      buffer,
    });
    await prisma.knowledgeArticle.update({
      where: { id: article.id },
      data: {
        pdfFileKey: stored.fileKey,
        pdfFileUrl: articleDownloadUrl(article.id),
        lastPdfGeneratedAt: new Date(),
      },
    });
    if (oldFileKey && oldFileKey !== stored.fileKey) {
      await storageService.deleteFile(oldFileKey).catch((error) => {
        console.error("Failed to delete stale article PDF", { articleId, fileKey: oldFileKey, error });
      });
    }
    const url = articleDownloadUrl(article.id);
    await auditService.log({
      action: AuditAction.KNOWLEDGE_ARTICLE_PDF_GENERATED,
      businessId,
      userId: context.userId ?? null,
      actorMembershipId: context.actorMembershipId ?? null,
      metadata: { articleId, fileKey: stored.fileKey, generator: "pdfkit" } as Prisma.InputJsonValue,
    });
    return { ...stored, fileUrl: url };
  },
};
