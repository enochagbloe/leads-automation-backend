import crypto from "node:crypto";
import {
  AuditAction,
  BusinessRole,
  DayOfWeek,
  KnowledgeDocumentArchiveReason,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  KnowledgeFactGovernanceStatus,
  KnowledgeGovernanceCanonicalEntityType,
  KnowledgeGovernanceResolutionAction,
  KnowledgeGovernanceResolutionOperationStatus,
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { AppError } from "../../utils/errors";
import {
  CompleteKnowledgeDocumentReplacementInput,
  ResolveKnowledgeGovernanceReviewBatchInput,
  ResolveKnowledgeGovernanceReviewInput,
} from "../../validation/knowledge.schemas";
import { appointmentSettingsSchema } from "../../validation/appointment.schemas";
import { updateBusinessProfileSchema } from "../../validation/business.schemas";
import { createServiceSchema, updateServiceSchema } from "../../validation/service.schemas";
import { updateSettings as updateAppointmentSettings } from "../appointment/appointment-settings.service";
import type { AuditInput } from "../audit.service";
import { availabilityService } from "../availability.service";
import { businessProfileService } from "../business-profile.service";
import { realtimeService } from "../realtime.service";
import { serviceService } from "../service.service";
import {
  normalizeGovernanceCurrency,
  normalizeGovernanceNumber,
  normalizeGovernanceText,
} from "./knowledge-document-governance.service";
import {
  allowedKnowledgeGovernanceActions,
  classifyKnowledgeReplacementFacts,
  isKnowledgeSettingsMutation,
} from "./knowledge-governance-resolution-policy";
import {
  lockKnowledgeDocumentGovernance,
  lockKnowledgeDocumentLifecycleChange,
  lockKnowledgeGovernanceReview,
} from "./knowledge-document-governance-lock.service";
import {
  assertCanManageKnowledgeDocuments,
  KnowledgeDocumentActor,
} from "./knowledge-document.types";
import {
  enqueueKnowledgeRuntimeRefresh,
  knowledgeRuntimeRefreshService,
} from "./knowledge-runtime-refresh.service";

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

function governanceLeaseExpiresAt(now = new Date()) {
  return new Date(now.getTime() + env.KNOWLEDGE_GOVERNANCE_OPERATION_LEASE_SECONDS * 1_000);
}

type ResolutionReview = Prisma.KnowledgeGovernanceReviewGetPayload<{
  include: {
    document: { select: { id: true; status: true; activeVersionId: true; archivedAt: true } };
    version: { select: { id: true; isActive: true; governanceStatus: true } };
  };
}>;

type DomainResult = {
  canonicalEntityType: KnowledgeGovernanceCanonicalEntityType;
  canonicalEntityId: string | null;
  canonicalField: string | null;
  previousValue: unknown;
  acceptedValue: unknown;
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(reviewId: string, input: ResolveKnowledgeGovernanceReviewInput) {
  return crypto.createHash("sha256").update(stable({ reviewId, ...input })).digest("hex");
}

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function proposedFact(review: ResolutionReview) {
  return asObject(review.documentValue);
}

function staleReview(): never {
  throw new AppError(409, "This review is stale. Refresh the document comparison and try again.", "KNOWLEDGE_REVIEW_STALE");
}

function staleReplacementTarget(): never {
  throw new AppError(
    409,
    "The document being replaced has changed. Refresh the replacement comparison and try again.",
    "KNOWLEDGE_DOCUMENT_REPLACEMENT_TARGET_CHANGED",
  );
}

async function currentCanonicalValue(tx: Prisma.TransactionClient, review: ResolutionReview) {
  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.SERVICE) {
    if (!review.canonicalEntityId) return null;
    const service = await tx.service.findFirst({
      where: { id: review.canonicalEntityId, businessId: review.businessId },
      select: { id: true, name: true, basePrice: true, currency: true, durationMinutes: true, isArchived: true },
    });
    if (!service) return null;
    if (review.canonicalField === "basePrice") {
      return service.basePrice === null ? "" : `${normalizeGovernanceCurrency(service.currency)}:${normalizeGovernanceNumber(service.basePrice)}`;
    }
    if (review.canonicalField === "durationMinutes") return normalizeGovernanceNumber(service.durationMinutes);
    return normalizeGovernanceText(service.name);
  }
  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.BUSINESS_AVAILABILITY) {
    if (!review.canonicalEntityId) return null;
    const rule = await tx.businessAvailability.findFirst({
      where: { id: review.canonicalEntityId, businessId: review.businessId },
      select: { dayOfWeek: true, isOpen: true, openTime: true, closeTime: true },
    });
    return rule ? `${rule.dayOfWeek}:${rule.isOpen}:${rule.openTime}:${rule.closeTime}` : null;
  }
  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.APPROVED_KNOWLEDGE) {
    if (!review.canonicalEntityId) return null;
    const fact = await tx.knowledgeDocumentFact.findFirst({
      where: { id: review.canonicalEntityId, businessId: review.businessId, governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
      select: { valueText: true },
    });
    return fact ? normalizeGovernanceText(fact.valueText) : null;
  }
  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.BUSINESS_PROFILE) {
    const business = await tx.business.findFirst({
      where: { id: review.businessId, deletedAt: null },
      select: { email: true, phone: true, website: true, defaultNotificationEmail: true, address: true, city: true, serviceArea: true },
    });
    if (!business || !review.canonicalField || !(review.canonicalField in business)) return null;
    return normalizeGovernanceText(String(business[review.canonicalField as keyof typeof business] ?? ""));
  }
  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.APPOINTMENT_SETTINGS) {
    const business = await tx.business.findFirst({
      where: { id: review.businessId, deletedAt: null },
      select: { appointmentConfirmationMode: true },
    });
    return business?.appointmentConfirmationMode ?? null;
  }
  return null;
}

function snapshotCanonicalValue(review: ResolutionReview) {
  if (review.normalizedExistingValue !== null) return review.normalizedExistingValue;
  const existing = review.existingValue;
  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.BUSINESS_PROFILE && review.canonicalField && Array.isArray(existing)) {
    const match = existing.find((entry) => {
      const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
      return value.field === review.canonicalField;
    }) as Record<string, unknown> | undefined;
    return match?.value == null ? null : normalizeGovernanceText(String(match.value));
  }
  return null;
}

function assertCanonicalValueUnchanged(review: ResolutionReview, current: string | null) {
  const expected = snapshotCanonicalValue(review);
  if (expected === null || current !== expected) staleReview();
}

function normalizedServiceValue(
  review: ResolutionReview,
  service: { name: string; basePrice: Prisma.Decimal | null; currency: string; durationMinutes: number | null },
) {
  if (review.canonicalField === "basePrice") {
    return service.basePrice === null ? "" : `${normalizeGovernanceCurrency(service.currency)}:${normalizeGovernanceNumber(service.basePrice)}`;
  }
  if (review.canonicalField === "durationMinutes") return normalizeGovernanceNumber(service.durationMinutes);
  return normalizeGovernanceText(service.name);
}

async function loadReview(tx: Prisma.TransactionClient, businessId: string, reviewId: string) {
  return tx.knowledgeGovernanceReview.findFirst({
    where: { id: reviewId, businessId },
    include: {
      document: { select: { id: true, status: true, activeVersionId: true, archivedAt: true } },
      version: { select: { id: true, isActive: true, governanceStatus: true } },
    },
  });
}

async function claim(
  actor: KnowledgeDocumentActor,
  reviewId: string,
  input: ResolveKnowledgeGovernanceReviewInput,
  idempotencyKey: string,
) {
  const hash = requestHash(reviewId, input);
  const leaseOwner = crypto.randomUUID();
  return prisma.$transaction(async (tx) => {
    const initialReview = await loadReview(tx, actor.businessId, reviewId);
    if (!initialReview) throw new AppError(404, "Knowledge review item not found.", "KNOWLEDGE_REVIEW_NOT_FOUND");
    await lockKnowledgeDocumentGovernance(tx, initialReview.documentId);
    await lockKnowledgeGovernanceReview(tx, reviewId);
    const existingOperation = await tx.knowledgeGovernanceResolutionOperation.findUnique({
      where: { businessId_idempotencyKey: { businessId: actor.businessId, idempotencyKey } },
    });
    if (existingOperation) {
      if (existingOperation.requestHash !== hash || existingOperation.reviewId !== reviewId) {
        throw new AppError(409, "This idempotency key was already used for another decision.", "KNOWLEDGE_REVIEW_IDEMPOTENCY_CONFLICT");
      }
      if (existingOperation.status === KnowledgeGovernanceResolutionOperationStatus.COMPLETED) {
        return { duplicate: true as const, snapshot: existingOperation.resultSnapshot };
      }
      if (existingOperation.status === KnowledgeGovernanceResolutionOperationStatus.APPLYING) {
        const leaseActive = existingOperation.leaseExpiresAt && existingOperation.leaseExpiresAt > new Date();
        throw new AppError(
          409,
          leaseActive
            ? "This governance decision is already being applied."
            : "This governance decision is awaiting automatic recovery.",
          leaseActive
            ? "KNOWLEDGE_REVIEW_OPERATION_IN_PROGRESS"
            : "KNOWLEDGE_REVIEW_OPERATION_RECOVERY_PENDING",
          { retryable: true },
        );
      }
    }

    const review = await loadReview(tx, actor.businessId, reviewId);
    if (!review) throw new AppError(404, "Knowledge review item not found.", "KNOWLEDGE_REVIEW_NOT_FOUND");
    if (review.documentId !== initialReview.documentId) staleReview();
    if (review.versionId !== input.expectedVersionId
      || review.document.activeVersionId !== input.expectedVersionId
      || !review.version.isActive
      || review.document.status !== KnowledgeDocumentStatus.ACTIVE
      || review.document.archivedAt) staleReview();

    const allowed = allowedKnowledgeGovernanceActions(review);
    if (!allowed.includes(input.action)) {
      throw new AppError(422, "This action is not valid for the selected review item.", "KNOWLEDGE_REVIEW_ACTION_NOT_ALLOWED", { allowedActions: allowed });
    }
    if (review.reviewStatus !== KnowledgeGovernanceReviewStatus.PENDING_REVIEW) {
      throw new AppError(409, "This review item has already changed.", "KNOWLEDGE_REVIEW_STATE_CHANGED");
    }

    if (input.expectedCanonicalValue !== undefined && stable(input.expectedCanonicalValue) !== stable(review.existingValue)) staleReview();
    const comparedCanonicalValue = snapshotCanonicalValue(review);
    if (comparedCanonicalValue !== null) {
      const current = await currentCanonicalValue(tx, review);
      if (current !== comparedCanonicalValue) staleReview();
    }

    const changed = await tx.knowledgeGovernanceReview.updateMany({
      where: { id: reviewId, businessId: actor.businessId, reviewStatus: KnowledgeGovernanceReviewStatus.PENDING_REVIEW },
      data: { reviewStatus: KnowledgeGovernanceReviewStatus.APPLYING },
    });
    if (changed.count !== 1) throw new AppError(409, "This review item has already changed.", "KNOWLEDGE_REVIEW_STATE_CHANGED");
    const processingStartedAt = new Date();
    const operation = existingOperation
      ? await tx.knowledgeGovernanceResolutionOperation.update({
        where: { id: existingOperation.id },
        data: {
          status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
          requestInput: json(input),
          resultSnapshot: Prisma.DbNull,
          processingStartedAt,
          leaseOwner,
          leaseExpiresAt: governanceLeaseExpiresAt(processingStartedAt),
          attemptCount: { increment: 1 },
          completedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      })
      : await tx.knowledgeGovernanceResolutionOperation.create({
        data: {
          businessId: actor.businessId,
          reviewId,
          actorMembershipId: actor.membershipId,
          idempotencyKey,
          requestHash: hash,
          action: input.action,
          expectedVersionId: input.expectedVersionId,
          settingsInput: input.settingsInput ? json(input.settingsInput) : undefined,
          requestInput: json(input),
          processingStartedAt,
          leaseOwner,
          leaseExpiresAt: governanceLeaseExpiresAt(processingStartedAt),
          attemptCount: 1,
        },
      });
    return { duplicate: false as const, operation, review, checkpoint: null as DomainResult | null, leaseOwner };
  }, TRANSACTION_OPTIONS);
}

async function checkpointDomainResult(operationId: string, businessId: string, leaseOwner: string, domain: DomainResult) {
  const changed = await prisma.knowledgeGovernanceResolutionOperation.updateMany({
    where: {
      id: operationId,
      businessId,
      status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
      leaseOwner,
    },
    data: {
      resultSnapshot: json({ phase: "DOMAIN_APPLIED", domain }),
      leaseExpiresAt: governanceLeaseExpiresAt(),
    },
  });
  if (changed.count !== 1) {
    throw new AppError(409, "The review operation changed before it could be finalized.", "KNOWLEDGE_REVIEW_STATE_CHANGED");
  }
}

function sourceValue(review: ResolutionReview, field: string) {
  const proposed = proposedFact(review);
  if (field === "basePrice") return proposed.numericValue;
  if (field === "durationMinutes") return proposed.numericValue;
  if (field === "name") return proposed.valueText;
  return proposed[field] ?? proposed.valueText;
}

function profileSourceValue(review: ResolutionReview, field: string) {
  const text = String(proposedFact(review).valueText ?? "").trim();
  if (field === "email" || field === "defaultNotificationEmail") {
    return text.match(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i)?.[0] ?? text;
  }
  if (field === "website") return text.match(/https?:\/\/[^\s]+/i)?.[0] ?? text;
  if (field === "phone") return text.match(/\+?[0-9][0-9\s().-]{5,}[0-9]/)?.[0]?.trim() ?? text;
  return text;
}

function governanceServiceInput(review: ResolutionReview, input: ResolveKnowledgeGovernanceReviewInput) {
  const proposed = proposedFact(review);
  const settings = input.settingsInput ?? {};
  return createServiceSchema.parse({
    name: settings.name ?? proposed.label ?? proposed.valueText,
    ...(settings.category !== undefined ? { category: settings.category } : {}),
    ...(settings.description !== undefined ? { description: settings.description } : {}),
    ...(proposed.numericValue ? { basePrice: proposed.numericValue } : {}),
    ...(proposed.currency ? { currency: proposed.currency } : {}),
    ...(settings.durationMinutes !== undefined ? { durationMinutes: settings.durationMinutes } : {}),
  });
}

async function executeDomainAction(
  actor: KnowledgeDocumentActor,
  review: ResolutionReview,
  input: ResolveKnowledgeGovernanceReviewInput,
  operationId: string,
  context: Omit<AuditInput, "action">,
): Promise<DomainResult> {
  const base = {
    canonicalEntityType: review.canonicalEntityType,
    canonicalEntityId: review.canonicalEntityId,
    canonicalField: review.canonicalField,
    previousValue: review.existingValue,
    acceptedValue: review.documentValue,
  };
  if (!isKnowledgeSettingsMutation(input.action)) return base;

  if (input.action === KnowledgeGovernanceResolutionAction.ARCHIVE) {
    if (review.canonicalEntityType !== KnowledgeGovernanceCanonicalEntityType.SERVICE || !review.canonicalEntityId) {
      throw new AppError(422, "Only a linked service can be archived from this review.", "KNOWLEDGE_REVIEW_ACTION_NOT_ALLOWED");
    }
    const service = await serviceService.archive(actor, review.canonicalEntityId, context, {
      assertCurrent(current) {
        assertCanonicalValueUnchanged(review, normalizedServiceValue(review, current));
      },
    });
    return { ...base, acceptedValue: { serviceId: service.id, archived: true } };
  }

  if (input.action === KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS) {
    if (review.canonicalEntityType !== KnowledgeGovernanceCanonicalEntityType.SERVICE) {
      throw new AppError(422, "This knowledge item cannot create a structured setting.", "KNOWLEDGE_REVIEW_ACTION_NOT_ALLOWED");
    }
    const serviceInput = governanceServiceInput(review, input);
    const service = await serviceService.create(actor, serviceInput, context, {
      governanceResolutionOperationId: operationId,
    });
    return { ...base, canonicalEntityId: service.id, canonicalField: review.canonicalField ?? "name", acceptedValue: service };
  }

  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.SERVICE && review.canonicalEntityId && review.canonicalField) {
    const field = review.canonicalField;
    const raw = sourceValue(review, field);
    const proposed = proposedFact(review);
    const update = updateServiceSchema.parse(field === "basePrice"
      ? { basePrice: raw, ...(proposed.currency ? { currency: proposed.currency } : {}) }
      : field === "durationMinutes"
        ? { durationMinutes: Number(raw) }
        : { [field]: raw });
    const service = await serviceService.update(actor, review.canonicalEntityId, update, context, {
      assertCurrent(current) {
        assertCanonicalValueUnchanged(review, normalizedServiceValue(review, current));
      },
    });
    return { ...base, acceptedValue: { [field]: service[field as keyof typeof service] } };
  }

  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.BUSINESS_PROFILE && review.canonicalField) {
    const field = review.canonicalField;
    const raw = input.settingsInput?.[field] ?? profileSourceValue(review, field);
    const update = updateBusinessProfileSchema.parse({ [field]: raw });
    const profile = await businessProfileService.update(actor, update, context, {
      assertCurrent(current) {
        const value = current[field as keyof typeof current];
        assertCanonicalValueUnchanged(review, normalizeGovernanceText(String(value ?? "")));
      },
    });
    return { ...base, canonicalEntityId: actor.businessId, acceptedValue: { [field]: profile[field as keyof typeof profile] } };
  }

  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.BUSINESS_AVAILABILITY) {
    const proposed = proposedFact(review);
    if (!Object.values(DayOfWeek).includes(proposed.dayOfWeek as DayOfWeek)) {
      throw new AppError(422, "The proposed availability could not be validated.", "KNOWLEDGE_REVIEW_PROPOSED_VALUE_INVALID");
    }
    const availability = await availabilityService.updateRule(actor, {
      dayOfWeek: proposed.dayOfWeek as DayOfWeek,
      isOpen: Boolean(proposed.isOpen),
      openTime: proposed.openTime as string | null,
      closeTime: proposed.closeTime as string | null,
    }, context, {
      assertCurrent(current) {
        const normalized = current
          ? `${current.dayOfWeek}:${current.isOpen}:${current.openTime}:${current.closeTime}`
          : null;
        assertCanonicalValueUnchanged(review, normalized);
      },
    });
    return { ...base, canonicalEntityId: availability.rules.find((rule) => rule.dayOfWeek === proposed.dayOfWeek)?.id ?? null, acceptedValue: proposed };
  }

  if (review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.APPOINTMENT_SETTINGS) {
    const update = appointmentSettingsSchema.parse(proposedFact(review));
    const result = await updateAppointmentSettings(actor, update, context, {
      assertCurrent(current) {
        assertCanonicalValueUnchanged(review, current.appointmentConfirmationMode);
      },
    });
    return { ...base, canonicalEntityId: actor.businessId, acceptedValue: result.settings };
  }

  throw new AppError(422, "This review item has no supported Settings destination.", "KNOWLEDGE_REVIEW_SETTINGS_TARGET_UNSUPPORTED");
}

async function recoverCommittedDomainResult(
  actor: KnowledgeDocumentActor,
  review: ResolutionReview,
  input: ResolveKnowledgeGovernanceReviewInput,
  operationId: string,
): Promise<DomainResult | null> {
  const base = {
    canonicalEntityType: review.canonicalEntityType,
    canonicalEntityId: review.canonicalEntityId,
    canonicalField: review.canonicalField,
    previousValue: review.existingValue,
    acceptedValue: review.documentValue,
  };
  if (input.action === KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS
    && review.canonicalEntityType === KnowledgeGovernanceCanonicalEntityType.SERVICE) {
    const serviceInput = governanceServiceInput(review, input);
    const service = await prisma.service.findFirst({
      where: {
        businessId: actor.businessId,
        governanceCreationOperationId: operationId,
        isArchived: false,
      },
      select: {
        id: true,
        name: true,
        category: true,
        description: true,
        basePrice: true,
        currency: true,
        durationMinutes: true,
        business: { select: { defaultCurrency: true } },
      },
    });
    if (!service) return null;
    const expectedCurrency = serviceInput.currency ?? service.business.defaultCurrency;
    const matches = normalizeGovernanceText(service.name) === normalizeGovernanceText(serviceInput.name)
      && normalizeGovernanceText(service.category) === normalizeGovernanceText(serviceInput.category)
      && normalizeGovernanceText(service.description) === normalizeGovernanceText(serviceInput.description)
      && normalizeGovernanceNumber(service.basePrice) === normalizeGovernanceNumber(serviceInput.basePrice)
      && normalizeGovernanceCurrency(service.currency) === normalizeGovernanceCurrency(expectedCurrency)
      && (service.durationMinutes ?? null) === (serviceInput.durationMinutes ?? null);
    if (!matches) return null;
    const { business: _business, ...acceptedService } = service;
    return {
      ...base,
      canonicalEntityId: service.id,
      canonicalField: review.canonicalField ?? "name",
      acceptedValue: acceptedService,
    };
  }
  if (input.action === KnowledgeGovernanceResolutionAction.ARCHIVE && review.canonicalEntityId) {
    const service = await prisma.service.findFirst({
      where: { id: review.canonicalEntityId, businessId: actor.businessId, isArchived: true },
      select: { id: true },
    });
    return service ? { ...base, acceptedValue: { serviceId: service.id, archived: true } } : null;
  }
  if (input.action !== KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS || !review.normalizedDocumentValue) return null;
  const current = await prisma.$transaction((tx) => currentCanonicalValue(tx, review));
  return current === review.normalizedDocumentValue ? { ...base, acceptedValue: review.documentValue } : null;
}

async function failOperation(
  operationId: string,
  businessId: string,
  reviewId: string,
  leaseOwner: string,
  error: unknown,
) {
  const code = error instanceof AppError ? error.code : "KNOWLEDGE_REVIEW_APPLY_FAILED";
  const message = error instanceof AppError ? error.message : "The governance decision could not be applied.";
  await prisma.$transaction(async (tx) => {
    const review = await tx.knowledgeGovernanceReview.findFirst({
      where: { id: reviewId, businessId },
      select: { documentId: true },
    });
    if (!review) return;
    await lockKnowledgeDocumentGovernance(tx, review.documentId);
    await lockKnowledgeGovernanceReview(tx, reviewId);
    const changed = await tx.knowledgeGovernanceResolutionOperation.updateMany({
      where: {
        id: operationId,
        businessId,
        status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
        leaseOwner,
      },
      data: {
        status: KnowledgeGovernanceResolutionOperationStatus.FAILED,
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: code,
        errorMessage: message,
      },
    });
    if (changed.count === 1) {
      await tx.knowledgeGovernanceReview.updateMany({
        where: { id: reviewId, businessId, reviewStatus: KnowledgeGovernanceReviewStatus.APPLYING },
        data: { reviewStatus: KnowledgeGovernanceReviewStatus.PENDING_REVIEW },
      });
    }
  }).catch(() => undefined);
}

async function finalize(
  actor: KnowledgeDocumentActor,
  operationId: string,
  reviewId: string,
  input: ResolveKnowledgeGovernanceReviewInput,
  domain: DomainResult,
  leaseOwner: string,
  context: Omit<AuditInput, "action">,
) {
  return prisma.$transaction(async (tx) => {
    const initialReview = await loadReview(tx, actor.businessId, reviewId);
    if (!initialReview) throw new AppError(409, "Resolution review was not found.", "KNOWLEDGE_REVIEW_STATE_CHANGED");
    await lockKnowledgeDocumentGovernance(tx, initialReview.documentId);
    await lockKnowledgeGovernanceReview(tx, reviewId);
    const operation = await tx.knowledgeGovernanceResolutionOperation.findFirst({
      where: {
        id: operationId,
        businessId: actor.businessId,
        status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
        leaseOwner,
      },
    });
    if (!operation) throw new AppError(409, "Resolution operation was not found.", "KNOWLEDGE_REVIEW_STATE_CHANGED");
    const review = await loadReview(tx, actor.businessId, reviewId);
    if (!review || review.reviewStatus !== KnowledgeGovernanceReviewStatus.APPLYING
      || review.versionId !== input.expectedVersionId
      || review.document.activeVersionId !== input.expectedVersionId
      || review.document.status !== KnowledgeDocumentStatus.ACTIVE) staleReview();
    if (review.documentId !== initialReview.documentId) staleReview();

    const approved = input.action === KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS
      || input.action === KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS
      || input.action === KnowledgeGovernanceResolutionAction.APPROVE_KNOWLEDGE_ONLY;
    const now = new Date();
    if (review.factId) {
      await tx.knowledgeDocumentFact.updateMany({
        where: { id: review.factId, businessId: actor.businessId, documentId: review.documentId, versionId: review.versionId },
        data: {
          governanceStatus: approved ? KnowledgeFactGovernanceStatus.APPROVED : KnowledgeFactGovernanceStatus.REJECTED,
          governedAt: now,
          reviewedByMembershipId: actor.membershipId,
          canonicalEntityType: domain.canonicalEntityType,
          canonicalEntityId: domain.canonicalEntityId,
          canonicalField: domain.canonicalField,
          acceptedValue: json(domain.acceptedValue),
        },
      });
    }
    if (input.action === KnowledgeGovernanceResolutionAction.REPLACE && review.relatedDocumentId) {
      await tx.knowledgeDocument.updateMany({
        where: { id: review.documentId, businessId: actor.businessId, status: KnowledgeDocumentStatus.ACTIVE, activeVersionId: review.versionId },
        data: { replacesDocumentId: review.relatedDocumentId },
      });
    }
    const changed = await tx.knowledgeGovernanceReview.updateMany({
      where: { id: reviewId, businessId: actor.businessId, reviewStatus: KnowledgeGovernanceReviewStatus.APPLYING },
      data: {
        reviewStatus: KnowledgeGovernanceReviewStatus.RESOLVED,
        requiresHumanReview: false,
        blocksAiUse: !approved,
        reviewedAt: now,
        reviewedByMembershipId: actor.membershipId,
        resolutionAction: input.action,
        resolutionReason: input.note ?? (approved ? "Approved by human review." : "Not applied by human review."),
        canonicalEntityId: domain.canonicalEntityId,
        canonicalField: domain.canonicalField,
      },
    });
    if (changed.count !== 1) throw new AppError(409, "This review item has already changed.", "KNOWLEDGE_REVIEW_STATE_CHANGED");

    const [unresolved, factCount, nonApprovedFactCount] = await Promise.all([
      tx.knowledgeGovernanceReview.count({
        where: {
          businessId: actor.businessId,
          documentId: review.documentId,
          versionId: review.versionId,
          requiresHumanReview: true,
          reviewStatus: { in: [KnowledgeGovernanceReviewStatus.PENDING_REVIEW, KnowledgeGovernanceReviewStatus.APPLYING] },
        },
      }),
      tx.knowledgeDocumentFact.count({
        where: { businessId: actor.businessId, documentId: review.documentId, versionId: review.versionId },
      }),
      tx.knowledgeDocumentFact.count({
        where: {
          businessId: actor.businessId,
          documentId: review.documentId,
          versionId: review.versionId,
          governanceStatus: { not: KnowledgeFactGovernanceStatus.APPROVED },
        },
      }),
    ]);
    const factsCustomerSafe = factCount > 0 && nonApprovedFactCount === 0;
    const documentApproved = unresolved === 0 && factsCustomerSafe;
    const governanceStatus = documentApproved ? KnowledgeGovernanceStatus.APPROVED : KnowledgeGovernanceStatus.REVIEW_REQUIRED;
    const processingStatus = documentApproved ? KnowledgeDocumentProcessingStatus.READY : KnowledgeDocumentProcessingStatus.NEEDS_REVIEW;
    const processingErrorCode = documentApproved
      ? null
      : unresolved > 0
        ? "KNOWLEDGE_DOCUMENT_GOVERNANCE_REVIEW_REQUIRED"
        : "KNOWLEDGE_DOCUMENT_FILTERED_CHUNKS_REQUIRED";
    const processingErrorMessage = documentApproved
      ? null
      : unresolved > 0
        ? "Resolve every required fact review before customer use."
        : "Rejected document facts must be excluded before this document can be used with customers.";
    await Promise.all([
      tx.knowledgeDocument.updateMany({
        where: { id: review.documentId, businessId: actor.businessId, activeVersionId: review.versionId, status: KnowledgeDocumentStatus.ACTIVE },
        data: { governanceStatus, processingStatus, processingErrorCode, processingErrorMessage },
      }),
      tx.knowledgeDocumentVersion.updateMany({
        where: { id: review.versionId, documentId: review.documentId, businessId: actor.businessId, isActive: true },
        data: { governanceStatus, processingStatus, processingErrorCode, processingErrorMessage },
      }),
      tx.knowledgeDocumentAnalysis.updateMany({
        where: { versionId: review.versionId, documentId: review.documentId, businessId: actor.businessId },
        data: { requiresHumanReview: !documentApproved },
      }),
    ]);

    const auditMetadata = json({
      reviewItemId: review.id,
      documentId: review.documentId,
      versionId: review.versionId,
      factId: review.factId,
      canonicalEntityType: domain.canonicalEntityType,
      canonicalEntityId: domain.canonicalEntityId,
      canonicalField: domain.canonicalField,
      previousValue: domain.previousValue,
      proposedValue: review.documentValue,
      acceptedValue: domain.acceptedValue,
      resolutionAction: input.action,
      reviewedBy: actor.membershipId,
      reviewedAt: now.toISOString(),
    });
    await tx.auditLog.create({
      data: {
        ...context,
        action: approved ? AuditAction.KNOWLEDGE_FACT_REVIEW_APPROVED : AuditAction.KNOWLEDGE_FACT_REVIEW_REJECTED,
        businessId: actor.businessId,
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        metadata: auditMetadata,
      },
    });
    if (isKnowledgeSettingsMutation(input.action)) {
      await tx.auditLog.create({
        data: {
          ...context,
          action: AuditAction.KNOWLEDGE_SETTINGS_SYNCED,
          businessId: actor.businessId,
          userId: actor.userId,
          actorMembershipId: actor.membershipId,
          metadata: auditMetadata,
        },
      });
    }
    const result = {
      reviewId,
      documentId: review.documentId,
      versionId: review.versionId,
      factId: review.factId,
      action: input.action,
      reviewStatus: KnowledgeGovernanceReviewStatus.RESOLVED,
      factStatus: review.factId ? approved ? KnowledgeFactGovernanceStatus.APPROVED : KnowledgeFactGovernanceStatus.REJECTED : null,
      canonicalEntityId: domain.canonicalEntityId,
      canonicalField: domain.canonicalField,
      documentGovernanceStatus: governanceStatus,
      documentProcessingStatus: processingStatus,
      unresolvedReviewCount: unresolved,
      duplicate: false,
    };
    const operationChanged = await tx.knowledgeGovernanceResolutionOperation.updateMany({
      where: {
        id: operation.id,
        businessId: actor.businessId,
        status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
        leaseOwner,
      },
      data: {
        status: KnowledgeGovernanceResolutionOperationStatus.COMPLETED,
        resultSnapshot: json(result),
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (operationChanged.count !== 1) {
      throw new AppError(409, "The review operation lease changed before finalization.", "KNOWLEDGE_REVIEW_STATE_CHANGED");
    }
    await enqueueKnowledgeRuntimeRefresh(tx, {
      businessId: actor.businessId,
      documentId: review.documentId,
    });
    return result;
  }, TRANSACTION_OPTIONS);
}

async function refresh(actor: KnowledgeDocumentActor, result: { reviewId?: string; documentId: string; versionId: string; action: KnowledgeGovernanceResolutionAction; documentGovernanceStatus: KnowledgeGovernanceStatus }) {
  await knowledgeRuntimeRefreshService.processDocuments([result.documentId]);
  realtimeService.publish({
    type: "business.knowledge.review.resolved",
    businessId: actor.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload: { reviewId: result.reviewId, documentId: result.documentId, versionId: result.versionId, action: result.action, governanceStatus: result.documentGovernanceStatus },
  });
  if (isKnowledgeSettingsMutation(result.action)) {
    realtimeService.publish({
      type: "business.knowledge.settings_synced",
      businessId: actor.businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: { documentId: result.documentId, versionId: result.versionId, action: result.action },
    });
  }
  if (result.documentGovernanceStatus === KnowledgeGovernanceStatus.APPROVED) {
    realtimeService.publish({
      type: "business.knowledge.document.approved",
      businessId: actor.businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: { documentId: result.documentId, versionId: result.versionId },
    });
  }
}

function domainCheckpoint(value: Prisma.JsonValue | null): DomainResult | null {
  const snapshot = asObject(value);
  if (snapshot.phase !== "DOMAIN_APPLIED") return null;
  const domain = snapshot.domain;
  return domain && typeof domain === "object" && !Array.isArray(domain)
    ? domain as DomainResult
    : null;
}

async function claimStaleOperation(operationId: string, staleBefore: Date) {
  const leaseOwner = crypto.randomUUID();
  return prisma.$transaction(async (tx) => {
    const initial = await tx.knowledgeGovernanceResolutionOperation.findUnique({
      where: { id: operationId },
      select: { review: { select: { id: true, documentId: true } } },
    });
    if (!initial) return null;
    await lockKnowledgeDocumentGovernance(tx, initial.review.documentId);
    await lockKnowledgeGovernanceReview(tx, initial.review.id);
    const operation = await tx.knowledgeGovernanceResolutionOperation.findFirst({
      where: {
        id: operationId,
        status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
        OR: [
          { leaseExpiresAt: { lte: new Date() } },
          { leaseExpiresAt: null, updatedAt: { lte: staleBefore } },
        ],
      },
      include: {
        review: {
          include: {
            document: { select: { id: true, status: true, activeVersionId: true, archivedAt: true } },
            version: { select: { id: true, isActive: true, governanceStatus: true } },
          },
        },
        actor: {
          select: {
            id: true,
            userId: true,
            businessId: true,
            role: true,
            business: { select: { businessAccountId: true } },
          },
        },
      },
    });
    if (!operation) return null;
    if (operation.review.reviewStatus !== KnowledgeGovernanceReviewStatus.APPLYING) {
      await tx.knowledgeGovernanceResolutionOperation.update({
        where: { id: operation.id },
        data: {
          status: KnowledgeGovernanceResolutionOperationStatus.FAILED,
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: "KNOWLEDGE_REVIEW_OPERATION_STATE_INCONSISTENT",
          errorMessage: "The stale operation no longer owns an applying review.",
        },
      });
      return null;
    }
    const processingStartedAt = new Date();
    const changed = await tx.knowledgeGovernanceResolutionOperation.updateMany({
      where: {
        id: operation.id,
        status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
        OR: [
          { leaseExpiresAt: { lte: processingStartedAt } },
          { leaseExpiresAt: null, updatedAt: { lte: staleBefore } },
        ],
      },
      data: {
        processingStartedAt,
        leaseOwner,
        leaseExpiresAt: governanceLeaseExpiresAt(processingStartedAt),
        attemptCount: { increment: 1 },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (changed.count !== 1) return null;
    const storedInput = asObject(operation.requestInput);
    const storedSettings = storedInput.settingsInput;
    const input: ResolveKnowledgeGovernanceReviewInput = {
      expectedVersionId: operation.expectedVersionId,
      action: operation.action,
      ...(storedSettings && typeof storedSettings === "object" && !Array.isArray(storedSettings)
        ? { settingsInput: storedSettings as Record<string, unknown> }
        : operation.settingsInput && typeof operation.settingsInput === "object" && !Array.isArray(operation.settingsInput)
          ? { settingsInput: operation.settingsInput as Record<string, unknown> }
          : {}),
      ...(typeof storedInput.note === "string" || storedInput.note === null ? { note: storedInput.note } : {}),
    };
    const actor: KnowledgeDocumentActor = {
      userId: operation.actor.userId,
      businessAccountId: operation.actor.business.businessAccountId,
      businessId: operation.actor.businessId,
      membershipId: operation.actor.id,
      role: operation.actor.role,
    };
    return { operation, review: operation.review as ResolutionReview, actor, input, leaseOwner };
  }, TRANSACTION_OPTIONS);
}

async function deferStaleOperation(operationId: string, leaseOwner: string, error: unknown) {
  const code = error instanceof AppError ? error.code : "KNOWLEDGE_REVIEW_RECONCILIATION_FAILED";
  const message = error instanceof AppError ? error.message : "The stale governance operation could not be reconciled.";
  await prisma.knowledgeGovernanceResolutionOperation.updateMany({
    where: {
      id: operationId,
      status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
      leaseOwner,
    },
    data: {
      leaseOwner: null,
      leaseExpiresAt: new Date(),
      errorCode: code,
      errorMessage: message.slice(0, 300),
    },
  });
}

async function reconcileStaleOperation(operationId: string, staleBefore: Date) {
  const claimed = await claimStaleOperation(operationId, staleBefore);
  if (!claimed) return "SKIPPED" as const;
  try {
    let domain = domainCheckpoint(claimed.operation.resultSnapshot);
    if (!domain) {
      domain = isKnowledgeSettingsMutation(claimed.input.action)
        ? await recoverCommittedDomainResult(claimed.actor, claimed.review, claimed.input, claimed.operation.id)
        : await executeDomainAction(claimed.actor, claimed.review, claimed.input, claimed.operation.id, {});
      if (!domain) {
        await failOperation(
          claimed.operation.id,
          claimed.actor.businessId,
          claimed.review.id,
          claimed.leaseOwner,
          new AppError(
            409,
            "The expired governance operation did not leave a committed Settings change and was released for retry.",
            "KNOWLEDGE_REVIEW_STALE_OPERATION_RELEASED",
          ),
        );
        return "RELEASED" as const;
      }
      await checkpointDomainResult(
        claimed.operation.id,
        claimed.actor.businessId,
        claimed.leaseOwner,
        domain,
      );
    }
    const result = await finalize(
      claimed.actor,
      claimed.operation.id,
      claimed.review.id,
      claimed.input,
      domain,
      claimed.leaseOwner,
      {},
    );
    await refresh(claimed.actor, result as Parameters<typeof refresh>[1]);
    return "RECOVERED" as const;
  } catch (error) {
    await deferStaleOperation(claimed.operation.id, claimed.leaseOwner, error);
    console.error("Knowledge governance operation reconciliation failed", {
      businessId: claimed.actor.businessId,
      operationId: claimed.operation.id,
      reviewId: claimed.review.id,
      errorCode: error instanceof AppError ? error.code : "KNOWLEDGE_REVIEW_RECONCILIATION_FAILED",
    });
    return "DEFERRED" as const;
  }
}

export const knowledgeGovernanceResolutionService = {
  async reconcileStaleOperations(limit = env.KNOWLEDGE_DOCUMENT_WORKER_BATCH_SIZE) {
    const staleBefore = new Date(
      Date.now() - env.KNOWLEDGE_GOVERNANCE_OPERATION_LEASE_SECONDS * 1_000,
    );
    const operations = await prisma.knowledgeGovernanceResolutionOperation.findMany({
      where: {
        status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
        OR: [
          { leaseExpiresAt: { lte: new Date() } },
          { leaseExpiresAt: null, updatedAt: { lte: staleBefore } },
        ],
      },
      select: { id: true },
      orderBy: [{ leaseExpiresAt: "asc" }, { updatedAt: "asc" }],
      take: Math.max(1, Math.min(limit, 100)),
    });
    const summary = { scanned: operations.length, recovered: 0, released: 0, deferred: 0 };
    for (const operation of operations) {
      const result = await reconcileStaleOperation(operation.id, staleBefore);
      if (result === "RECOVERED") summary.recovered += 1;
      if (result === "RELEASED") summary.released += 1;
      if (result === "DEFERRED") summary.deferred += 1;
    }
    return summary;
  },

  async reviewDetails(
    actor: KnowledgeDocumentActor,
    documentId: string,
    context: Omit<AuditInput, "action">,
  ) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_GOVERNANCE_REVIEW_READ");
    return prisma.$transaction(async (tx) => {
      const document = await tx.knowledgeDocument.findFirst({
        where: { id: documentId, businessId: actor.businessId, deletedAt: null },
        select: { id: true, title: true, status: true, processingStatus: true, governanceStatus: true, activeVersionId: true },
      });
      if (!document?.activeVersionId) throw new AppError(404, "Knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
      const reviews = await tx.knowledgeGovernanceReview.findMany({
        where: { businessId: actor.businessId, documentId, versionId: document.activeVersionId },
        orderBy: [{ reviewStatus: "asc" }, { priority: "asc" }, { detectedAt: "asc" }],
        include: {
          fact: {
            select: {
              id: true,
              factType: true,
              label: true,
              valueText: true,
              currency: true,
              numericValue: true,
              sourceKind: true,
              sourceLabel: true,
              pageNumber: true,
              sheetName: true,
              slideNumber: true,
              paragraphIndex: true,
              rowNumber: true,
              sourceExcerpt: true,
              confidence: true,
              governanceStatus: true,
              canonicalEntityType: true,
              canonicalEntityId: true,
              canonicalField: true,
              reviewedByMembershipId: true,
              governedAt: true,
            },
          },
          document: { select: { id: true, status: true, activeVersionId: true, archivedAt: true } },
          version: { select: { id: true, isActive: true, governanceStatus: true } },
        },
      });
      const items = await Promise.all(reviews.map(async (review) => {
        const current = await currentCanonicalValue(tx, review);
        const compared = snapshotCanonicalValue(review);
        return {
          id: review.id,
          factId: review.factId,
          comparisonType: review.comparisonType,
          priority: review.priority,
          reviewStatus: review.reviewStatus,
          canonicalEntityType: review.canonicalEntityType,
          canonicalEntityId: review.canonicalEntityId,
          canonicalField: review.canonicalField,
          comparisonSnapshot: review.existingValue,
          proposedValue: review.documentValue,
          normalizedComparedValue: compared,
          currentCanonicalValueNormalized: current,
          stale: compared !== null && current !== compared,
          requiresHumanReview: review.requiresHumanReview,
          blocksAiUse: review.blocksAiUse,
          relatedDocumentId: review.relatedDocumentId,
          relatedVersionId: review.relatedVersionId,
          resolutionAction: review.resolutionAction,
          resolutionReason: review.resolutionReason,
          detectedAt: review.detectedAt,
          reviewedAt: review.reviewedAt,
          fact: review.fact,
          allowedResolutionActions: review.reviewStatus === KnowledgeGovernanceReviewStatus.PENDING_REVIEW
            ? allowedKnowledgeGovernanceActions(review)
            : [],
        };
      }));
      return {
        document,
        versionId: document.activeVersionId,
        summary: {
          total: items.length,
          unresolved: items.filter((item) => item.reviewStatus !== KnowledgeGovernanceReviewStatus.RESOLVED).length,
          stale: items.filter((item) => item.stale).length,
        },
        reviews: items,
      };
    }, TRANSACTION_OPTIONS);
  },

  async compareReplacement(
    actor: KnowledgeDocumentActor,
    newDocumentId: string,
    reviewId: string,
    context: Omit<AuditInput, "action">,
  ) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_REPLACEMENT_COMPARE");
    const review = await prisma.knowledgeGovernanceReview.findFirst({
      where: {
        id: reviewId,
        businessId: actor.businessId,
        documentId: newDocumentId,
        comparisonType: "POTENTIAL_REPLACEMENT",
      },
      select: {
        id: true,
        versionId: true,
        relatedDocumentId: true,
        relatedVersionId: true,
        document: { select: { id: true, title: true, activeVersionId: true, status: true } },
      },
    });
    if (!review?.relatedDocumentId || !review.relatedVersionId) {
      throw new AppError(404, "Replacement comparison not found.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_NOT_FOUND");
    }
    if (review.document.activeVersionId !== review.versionId || review.document.status !== KnowledgeDocumentStatus.ACTIVE) staleReview();
    const oldDocument = await prisma.knowledgeDocument.findFirst({
      where: {
        id: review.relatedDocumentId,
        businessId: actor.businessId,
        status: KnowledgeDocumentStatus.ACTIVE,
        activeVersionId: review.relatedVersionId,
        deletedAt: null,
      },
      select: { id: true, title: true, activeVersionId: true },
    });
    if (!oldDocument) staleReplacementTarget();
    const factSelect = {
      id: true,
      factType: true,
      label: true,
      valueText: true,
      currency: true,
      numericValue: true,
      confidence: true,
      sourceKind: true,
      sourceLabel: true,
      pageNumber: true,
      sheetName: true,
      slideNumber: true,
      paragraphIndex: true,
      rowNumber: true,
      sourceExcerpt: true,
      governanceStatus: true,
    } satisfies Prisma.KnowledgeDocumentFactSelect;
    const [oldFacts, newFacts] = await Promise.all([
      prisma.knowledgeDocumentFact.findMany({
        where: { businessId: actor.businessId, documentId: oldDocument.id, versionId: review.relatedVersionId },
        orderBy: [{ factType: "asc" }, { createdAt: "asc" }],
        select: factSelect,
      }),
      prisma.knowledgeDocumentFact.findMany({
        where: { businessId: actor.businessId, documentId: newDocumentId, versionId: review.versionId },
        orderBy: [{ factType: "asc" }, { createdAt: "asc" }],
        select: factSelect,
      }),
    ]);
    const comparisons = classifyKnowledgeReplacementFacts(oldFacts, newFacts);
    return {
      reviewId,
      oldDocument: { id: oldDocument.id, title: oldDocument.title, versionId: review.relatedVersionId },
      newDocument: { id: review.document.id, title: review.document.title, versionId: review.versionId },
      summary: {
        unchanged: comparisons.filter((item) => item.classification === "UNCHANGED").length,
        changed: comparisons.filter((item) => item.classification === "CHANGED").length,
        new: comparisons.filter((item) => item.classification === "NEW").length,
        removed: comparisons.filter((item) => item.classification === "REMOVED").length,
      },
      comparisons,
    };
  },

  async resolve(
    actor: KnowledgeDocumentActor,
    reviewId: string,
    input: ResolveKnowledgeGovernanceReviewInput,
    idempotencyKey: string | undefined,
    context: Omit<AuditInput, "action">,
  ) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_GOVERNANCE_REVIEW_RESOLVE");
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 191) {
      throw new AppError(422, "A valid Idempotency-Key header is required.", "IDEMPOTENCY_KEY_REQUIRED");
    }
    const claimed = await claim(actor, reviewId, input, idempotencyKey);
    if (claimed.duplicate) return { ...(claimed.snapshot as Record<string, unknown>), duplicate: true };
    let domain = claimed.checkpoint;
    if (!domain) {
      try {
        domain = await executeDomainAction(actor, claimed.review, input, claimed.operation.id, context);
      } catch (error) {
        domain = await recoverCommittedDomainResult(actor, claimed.review, input, claimed.operation.id);
        if (!domain) {
          await failOperation(claimed.operation.id, actor.businessId, reviewId, claimed.leaseOwner, error);
          throw error;
        }
      }
      await checkpointDomainResult(claimed.operation.id, actor.businessId, claimed.leaseOwner, domain);
    }
    const result = await finalize(actor, claimed.operation.id, reviewId, input, domain, claimed.leaseOwner, context);
    await refresh(actor, result as Parameters<typeof refresh>[1]);
    return result;
  },

  async resolveBatch(
    actor: KnowledgeDocumentActor,
    input: ResolveKnowledgeGovernanceReviewBatchInput,
    context: Omit<AuditInput, "action">,
  ) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_GOVERNANCE_REVIEW_BATCH_RESOLVE");
    const results = [];
    for (const decision of input.decisions) {
      const { reviewId, idempotencyKey, ...resolution } = decision;
      try {
        results.push({ reviewId, success: true, result: await this.resolve(actor, reviewId, resolution, idempotencyKey, context) });
      } catch (error) {
        results.push({
          reviewId,
          success: false,
          error: {
            code: error instanceof AppError ? error.code : "KNOWLEDGE_REVIEW_APPLY_FAILED",
            message: error instanceof AppError ? error.message : "The review decision could not be applied.",
          },
        });
      }
    }
    return { mode: "PARTIAL_SUCCESS" as const, results };
  },

  async completeReplacement(
    actor: KnowledgeDocumentActor,
    newDocumentId: string,
    input: CompleteKnowledgeDocumentReplacementInput,
    context: Omit<AuditInput, "action">,
  ) {
    await assertCanManageKnowledgeDocuments(actor, context, "KNOWLEDGE_DOCUMENT_REPLACEMENT_COMPLETE");
    const result = await prisma.$transaction(async (tx) => {
      const review = await tx.knowledgeGovernanceReview.findFirst({
        where: {
          id: input.reviewId,
          businessId: actor.businessId,
          documentId: newDocumentId,
          versionId: input.expectedVersionId,
          reviewStatus: KnowledgeGovernanceReviewStatus.RESOLVED,
          resolutionAction: KnowledgeGovernanceResolutionAction.REPLACE,
        },
        select: { id: true, relatedDocumentId: true, relatedVersionId: true },
      });
      if (!review?.relatedDocumentId || !review.relatedVersionId) {
        throw new AppError(409, "A resolved replacement review is required.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_NOT_CONFIRMED");
      }
      if (review.relatedDocumentId === newDocumentId) {
        throw new AppError(422, "Version replacement is already managed inside this document.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_REQUIRES_DISTINCT_DOCUMENTS");
      }
      for (const documentId of [newDocumentId, review.relatedDocumentId].sort()) {
        await lockKnowledgeDocumentLifecycleChange(tx, actor.businessId, documentId);
      }
      const [newDocument, oldDocument] = await Promise.all([
        tx.knowledgeDocument.findFirst({
          where: {
            id: newDocumentId,
            businessId: actor.businessId,
            status: KnowledgeDocumentStatus.ACTIVE,
            activeVersionId: input.expectedVersionId,
            governanceStatus: KnowledgeGovernanceStatus.APPROVED,
            deletedAt: null,
          },
          select: { id: true, activeVersionId: true },
        }),
        tx.knowledgeDocument.findFirst({
          where: {
            id: review.relatedDocumentId,
            businessId: actor.businessId,
            status: KnowledgeDocumentStatus.ACTIVE,
            activeVersionId: review.relatedVersionId,
            deletedAt: null,
          },
          select: { id: true, activeVersionId: true },
        }),
      ]);
      if (!newDocument) staleReview();
      if (!oldDocument) staleReplacementTarget();
      const unresolved = await tx.knowledgeGovernanceReview.count({
        where: {
          businessId: actor.businessId,
          documentId: newDocumentId,
          versionId: input.expectedVersionId,
          requiresHumanReview: true,
          reviewStatus: { not: KnowledgeGovernanceReviewStatus.RESOLVED },
        },
      });
      if (unresolved > 0) {
        throw new AppError(409, "Resolve all required review items before completing replacement.", "KNOWLEDGE_DOCUMENT_REPLACEMENT_REVIEWS_PENDING", { unresolvedReviewCount: unresolved });
      }
      const now = new Date();
      const [oldChanged, newChanged] = await Promise.all([
        tx.knowledgeDocument.updateMany({
          where: {
            id: oldDocument.id,
            businessId: actor.businessId,
            status: KnowledgeDocumentStatus.ACTIVE,
            activeVersionId: review.relatedVersionId,
            deletedAt: null,
          },
          data: {
            status: KnowledgeDocumentStatus.ARCHIVED,
            archivedAt: now,
            archiveReason: KnowledgeDocumentArchiveReason.SUPERSEDED,
            governanceStatus: KnowledgeGovernanceStatus.ARCHIVED,
            supersededByDocumentId: newDocumentId,
          },
        }),
        tx.knowledgeDocument.updateMany({
          where: { id: newDocumentId, businessId: actor.businessId, activeVersionId: input.expectedVersionId, governanceStatus: KnowledgeGovernanceStatus.APPROVED },
          data: { replacesDocumentId: oldDocument.id },
        }),
      ]);
      if (oldChanged.count !== 1 || newChanged.count !== 1) staleReview();
      await Promise.all([
        tx.knowledgeDocumentVersion.updateMany({
          where: {
            id: review.relatedVersionId,
            businessId: actor.businessId,
            documentId: oldDocument.id,
            isActive: true,
          },
          data: { governanceStatus: KnowledgeGovernanceStatus.ARCHIVED },
        }),
        tx.knowledgeDocumentFact.updateMany({
          where: {
            businessId: actor.businessId,
            documentId: oldDocument.id,
            versionId: review.relatedVersionId,
          },
          data: { governanceStatus: KnowledgeFactGovernanceStatus.SUPERSEDED, governedAt: now },
        }),
      ]);
      await tx.auditLog.create({
        data: {
          ...context,
          action: AuditAction.KNOWLEDGE_DOCUMENT_REPLACEMENT_CONFIRMED,
          businessId: actor.businessId,
          userId: actor.userId,
          actorMembershipId: actor.membershipId,
          metadata: json({
            reviewItemId: review.id,
            oldDocumentId: oldDocument.id,
            oldVersionId: review.relatedVersionId,
            newDocumentId,
            newVersionId: input.expectedVersionId,
            archiveReason: KnowledgeDocumentArchiveReason.SUPERSEDED,
            note: input.note,
          }),
        },
      });
      for (const documentId of [oldDocument.id, newDocumentId]) {
        await enqueueKnowledgeRuntimeRefresh(tx, {
          businessId: actor.businessId,
          documentId,
        });
      }
      return {
        oldDocumentId: oldDocument.id,
        oldDocumentStatus: KnowledgeDocumentStatus.ARCHIVED,
        archiveReason: KnowledgeDocumentArchiveReason.SUPERSEDED,
        newDocumentId,
        newDocumentStatus: KnowledgeDocumentStatus.ACTIVE,
        newDocumentGovernanceStatus: KnowledgeGovernanceStatus.APPROVED,
      };
    }, TRANSACTION_OPTIONS);

    await knowledgeRuntimeRefreshService.processDocuments([
      result.oldDocumentId,
      result.newDocumentId,
    ]);
    realtimeService.publish({
      type: "business.knowledge.document.replacement_confirmed",
      businessId: actor.businessId,
      roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
      payload: result,
    });
    return result;
  },
};
