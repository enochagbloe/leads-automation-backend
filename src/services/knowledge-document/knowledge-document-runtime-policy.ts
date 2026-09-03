import {
  KnowledgeFactGovernanceStatus,
  Prisma,
} from "@prisma/client";

export const customerSafeKnowledgeDocumentWhere = {
  activeVersion: {
    is: {
      facts: {
        every: { governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
      },
    },
  },
} satisfies Prisma.KnowledgeDocumentWhereInput;

export function knowledgeFactStatusesAreCustomerSafe(
  facts: ReadonlyArray<{ governanceStatus: KnowledgeFactGovernanceStatus }>,
) {
  return facts.every((fact) => fact.governanceStatus === KnowledgeFactGovernanceStatus.APPROVED);
}

export function knowledgeFactIsRuntimeUsable(input: {
  governanceStatus: KnowledgeFactGovernanceStatus;
  activeDocument: boolean;
  activeVersion: boolean;
  blockedByUnresolvedReview: boolean;
}) {
  return input.governanceStatus === KnowledgeFactGovernanceStatus.APPROVED
    && input.activeDocument
    && input.activeVersion
    && !input.blockedByUnresolvedReview;
}
