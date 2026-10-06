import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { resolveKnowledgeQualitySchema, type ResolveKnowledgeQualityInput } from "../validation/knowledge-quality.schemas";
import { knowledgeQualityAuditService } from "./knowledge-quality-audit.service";
import { knowledgeService, type KnowledgeArticleMutationGuard } from "./knowledge.service";
import { assertCanManageKnowledgeDocuments } from "./knowledge-document/knowledge-document.types";
import type { ConversationActor } from "./message.service";
import type { AuditInput } from "./audit.service";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const staleFinding = () => new AppError(409, "The quality finding has changed; refresh the audit", "KNOWLEDGE_QUALITY_FINDING_STALE");
const staleArticle = () => new AppError(409, "The selected article has changed; refresh the audit", "KNOWLEDGE_QUALITY_ARTICLE_STALE");
type ResolutionSnapshot = {
  action: ResolveKnowledgeQualityInput["action"];
  articleId: string | null;
  updatedAt?: string;
  status?: string;
  reviewStatus?: "DISMISSED";
};

export const knowledgeQualityRemediationService = {
  async resolve(actor: ConversationActor, raw: unknown, idempotencyKey: string | undefined, context: Omit<AuditInput, "action">) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_QUALITY_RESOLVE");
    const input = resolveKnowledgeQualitySchema.parse(raw);
    if (!idempotencyKey?.trim() || idempotencyKey.length > 200) throw new AppError(400, "Idempotency-Key is required (max 200 characters)", "KNOWLEDGE_QUALITY_IDEMPOTENCY_REQUIRED");
    const key = hash(idempotencyKey.trim());
    const checksum = hash(JSON.stringify(input));
    const receiptWhere = { businessId: actor.businessId, idempotencyKey: key };
    const replay = async () => {
      const row = await prisma.knowledgeQualityReview.findFirst({ where: receiptWhere });
      if (row && row.requestChecksum !== checksum) throw new AppError(409, "Idempotency-Key was used for another request", "KNOWLEDGE_QUALITY_IDEMPOTENCY_CONFLICT");
      return row;
    };
    const present = async (result: Prisma.JsonValue) => {
      const fresh = await knowledgeQualityAuditService.audit(actor.businessId);
      const selected = input.action === "DISMISS" ? undefined : input.articleId;
      return { ...(result as ResolutionSnapshot), originalFindingStillAppears: fresh.findings.some(f => f.findingKey === input.findingKey), findings: fresh.findings.filter(f => selected ? f.articleIds.includes(selected) : f.findingKey === input.findingKey) };
    };
    const existing = await replay();
    if (existing) return present(existing.resultSnapshot);
    const audit = await knowledgeQualityAuditService.audit(actor.businessId);
    const finding = audit.findings.find(f => f.findingKey === input.findingKey);
    if (!finding) throw staleFinding();
    if (input.action !== "DISMISS") {
      if (!finding.articleIds.includes(input.articleId)) throw staleFinding();
      if (finding.articleRevisions.find(r => r.articleId === input.articleId)?.updatedAt !== new Date(input.expectedArticleUpdatedAt).toISOString()) throw staleArticle();
    }
    const verify = async (tx: Prisma.TransactionClient) => {
      // Lock every affected article in deterministic order, then recompute under those locks.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "KnowledgeArticle" WHERE "businessId" = ${actor.businessId} AND "id" IN (${Prisma.join(finding.articleIds)}) ORDER BY "id" FOR UPDATE`);
      const current = await knowledgeQualityAuditService.audit(actor.businessId, tx);
      if (!current.findings.some(f => f.findingKey === input.findingKey)) throw staleFinding();
      if (input.action === "UPDATE_RELATIONSHIPS") {
        // Lock explicitly selected current tenant entities against concurrent archival/deactivation.
        const serviceIds = input.relatedServiceIds;
        const policyIds = input.relatedPolicyIds;
        const services = serviceIds.length ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Service" WHERE "businessId" = ${actor.businessId} AND "id" IN (${Prisma.join(serviceIds)}) AND "isActive" = true AND "isArchived" = false ORDER BY "id" FOR SHARE`) : [];
        const policies = policyIds.length ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "BusinessPolicy" WHERE "businessId" = ${actor.businessId} AND "id" IN (${Prisma.join(policyIds)}) AND "isActive" = true AND "isArchived" = false AND "visibility" = 'CUSTOMER_FACING' ORDER BY "id" FOR SHARE`) : [];
        if (services.length !== serviceIds.length || policies.length !== policyIds.length) throw new AppError(422, "Relationships must reference current customer-facing entities in this business", "KNOWLEDGE_QUALITY_RELATIONSHIP_INVALID");
      }
    };
    const record = async (tx: Prisma.TransactionClient, result: Prisma.InputJsonValue) => {
      await tx.knowledgeQualityReview.create({ data: { ...receiptWhere, findingKey: input.findingKey, findingCode: finding.code, action: input.action, requestChecksum: checksum, actorUserId: actor.userId, actorMembershipId: actor.membershipId, note: input.note, resultSnapshot: result } });
    };
    try {
      if (input.action === "DISMISS") {
        await prisma.$transaction(async tx => {
          await verify(tx);
          await record(tx, { action: input.action, articleId: null, reviewStatus: "DISMISSED" });
        });
      } else {
        const guard: KnowledgeArticleMutationGuard = { expectedUpdatedAt: new Date(input.expectedArticleUpdatedAt), beforeWrite: verify,
          afterWrite: (tx, article) => record(tx, { action: input.action, articleId: article.id, updatedAt: article.updatedAt.toISOString(), status: article.status }) };
        if (input.action === "ARCHIVE_ARTICLE") await knowledgeService.archiveArticle(actor, input.articleId, context, guard);
        else await knowledgeService.updateArticle(actor, input.articleId, input.action === "UPDATE_CATEGORY" ? { category: input.category } : { relatedServiceIds: input.relatedServiceIds, relatedPolicyIds: input.relatedPolicyIds }, context, guard);
      }
    } catch (error) {
      // A concurrent winner or a post-commit side-effect failure must replay its atomic receipt.
      const committed = await replay();
      if (committed) return present(committed.resultSnapshot);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") throw staleArticle();
      throw error;
    }
    const committed = await replay();
    if (!committed) throw new AppError(500, "Quality review receipt missing", "KNOWLEDGE_QUALITY_RECEIPT_MISSING");
    return present(committed.resultSnapshot);
  },
};
