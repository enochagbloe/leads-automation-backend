import { z } from "zod";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { demoFactsSchema } from "./demo-extraction.service";
import type { DemoActor } from "./demo.service";

export const demoContextSchema = z.object({
  businessName: z.string().max(120),
  facts: demoFactsSchema,
  sourceWebsite: z.string().max(2048).nullable(),
  crawlStatus: z.enum(["NOT_STARTED", "PROCESSING", "COMPLETE", "PARTIAL", "FAILED"]),
  extractionStatus: z.enum(["COMPLETE", "FALLBACK"]),
  startedAt: z.string(), completedAt: z.string().nullable(),
  pagesAttempted: z.number().int().min(0).max(5), pagesFetched: z.number().int().min(0).max(5),
  errorCode: z.string().max(80).nullable(),
  sources: z.array(z.object({ url: z.string().max(2048), title: z.string().max(200), description: z.string().max(500) }).strict()).max(5),
  bookingLinks: z.array(z.string().max(2048)).max(5), contactLinks: z.array(z.string().max(2048)).max(5),
  unknowns: z.array(z.string().max(100)).max(12),
}).strict();
export type DemoContext = z.infer<typeof demoContextSchema>;
export function demoContextSummary(value: unknown) {
  const parsed = demoContextSchema.safeParse(value);
  if (!parsed.success) return { website: null, summary: { servicesFound: 0, hoursFound: false, contactFound: false, pricingFound: false } };
  const context = parsed.data;
  return {
    website: { url: context.sourceWebsite, crawlStatus: context.crawlStatus, pagesAttempted: context.pagesAttempted, pagesFetched: context.pagesFetched, startedAt: context.startedAt, completedAt: context.completedAt, errorCode: context.errorCode },
    summary: { servicesFound: context.facts.services.length, hoursFound: context.facts.openingHours.length > 0, contactFound: Object.values(context.facts.contacts).some(Boolean), pricingFound: context.facts.services.some(service => service.price !== null) },
  };
}
export const demoContextService = {
  // Internal adapter: actor scope comes only from authenticateDemo, never a body business ID.
  async getBusinessContext(actor: DemoActor) {
    const session = await prisma.demoSession.findFirst({ where: { id: actor.demoSessionId, status: "ACTIVE", expiresAt: { gt: new Date() }, business: { id: actor.businessId, demoSessionId: actor.demoSessionId } }, select: { demoContext: true, setupStatus: true } });
    if (!session) throw new AppError(403, "Demo resource forbidden", "DEMO_RESOURCE_FORBIDDEN");
    if (!["READY", "READY_PARTIAL"].includes(session.setupStatus)) throw new AppError(409, "Demo setup is not ready", "DEMO_SETUP_NOT_READY");
    return demoContextSchema.parse(session.demoContext);
  },
};
