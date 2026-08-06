import { AuditAction, BusinessRole, MembershipStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { AuditInput, auditService } from "../audit.service";

export type KnowledgeDocumentActor = {
  userId: string;
  businessAccountId: string;
  businessId: string;
  membershipId: string;
  role: BusinessRole;
};

type KnowledgeDocumentMembershipAccess = {
  role: BusinessRole;
  status: MembershipStatus;
  canManageKnowledgeHub: boolean;
};

export function canManageKnowledgeDocuments(access: KnowledgeDocumentMembershipAccess | null | undefined) {
  if (!access || access.status !== MembershipStatus.ACTIVE) return false;
  return access.role === BusinessRole.BUSINESS_OWNER
    || (access.role === BusinessRole.MANAGER && access.canManageKnowledgeHub);
}

export async function resolveKnowledgeDocumentAccess(actor: KnowledgeDocumentActor) {
  return prisma.businessMember.findFirst({
    where: {
      id: actor.membershipId,
      userId: actor.userId,
      businessId: actor.businessId,
      business: { businessAccountId: actor.businessAccountId, deletedAt: null },
    },
    select: { role: true, status: true, canManageKnowledgeHub: true },
  });
}

async function securityAudit(
  actor: KnowledgeDocumentActor,
  action: AuditAction,
  context: Omit<AuditInput, "action"> | undefined,
  metadata: Record<string, unknown>,
) {
  await auditService.log({
    ...(context ?? {}),
    action,
    businessId: actor.businessId,
    userId: actor.userId,
    actorMembershipId: actor.membershipId,
    metadata: {
      securityEvent: true,
      requestedBusinessId: actor.businessId,
      actorMembershipId: actor.membershipId,
      ...metadata,
    },
  }).catch(() => undefined);
}

export async function assertCanManageKnowledgeDocuments(
  actor: KnowledgeDocumentActor,
  context?: Omit<AuditInput, "action">,
  operation = "KNOWLEDGE_DOCUMENT_MUTATION",
) {
  const membership = await resolveKnowledgeDocumentAccess(actor);
  if (canManageKnowledgeDocuments(membership)) return membership;

  await securityAudit(actor, AuditAction.KNOWLEDGE_DOCUMENT_PERMISSION_DENIED, context, {
    operation,
    authenticatedRole: actor.role,
    membershipResolved: Boolean(membership),
  });
  throw new AppError(403, "You do not have permission to manage Knowledge Hub documents.", "KNOWLEDGE_DOCUMENT_PERMISSION_DENIED");
}

export async function throwKnowledgeDocumentNotFound(
  actor: KnowledgeDocumentActor,
  documentId: string,
  context?: Omit<AuditInput, "action">,
  operation = "KNOWLEDGE_DOCUMENT_ACCESS",
): Promise<never> {
  const foreignDocument = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, businessId: { not: actor.businessId } },
    select: { id: true },
  });
  if (foreignDocument) {
    await securityAudit(actor, AuditAction.KNOWLEDGE_DOCUMENT_SCOPE_VIOLATION, context, {
      operation,
      requestedDocumentId: documentId,
    });
  }
  throw new AppError(404, "Knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
}
