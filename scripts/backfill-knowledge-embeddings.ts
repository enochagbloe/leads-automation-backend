import { knowledgeEmbeddingService } from "../src/services/knowledge-embedding.service";
import { prisma } from "../src/config/prisma";

// Explicit operator command: one bounded page, one business. Never imported by startup.
async function main() {
  const [businessId, kind, afterId, size] = process.argv.slice(2);
  if (!businessId || (kind !== "ARTICLE" && kind !== "DOCUMENT")) throw new Error("Usage: pnpm exec tsx scripts/backfill-knowledge-embeddings.ts <businessId> <ARTICLE|DOCUMENT> [afterId] [pageSize=10]");
  const result = await knowledgeEmbeddingService.backfill(businessId, { kind, afterId, limit: size ? Number(size) : 10 });
  console.log(JSON.stringify(result, null, 2));
  if (result.results.some(row => row.status === "FAILED")) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Backfill failed"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
