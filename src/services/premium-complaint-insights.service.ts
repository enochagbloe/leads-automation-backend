import {
  BusinessNotificationEntityType,
  BusinessNotificationPriority,
  BusinessNotificationType,
  BusinessRole,
  CustomerIssueCategory,
  CustomerIssueSeverity,
  CustomerIssueStatus,
  MembershipStatus,
  PlanCode,
  Prisma,
} from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { ComplaintInsightQuery, GenerateComplaintInsightInput } from "../validation/customer-issue.schemas";
import { aiProvider } from "./ai-provider.service";
import { cacheService } from "./cache.service";
import { CustomerIssueActor } from "./customer-issue.service";
import { notificationService } from "./notification.service";
import { subscriptionService } from "./subscription.service";

type InsightTimeframe = "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY";

type AiComplaintInsight = {
  aiSummary: string;
  rootCauses: Array<{ title: string; explanation: string; evidence?: string; impact?: string }>;
  trends: Array<{ title: string; direction: "INCREASING" | "DECREASING" | "STABLE" | "NEW" | "RECURRING"; explanation: string; evidence?: string }>;
  recommendations: Array<{ title: string; recommendation: string; priority: "LOW" | "MEDIUM" | "HIGH"; expectedImpact?: string }>;
  recurringIssues: Array<{ type: "CATEGORY" | "STAFF" | "CUSTOMER" | "SERVICE" | "OTHER"; title: string; explanation: string; count?: number }>;
  predictiveAlerts: Array<{ title: string; message: string; severity: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; category?: string }>;
  executiveSummary: {
    headline: string;
    bullets: string[];
  };
  businessMemory: Array<{ lesson: string; evidence: string; recommendedFutureUse: string }>;
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function assertManager(actor: CustomerIssueActor) {
  if (actor.role !== BusinessRole.BUSINESS_OWNER && actor.role !== BusinessRole.MANAGER) {
    throw new AppError(403, "Only an owner or manager can access Premium complaint insights.", "FORBIDDEN");
  }
}

async function assertPremium(actor: CustomerIssueActor) {
  const subscription = await subscriptionService.getCurrentRecord(actor.businessAccountId);
  if (subscription.plan.code !== PlanCode.PREMIUM) {
    throw new AppError(403, "Upgrade to Premium to access AI complaint analytics and operational insights.", "PLAN_UPGRADE_REQUIRED", {
      currentPlan: subscription.plan.code,
      recommendedPlan: PlanCode.PREMIUM,
      featureKey: "premiumComplaintInsights",
    });
  }
  return subscription;
}

function startOfDay(date: Date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function addDays(date: Date, days: number) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function defaultPeriod(timeframe: InsightTimeframe, now = new Date()) {
  const end = now;
  if (timeframe === "DAILY") return { periodStart: startOfDay(now), periodEnd: end };
  if (timeframe === "WEEKLY") return { periodStart: addDays(startOfDay(now), -7), periodEnd: end };
  if (timeframe === "QUARTERLY") return { periodStart: addDays(startOfDay(now), -90), periodEnd: end };
  return { periodStart: addDays(startOfDay(now), -30), periodEnd: end };
}

function resolvePeriod(input: { timeframe: InsightTimeframe; periodStart?: Date; periodEnd?: Date }) {
  const fallback = defaultPeriod(input.timeframe);
  const periodStart = input.periodStart ?? fallback.periodStart;
  const periodEnd = input.periodEnd ?? fallback.periodEnd;
  if (periodStart >= periodEnd) {
    throw new AppError(422, "periodStart must be before periodEnd.", "VALIDATION_ERROR");
  }
  return { periodStart, periodEnd };
}

function resolutionDurationMs(issue: { createdAt: Date; resolvedAt: Date | null }) {
  return issue.resolvedAt ? Math.max(0, issue.resolvedAt.getTime() - issue.createdAt.getTime()) : null;
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percent(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function countBy<T extends string>(values: T[]) {
  const result = new Map<T, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return Array.from(result.entries()).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

function labelFor(labels: Map<string, string>, key: string | null | undefined, prefix: "Customer" | "Staff") {
  const safeKey = key?.trim() || "unknown";
  const existing = labels.get(safeKey);
  if (existing) return existing;
  const label = `${prefix} #${labels.size + 1}`;
  labels.set(safeKey, label);
  return label;
}

function redactPersonalIdentifiers(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, "[phone redacted]")
    .trim();
}

function safeArray<T>(value: unknown, fallback: T[] = []) {
  return Array.isArray(value) ? value as T[] : fallback;
}

function safeString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseAiInsight(rawText: string, fallback: AiComplaintInsight): AiComplaintInsight {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const executive = parsed.executiveSummary && typeof parsed.executiveSummary === "object" && !Array.isArray(parsed.executiveSummary)
      ? parsed.executiveSummary as Record<string, unknown>
      : {};
    return {
      aiSummary: safeString(parsed.aiSummary, fallback.aiSummary),
      rootCauses: safeArray(parsed.rootCauses, fallback.rootCauses).slice(0, 8),
      trends: safeArray(parsed.trends, fallback.trends).slice(0, 8),
      recommendations: safeArray(parsed.recommendations, fallback.recommendations).slice(0, 8),
      recurringIssues: safeArray(parsed.recurringIssues, fallback.recurringIssues).slice(0, 10),
      predictiveAlerts: safeArray(parsed.predictiveAlerts, fallback.predictiveAlerts).slice(0, 5),
      executiveSummary: {
        headline: safeString(executive.headline, fallback.executiveSummary.headline),
        bullets: safeArray<string>(executive.bullets, fallback.executiveSummary.bullets).slice(0, 8),
      },
      businessMemory: safeArray(parsed.businessMemory, fallback.businessMemory).slice(0, 10),
    };
  } catch {
    return fallback;
  }
}

function deterministicInsight(input: {
  timeframe: InsightTimeframe;
  total: number;
  previousTotal: number;
  byCategory: Array<{ key: CustomerIssueCategory; count: number }>;
  bySeverity: Array<{ key: CustomerIssueSeverity; count: number }>;
  recurringStaff: Array<{ staffName: string; count: number }>;
  recurringCustomers: Array<{ customerName: string; count: number }>;
  averageResolutionTimeMs: number | null;
}): AiComplaintInsight {
  const topCategory = input.byCategory[0];
  const topSeverity = input.bySeverity[0];
  const delta = input.total - input.previousTotal;
  const direction = delta > 0 ? "increased" : delta < 0 ? "decreased" : "remained stable";
  const categoryText = topCategory ? `${topCategory.key} (${percent(topCategory.count, input.total)}%)` : "no dominant category";
  const staffIssue = input.recurringStaff[0];
  const customerIssue = input.recurringCustomers[0];
  return {
    aiSummary: `Complaint volume ${direction} for this ${input.timeframe.toLowerCase()} period. The most common complaint area was ${categoryText}.`,
    rootCauses: topCategory ? [{
      title: `${topCategory.key} complaints are the main operational signal`,
      explanation: `${topCategory.count} complaint(s) were categorized as ${topCategory.key}. Review the related workflow and handoff points before the next operating cycle.`,
      evidence: `${percent(topCategory.count, input.total)}% of complaints in this period.`,
    }] : [],
    trends: [{
      title: "Complaint volume trend",
      direction: delta > 0 ? "INCREASING" : delta < 0 ? "DECREASING" : "STABLE",
      explanation: `This period had ${input.total} complaint(s), compared with ${input.previousTotal} in the previous comparable period.`,
    }],
    recommendations: topCategory ? [{
      title: `Reduce ${topCategory.key} complaints`,
      recommendation: `Review the process that creates ${topCategory.key.toLowerCase().replace(/_/g, " ")} complaints and assign a manager to track improvement next period.`,
      priority: topSeverity?.key === CustomerIssueSeverity.URGENT || topSeverity?.key === CustomerIssueSeverity.HIGH ? "HIGH" : "MEDIUM",
      expectedImpact: "Lower repeat complaints and faster resolution.",
    }] : [],
    recurringIssues: [
      ...(staffIssue ? [{ type: "STAFF" as const, title: "Repeated staff assignment signal", explanation: `${staffIssue.staffName} has ${staffIssue.count} assigned complaint(s). Review workload and support needs.`, count: staffIssue.count }] : []),
      ...(customerIssue ? [{ type: "CUSTOMER" as const, title: "Repeated customer issue signal", explanation: `${customerIssue.customerName} has ${customerIssue.count} complaint(s). Review their account history for unresolved expectations.`, count: customerIssue.count }] : []),
      ...(topCategory ? [{ type: "CATEGORY" as const, title: `Recurring ${topCategory.key} complaints`, explanation: `${topCategory.key} appears repeatedly in this period.`, count: topCategory.count }] : []),
    ],
    predictiveAlerts: delta > 0 && input.total >= 3 ? [{
      title: "Complaint volume is increasing",
      message: `Complaint volume increased by ${delta} compared with the previous comparable period.`,
      severity: delta >= 5 ? "HIGH" : "MEDIUM",
      category: topCategory?.key,
    }] : [],
    executiveSummary: {
      headline: `Complaint volume ${direction}`,
      bullets: [
        `Total complaints: ${input.total}`,
        `Top category: ${topCategory?.key ?? "none"}`,
        `Average resolution time: ${input.averageResolutionTimeMs === null ? "not enough resolved complaints" : `${Math.round(input.averageResolutionTimeMs / 3_600_000)} hours`}`,
      ],
    },
    businessMemory: topCategory ? [{
      lesson: `${topCategory.key} complaints should be reviewed in operational planning.`,
      evidence: `${topCategory.count} complaint(s) in this period.`,
      recommendedFutureUse: "Surface this lesson in business reviews and AI assistant recommendations.",
    }] : [],
  };
}

function insightSystemPrompt() {
  return [
    "You are BizReply AI's Premium complaint intelligence analyst.",
    "Use only the complaint history and metrics provided by the backend.",
    "Do not invent facts, customers, staff names, services, percentages, or policies.",
    "Complaint samples use privacy-safe labels such as Customer #1 and Staff #1. Do not try to infer personal identities.",
    "Write business-readable operational insights, not raw database narration.",
    "Do not blame staff. Frame recurring staff signals as workload, training, or process review opportunities.",
    "Return JSON only.",
  ].join("\n");
}

function insightUserPrompt(input: {
  businessName: string;
  timeframe: InsightTimeframe;
  periodStart: Date;
  periodEnd: Date;
  metrics: Record<string, unknown>;
  complaints: Array<Record<string, unknown>>;
  previousReports: Array<{ aiSummary: string; businessMemory: Prisma.JsonValue }>;
}) {
  return JSON.stringify({
    task: "Generate Premium complaint analytics and operational recommendations.",
    businessName: input.businessName,
    timeframe: input.timeframe,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    metrics: input.metrics,
    complaintSamples: input.complaints.slice(0, 60),
    previousBusinessMemory: input.previousReports.slice(0, 3),
    requiredJsonShape: {
      aiSummary: "string",
      rootCauses: [{ title: "string", explanation: "string", evidence: "string", impact: "string" }],
      trends: [{ title: "string", direction: "INCREASING|DECREASING|STABLE|NEW|RECURRING", explanation: "string", evidence: "string" }],
      recommendations: [{ title: "string", recommendation: "string", priority: "LOW|MEDIUM|HIGH", expectedImpact: "string" }],
      recurringIssues: [{ type: "CATEGORY|STAFF|CUSTOMER|SERVICE|OTHER", title: "string", explanation: "string", count: 0 }],
      predictiveAlerts: [{ title: "string", message: "string", severity: "LOW|MEDIUM|HIGH|URGENT", category: "string" }],
      executiveSummary: { headline: "string", bullets: ["string"] },
      businessMemory: [{ lesson: "string", evidence: "string", recommendedFutureUse: "string" }],
    },
  });
}

async function managerRecipients(businessId: string) {
  return prisma.businessMember.findMany({
    where: {
      businessId,
      status: MembershipStatus.ACTIVE,
      role: { in: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER] },
    },
    select: { id: true },
  });
}

async function notifyPredictiveAlerts(input: {
  businessId: string;
  businessAccountId: string;
  reportId: string;
  alerts: AiComplaintInsight["predictiveAlerts"];
}) {
  if (input.alerts.length === 0) return;
  const managers = await managerRecipients(input.businessId);
  const primary = input.alerts[0]!;
  await notificationService.createNotificationsForRecipients({
    businessId: input.businessId,
    businessAccountId: input.businessAccountId,
    recipientMembershipIds: managers.map((member) => member.id),
    type: BusinessNotificationType.INFO,
    priority: primary.severity === "URGENT" ? BusinessNotificationPriority.URGENT : primary.severity === "HIGH" ? BusinessNotificationPriority.HIGH : BusinessNotificationPriority.NORMAL,
    title: "Premium complaint trend alert",
    message: primary.message,
    entityType: BusinessNotificationEntityType.BUSINESS,
    entityId: input.businessId,
    actions: [{ label: "View complaint insights", action: "VIEW_COMPLAINT_INSIGHTS", variant: "default" }],
    metadata: { reportId: input.reportId, alerts: input.alerts },
  });
}

export const premiumComplaintInsightsService = {
  async list(actor: CustomerIssueActor, query: ComplaintInsightQuery) {
    assertManager(actor);
    await assertPremium(actor);
    const period = resolvePeriod({ timeframe: query.timeframe, periodStart: query.periodStart, periodEnd: query.periodEnd });
    const reports = await prisma.complaintInsightReport.findMany({
      where: {
        businessId: actor.businessId,
        timeframe: query.timeframe,
        periodStart: { gte: period.periodStart },
        periodEnd: { lte: period.periodEnd },
      },
      orderBy: { generatedAt: "desc" },
      take: 20,
    });
    return { reports };
  },

  async latest(actor: CustomerIssueActor, query: ComplaintInsightQuery) {
    assertManager(actor);
    await assertPremium(actor);
    const report = await prisma.complaintInsightReport.findFirst({
      where: { businessId: actor.businessId, timeframe: query.timeframe },
      orderBy: { generatedAt: "desc" },
    });
    return { report };
  },

  async memory(actor: CustomerIssueActor) {
    assertManager(actor);
    await assertPremium(actor);
    const reports = await prisma.complaintInsightReport.findMany({
      where: { businessId: actor.businessId },
      select: { id: true, timeframe: true, generatedAt: true, businessMemory: true, aiSummary: true },
      orderBy: { generatedAt: "desc" },
      take: 10,
    });
    return {
      memory: reports.flatMap((report) => safeArray<Record<string, unknown>>(report.businessMemory).map((entry) => ({
        reportId: report.id,
        timeframe: report.timeframe,
        generatedAt: report.generatedAt,
        ...entry,
      }))),
    };
  },

  async generate(actor: CustomerIssueActor, input: GenerateComplaintInsightInput) {
    assertManager(actor);
    await assertPremium(actor);
    const { periodStart, periodEnd } = resolvePeriod(input);
    const previousStart = new Date(periodStart.getTime() - (periodEnd.getTime() - periodStart.getTime()));
    const business = await prisma.business.findFirst({
      where: { id: actor.businessId },
      select: { id: true, name: true, businessAccountId: true },
    });
    if (!business) throw new AppError(404, "Business not found.", "BUSINESS_NOT_FOUND");
    const [issues, previousIssues, previousReports] = await Promise.all([
      prisma.customerIssueLog.findMany({
        where: { businessId: actor.businessId, createdAt: { gte: periodStart, lte: periodEnd } },
        include: {
          lead: { select: { id: true } },
          responsibleMember: { select: { id: true, role: true } },
        },
        orderBy: { createdAt: "asc" },
        take: 500,
      }),
      prisma.customerIssueLog.findMany({
        where: { businessId: actor.businessId, createdAt: { gte: previousStart, lt: periodStart } },
        select: { id: true },
      }),
      prisma.complaintInsightReport.findMany({
        where: { businessId: actor.businessId },
        select: { aiSummary: true, businessMemory: true },
        orderBy: { generatedAt: "desc" },
        take: 3,
      }),
    ]);
    const byCategory = countBy(issues.map((issue) => issue.category));
    const bySeverity = countBy(issues.map((issue) => issue.severity));
    const byStatus = countBy(issues.map((issue) => issue.status));
    const customerLabels = new Map<string, string>();
    const staffLabels = new Map<string, string>();
    const staffCounts = countBy(issues.map((issue) => issue.responsibleMember ? labelFor(staffLabels, issue.responsibleMember.id, "Staff") : "Unassigned"));
    const customerCounts = countBy(issues.map((issue) => labelFor(customerLabels, issue.lead?.id, "Customer")));
    const resolvedDurations = issues.map(resolutionDurationMs).filter((value): value is number => value !== null);
    const averageResolutionTimeMs = average(resolvedDurations);
    const openStatuses = new Set<CustomerIssueStatus>([CustomerIssueStatus.OPEN, CustomerIssueStatus.ACKNOWLEDGED, CustomerIssueStatus.REOPENED]);
    const metrics = {
      totalComplaints: issues.length,
      openComplaints: issues.filter((issue) => openStatuses.has(issue.status)).length,
      resolvedComplaints: issues.filter((issue) => issue.status === CustomerIssueStatus.RESOLVED).length,
      reopenedComplaints: issues.filter((issue) => issue.status === CustomerIssueStatus.REOPENED || issue.reopenCount > 0).length,
      criticalComplaints: issues.filter((issue) => issue.severity === CustomerIssueSeverity.URGENT).length,
      averageResolutionTimeMs,
      previousTotalComplaints: previousIssues.length,
      byCategory,
      bySeverity,
      byStatus,
      staffCounts,
      customerCounts,
    };
    const fallback = deterministicInsight({
      timeframe: input.timeframe,
      total: issues.length,
      previousTotal: previousIssues.length,
      byCategory,
      bySeverity,
      recurringStaff: staffCounts.filter((item) => item.count > 1).map((item) => ({ staffName: item.key, count: item.count })),
      recurringCustomers: customerCounts.filter((item) => item.count > 1).map((item) => ({ customerName: item.key, count: item.count })),
      averageResolutionTimeMs,
    });
    const samples = issues.map((issue) => ({
      id: issue.id,
      category: issue.category,
      severity: issue.severity,
      status: issue.status,
      summary: redactPersonalIdentifiers(issue.summary),
      customerMessageExcerpt: redactPersonalIdentifiers(issue.customerMessageExcerpt),
      responsibleStaff: issue.responsibleMember ? labelFor(staffLabels, issue.responsibleMember.id, "Staff") : null,
      responsibleStaffRole: issue.responsibleMember?.role ?? null,
      customer: labelFor(customerLabels, issue.lead?.id, "Customer"),
      repeatCustomerSignals: customerCounts.filter((item) => item.count > 1),
      createdAt: issue.createdAt.toISOString(),
      resolvedAt: issue.resolvedAt?.toISOString() ?? null,
      resolutionDurationMs: resolutionDurationMs(issue),
    }));
    let ai = fallback;
    let provider: string | undefined;
    let model: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;
    if (issues.length > 0) {
      const result = await aiProvider.generateCompletion({
        businessId: actor.businessId,
        systemPrompt: insightSystemPrompt(),
        userPrompt: insightUserPrompt({
          businessName: business.name,
          timeframe: input.timeframe,
          periodStart,
          periodEnd,
          metrics,
          complaints: samples,
          previousReports,
        }),
        responseFormat: { type: "json_object" },
        temperature: 0.2,
        maxTokens: 1400,
        metadata: { source: "PREMIUM_COMPLAINT_INSIGHTS", timeframe: input.timeframe },
      });
      ai = parseAiInsight(result.rawText, fallback);
      provider = result.provider;
      model = result.finalModelUsed;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      totalTokens = result.totalTokens;
    }
    const reportData = {
      totalComplaints: issues.length,
      openComplaints: metrics.openComplaints,
      resolvedComplaints: metrics.resolvedComplaints,
      reopenedComplaints: metrics.reopenedComplaints,
      criticalComplaints: metrics.criticalComplaints,
      averageResolutionTimeMs,
      aiSummary: ai.aiSummary,
      rootCauses: json(ai.rootCauses),
      trends: json(ai.trends),
      recommendations: json(ai.recommendations),
      recurringIssues: json(ai.recurringIssues),
      predictiveAlerts: json(ai.predictiveAlerts),
      executiveSummary: json(ai.executiveSummary),
      businessMemory: json(ai.businessMemory),
      sourceComplaintIds: issues.map((issue) => issue.id),
      provider,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      generatedAt: new Date(),
    };
    const report = await prisma.complaintInsightReport.upsert({
      where: {
        businessId_timeframe_periodStart_periodEnd: {
          businessId: actor.businessId,
          timeframe: input.timeframe,
          periodStart,
          periodEnd,
        },
      },
      create: {
        businessId: actor.businessId,
        timeframe: input.timeframe,
        periodStart,
        periodEnd,
        ...reportData,
      },
      update: reportData,
    });
    await Promise.all([
      cacheService.delByPattern(`business:${actor.businessId}:customer-issues:*`),
      input.notifyManagers ? notifyPredictiveAlerts({
        businessId: actor.businessId,
        businessAccountId: actor.businessAccountId,
        reportId: report.id,
        alerts: ai.predictiveAlerts,
      }) : Promise.resolve(),
    ]);
    return { report };
  },
};
