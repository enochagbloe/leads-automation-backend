import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";

export type KnowledgeQualityFinding = {
  code: "DUPLICATE_CUSTOMER_ARTICLE" | "CATEGORY_NORMALIZATION_NEEDED" | "MISSING_RELEVANCE_METADATA" | "POSSIBLE_OUT_OF_DOMAIN_ARTICLE";
  severity: "INFO" | "WARNING";
  articleIds: string[];
  suggestedAction: string;
};
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const stop = new Set("a an the and or of to in on for with by is are we our us your you this that it at as from be can will have has company business service services information policy policies general customer customers about welcome overview introduction contact ltd limited".split(" "));
const tokens = (s: string) => new Set(normalize(s).split(" ").filter(w => w.length > 2 && !stop.has(w)));
function sameContent(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  // Never hide changed quantities, negations or word order behind a bag-of-words match.
  if (JSON.stringify(a.match(/[\p{Sc}%]/gu)) !== JSON.stringify(b.match(/[\p{Sc}%]/gu))) return false;
  if (JSON.stringify(a.match(/\d+/g)) !== JSON.stringify(b.match(/\d+/g))) return false;
  if (JSON.stringify(a.match(/\b(?:not|no|never|except|only|without)\b/g)) !== JSON.stringify(b.match(/\b(?:not|no|never|except|only|without)\b/g))) return false;
  const shingles = (s: string) => { const words = s.split(" "); return new Set(words.slice(0, -4).map((_, i) => words.slice(i, i + 5).join(" "))); };
  const x = shingles(a), y = shingles(b), union = new Set([...x, ...y]);
  return x.size >= 20 && y.size >= 20 && [...x].filter(w => y.has(w)).length / union.size >= .97;
}

/** Read-only, bounded tenant audit. Findings are suggestions, never governance mutations. */
export const knowledgeQualityAuditService = {
  async audit(businessId: string) {
    if (typeof businessId !== "string" || !businessId.trim() || businessId.length > 200) throw new AppError(400, "A business scope is required", "KNOWLEDGE_AUDIT_SCOPE_REQUIRED");
    return prisma.$transaction(async tx => {
      const business = await tx.business.findFirst({ where: { id: businessId }, select: { name: true, industry: true, description: true } });
      if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
      const articles = await tx.knowledgeArticle.findMany({ where: { businessId, status: "PUBLISHED", visibility: "CLIENT_SENDABLE" }, orderBy: { id: "asc" }, take: 5001,
        select: { id: true, title: true, body: true, summary: true, category: true, tags: true, relatedServiceIds: true, relatedPolicyIds: true } });
      if (articles.length > 5000) throw new AppError(422, "Audit supports at most 5000 eligible articles per business", "KNOWLEDGE_AUDIT_LIMIT_EXCEEDED");
      const services = await tx.service.findMany({ where: { businessId, isActive: true, isArchived: false }, select: { name: true, category: true } });
      const policies = await tx.businessPolicy.findMany({ where: { businessId, isActive: true, isArchived: false, visibility: "CUSTOMER_FACING" }, select: { title: true, category: true } });
      const anchors = tokens([business.name, business.industry, business.description, ...services.flatMap(s => [s.name, s.category]), ...policies.flatMap(p => [p.title, p.category])].filter(Boolean).join(" "));
      const findings: KnowledgeQualityFinding[] = [];
      const add = (code: KnowledgeQualityFinding["code"], articleIds: string[], suggestedAction: string) => findings.push({ code, severity: code === "CATEGORY_NORMALIZATION_NEEDED" ? "INFO" : "WARNING", articleIds: [...articleIds].sort(), suggestedAction });
      const titleGroups = new Map<string, typeof articles>();
      const categories = new Map<string, typeof articles>();
      for (const article of articles) {
        const title = normalize(article.title); if (title) titleGroups.set(title, [...(titleGroups.get(title) ?? []), article]);
        if (article.category?.trim()) { const key = normalize(article.category); categories.set(key, [...(categories.get(key) ?? []), article]); }
        const unlinked = !article.relatedServiceIds.length && !article.relatedPolicyIds.length;
        const cues = normalize([article.title, article.category, ...article.tags].filter(Boolean).join(" "));
        const specific = /\b(?:services?|polic(?:y|ies)|payments?|deposits?|refunds?|cancellations?|pricing|fees|appointments?)\b/.test(cues)
          || services.some(s => normalize(s.name).length > 3 && cues.includes(normalize(s.name)));
        if (unlinked && specific) add("MISSING_RELEVANCE_METADATA", [article.id], "Review relevance and link existing services or policies only when supported by the article.");
        const words = tokens(`${article.title} ${article.summary ?? ""} ${article.body}`);
        const genericCompany = /^(?:about us|about our company|company overview|business overview|welcome|company introduction)$/.test(normalize(article.title));
        if (unlinked && !genericCompany && anchors.size >= 3 && words.size >= 8 && ![...words].some(w => anchors.has(w))) add("POSSIBLE_OUT_OF_DOMAIN_ARTICLE", [article.id], "Human review: verify relevance to this business. Lexical mismatch is not proof of inappropriate content.");
      }
      for (const group of titleGroups.values()) {
        const clusters: Array<typeof articles> = [];
        const content = (a: typeof articles[number]) => `${a.summary ?? ""} ${a.body}`.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{Sc}%]+/gu, " ").trim();
        for (const article of group) {
          const cluster = clusters.find(g => g.every(other => sameContent(content(article), content(other))));
          if (cluster) cluster.push(article); else clusters.push([article]);
        }
        for (const cluster of clusters) if (cluster.length > 1) add("DUPLICATE_CUSTOMER_ARTICLE", cluster.map(a => a.id), "Compare these articles and choose an authoritative source; merge or archive only after human approval.");
      }
      for (const group of categories.values()) if (new Set(group.map(a => a.category)).size > 1) add("CATEGORY_NORMALIZATION_NEEDED", group.map(a => a.id), "Review category spelling/casing/spacing and choose a consistent label; no rename has been applied.");
      findings.sort((a, b) => a.code.localeCompare(b.code) || a.articleIds.join(",").localeCompare(b.articleIds.join(",")));
      return { businessId, findings, summary: { articlesScanned: articles.length, findings: findings.length,
        duplicateGroups: findings.filter(f => f.code === "DUPLICATE_CUSTOMER_ARTICLE").length,
        categoryConflictGroups: findings.filter(f => f.code === "CATEGORY_NORMALIZATION_NEEDED").length,
        articlesNeedingReview: new Set(findings.flatMap(f => f.articleIds)).size } };
    }, { isolationLevel: "RepeatableRead" });
  },
};
