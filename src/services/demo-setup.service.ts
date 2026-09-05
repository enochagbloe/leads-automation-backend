import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { DemoActor, assertDemoEnabled, demoService } from "./demo.service";
import { DemoContext, demoContextSchema } from "./demo-context.service";
import { demoCrawlerService } from "./demo-crawler.service";
import { demoExtractionService, emptyDemoFacts } from "./demo-extraction.service";
import { normalizeDemoUrl } from "./demo-url.service";

const inputSchema = z.object({ businessName: z.string().trim().min(1).max(120).refine(value => !/[<>\x00-\x1f\x7f]/.test(value)), websiteUrl: z.string().trim().max(2048).optional() }).strict();
export function parseDemoSetup(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, "Invalid demo setup input", "DEMO_SETUP_INVALID");
  return { businessName: parsed.data.businessName, websiteUrl: parsed.data.websiteUrl ? normalizeDemoUrl(parsed.data.websiteUrl).href : null };
}
export const demoSetupService = {
  async recoverStalled() {
    const cutoff = new Date(Date.now() - 60_000);
    const stalled = await prisma.demoSession.findMany({ where: { status: "ACTIVE", setupStatus: "PROCESSING_WEBSITE", setupStartedAt: { lt: cutoff } }, select: { id: true, setupAttemptId: true, demoContext: true }, take: 100 });
    for (const session of stalled) {
      const parsed = demoContextSchema.safeParse(session.demoContext);
      await prisma.demoSession.updateMany({ where: { id: session.id, status: "ACTIVE", setupStatus: "PROCESSING_WEBSITE", setupAttemptId: session.setupAttemptId, setupStartedAt: { lt: cutoff } }, data: { setupStatus: "READY_PARTIAL", setupCompletedAt: new Date(), demoContext: parsed.success ? { ...parsed.data, crawlStatus: "FAILED", errorCode: "DEMO_SETUP_INTERRUPTED", completedAt: new Date().toISOString() } : Prisma.DbNull } });
    }
  },
  async setup(actor: DemoActor, input: unknown) {
    assertDemoEnabled();
    const data = parseDemoSetup(input);
    const now = new Date(); const attemptId = randomUUID();
    let context: DemoContext = { businessName: data.businessName, facts: emptyDemoFacts(), sourceWebsite: data.websiteUrl, crawlStatus: data.websiteUrl ? "PROCESSING" : "NOT_STARTED", extractionStatus: "FALLBACK", startedAt: now.toISOString(), completedAt: null, pagesAttempted: 0, pagesFetched: 0, errorCode: null, sources: [], bookingLinks: [], contactLinks: [], unknowns: [] };
    const scope = { id: actor.demoSessionId, status: "ACTIVE" as const, expiresAt: { gt: now }, business: { id: actor.businessId, demoSessionId: actor.demoSessionId } };
    await prisma.$transaction(async tx => {
      const claimed = await tx.demoSession.updateMany({ where: { ...scope, OR: [{ setupStatus: { not: "PROCESSING_WEBSITE" } }, { setupStartedAt: { lt: new Date(now.getTime() - 60_000) } }] }, data: { setupStatus: "PROCESSING_WEBSITE", setupAttemptId: attemptId, setupStartedAt: now, setupCompletedAt: null, demoContext: context as Prisma.InputJsonValue } });
      if (!claimed.count) {
        if (!await tx.demoSession.findFirst({ where: scope, select: { id: true } })) throw new AppError(403, "Demo resource forbidden", "DEMO_RESOURCE_FORBIDDEN");
        throw new AppError(409, "Demo setup is already in progress", "DEMO_SETUP_IN_PROGRESS");
      }
      // Clear previous website-derived business fields as soon as a replacement starts.
      await tx.business.update({ where: { id: actor.businessId, demoSessionId: actor.demoSessionId }, data: { name: data.businessName, website: data.websiteUrl, industry: "Unspecified", description: null } });
    });
    if (data.websiteUrl) {
      try {
        const crawl = await demoCrawlerService.crawl(data.websiteUrl);
        const extracted = await demoExtractionService.extract(actor.businessId, actor.demoSessionId, crawl, AbortSignal.timeout(10_000));
        const links = [...new Set(crawl.pages.flatMap(page => page.links.map(link => link.url)))];
        context = { ...context, facts: extracted.facts, extractionStatus: extracted.extractionStatus, crawlStatus: crawl.crawlStatus, completedAt: crawl.completedAt, pagesAttempted: crawl.pagesAttempted, pagesFetched: crawl.pagesFetched, errorCode: crawl.errorCode, sources: crawl.pages.map(({ url, title, description }) => ({ url, title, description })), bookingLinks: links.filter(link => /booking|appointment/i.test(new URL(link).pathname)).slice(0, 5), contactLinks: links.filter(link => /contact/i.test(new URL(link).pathname)).slice(0, 5) };
      } catch { context = { ...context, crawlStatus: "FAILED", errorCode: "DEMO_WEBSITE_FETCH_FAILED" }; }
    }
    context.completedAt = new Date().toISOString();
    const facts = context.facts;
    context.unknowns = [!facts.industry && "industry", !facts.services.length && "services", !facts.services.some(service => service.price) && "pricing", !facts.services.some(service => service.duration) && "service durations", !facts.openingHours.length && "opening hours", !Object.values(facts.contacts).some(Boolean) && "contact details", !facts.locations.length && "locations", !facts.policies.length && "policies", "live availability"].filter((value): value is string => Boolean(value));
    context = demoContextSchema.parse(context);
    if (JSON.stringify(context).length > 40_000) {
      context = { ...context, facts: emptyDemoFacts(), extractionStatus: "FALLBACK", sources: context.sources.slice(0, 1), bookingLinks: [], contactLinks: [], errorCode: "DEMO_CONTEXT_TOO_LARGE", unknowns: ["website facts"] };
    }
    const ready = context.crawlStatus === "COMPLETE" && context.extractionStatus === "COMPLETE" && (facts.services.length > 0 || Boolean(facts.description));
    await prisma.$transaction(async tx => {
      // Re-check scope, expiry and attempt ownership after all external work. Never resurrect a destroyed session.
      const saved = await tx.demoSession.updateMany({ where: { ...scope, expiresAt: { gt: new Date() }, setupStatus: "PROCESSING_WEBSITE", setupAttemptId: attemptId }, data: { setupStatus: ready ? "READY" : "READY_PARTIAL", setupCompletedAt: new Date(), demoContext: context as Prisma.InputJsonValue } });
      if (!saved.count) throw new AppError(409, "Demo setup is no longer current", "DEMO_SETUP_STALE");
      await tx.business.update({ where: { id: actor.businessId, demoSessionId: actor.demoSessionId }, data: { name: data.businessName, website: data.websiteUrl, industry: context.facts.industry ?? "Unspecified", description: context.facts.description } });
    });
    console.info("Demo setup completed", { isDemo: true, demoSessionId: actor.demoSessionId, hostname: data.websiteUrl ? new URL(data.websiteUrl).hostname : null, crawlStatus: context.crawlStatus, pagesFetched: context.pagesFetched, durationMs: Date.now() - now.getTime() });
    return demoService.get(actor);
  },
};
