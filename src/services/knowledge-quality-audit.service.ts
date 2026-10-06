import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";

export type KnowledgeQualityFinding = {
  code: "DUPLICATE_CUSTOMER_ARTICLE" | "CATEGORY_NORMALIZATION_NEEDED" | "MISSING_RELEVANCE_METADATA" | "POSSIBLE_OUT_OF_DOMAIN_ARTICLE" | "SUSPICIOUS_RELEVANCE_RELATIONSHIP" | "STALE_RELEVANCE_RELATIONSHIP";
  severity: "INFO" | "WARNING";
  articleIds: string[];
  suggestedAction: string;
  metadata?: { relatedServiceIds: string[]; relatedPolicyIds: string[] };
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
      const services = await tx.service.findMany({ where: { businessId, isActive: true, isArchived: false }, select: { id: true, name: true, category: true, description: true } });
      const policies = await tx.businessPolicy.findMany({ where: { businessId, isActive: true, isArchived: false, visibility: "CUSTOMER_FACING" }, select: { id: true, title: true, category: true, shortSummary: true } });
      const anchors = tokens([business.name, business.industry, business.description, ...services.flatMap(s => [s.name, s.category]), ...policies.flatMap(p => [p.title, p.category])].filter(Boolean).join(" "));
      const serviceWords = new Map(services.map(s => [s.id, tokens([s.name, s.category, s.description].filter(Boolean).join(" "))]));
      const policyWords = new Map(policies.map(p => [p.id, tokens([p.title, p.category, p.shortSummary].filter(Boolean).join(" "))]));
      const overlaps = (a: Set<string>, b: Set<string>) => [...a].some(w => b.has(w));
      const findings: KnowledgeQualityFinding[] = [];
      const add = (code: KnowledgeQualityFinding["code"], articleIds: string[], suggestedAction: string, metadata?: KnowledgeQualityFinding["metadata"]) => findings.push({ code, severity: code === "CATEGORY_NORMALIZATION_NEEDED" ? "INFO" : "WARNING", articleIds: [...articleIds].sort(), suggestedAction, ...(metadata ? { metadata } : {}) });
      const titleGroups = new Map<string, typeof articles>();
      const categories = new Map<string, typeof articles>();
      for (const article of articles) {
        const title = normalize(article.title); if (title) titleGroups.set(title, [...(titleGroups.get(title) ?? []), article]);
        if (article.category?.trim()) { const key = normalize(article.category); categories.set(key, [...(categories.get(key) ?? []), article]); }
        const unlinked = !article.relatedServiceIds.length && !article.relatedPolicyIds.length;
        // Support categories describe general help, not an operational service relationship.
        const genericCategory = /^(?:customer service|customer support|support|general information)$/.test(normalize(article.category ?? ""));
        const titleTags = [article.title, ...article.tags].map(normalize);
        const relevanceCues = [...titleTags, ...(genericCategory ? [] : [normalize(article.category ?? "")])];
        const namesEntity = (name: string) => normalize(name).length > 3 && relevanceCues.some(cue => ` ${cue} `.includes(` ${normalize(name)} `));
        const specific = titleTags.some(cue => /\b(?:payments?|deposits?|refunds?|cancellations?|pricing|fees|appointments?)\b/.test(cue))
          || services.some(s => namesEntity(s.name)) || policies.some(p => namesEntity(p.title));
        const genericCompany = /^(?:about us|about our company|company overview|business overview|welcome|company introduction|business introduction|who we are)$/.test(title)
          || ["introduction to", "about", "welcome to"].some(prefix => title === `${prefix} ${normalize(business.name)}`);
        if (unlinked && specific && !genericCompany) add("MISSING_RELEVANCE_METADATA", [article.id], "Review relevance and link existing services or policies only when supported by the article.");
        // An introductory title naming the business must not mask an unrelated body.
        const words = tokens(`${genericCompany ? "" : article.title} ${article.summary ?? ""} ${article.body}`);
        const stale = { relatedServiceIds: [] as string[], relatedPolicyIds: [] as string[] };
        const suspicious = { relatedServiceIds: [] as string[], relatedPolicyIds: [] as string[] };
        let linkedOverlap = false;
        for (const [key, catalog] of [["relatedServiceIds", serviceWords], ["relatedPolicyIds", policyWords]] as const) {
          for (const id of [...new Set(article[key])].sort()) {
            const vocabulary = catalog.get(id);
            if (!vocabulary) stale[key].push(id);
            else if (overlaps(words, vocabulary)) linkedOverlap = true;
            else if (words.size >= 8 && vocabulary.size > 0) suspicious[key].push(id);
          }
        }
        if (stale.relatedServiceIds.length || stale.relatedPolicyIds.length) add("STALE_RELEVANCE_RELATIONSHIP", [article.id], "Review these relationships: they do not resolve to current customer-facing entities in this business. No links have been removed.", stale);
        if (suspicious.relatedServiceIds.length || suspicious.relatedPolicyIds.length) add("SUSPICIOUS_RELEVANCE_RELATIONSHIP", [article.id], "Human review: the article has no meaningful lexical overlap with these linked entities. Verify the existing relationships before changing anything.", suspicious);
        if (anchors.size >= 3 && words.size >= 8 && !linkedOverlap && !overlaps(words, anchors)) add("POSSIBLE_OUT_OF_DOMAIN_ARTICLE", [article.id], unlinked
          ? "Human review: verify relevance to this business. Lexical mismatch is not proof of inappropriate content."
          : "Human review: verify relevance to this business and review the existing relationships themselves. Links do not prove relevance and have not been changed.");
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
