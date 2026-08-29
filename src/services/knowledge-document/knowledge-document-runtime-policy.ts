import {
  KnowledgeFactGovernanceStatus,
  Prisma,
} from "@prisma/client";

export const customerSafeKnowledgeDocumentWhere = {
  activeVersion: {
    is: {
      facts: {
        some: {},
        every: { governanceStatus: KnowledgeFactGovernanceStatus.APPROVED },
      },
    },
  },
} satisfies Prisma.KnowledgeDocumentWhereInput;

export function knowledgeFactStatusesAreCustomerSafe(
  facts: ReadonlyArray<{ governanceStatus: KnowledgeFactGovernanceStatus }>,
) {
  return facts.length > 0
    && facts.every((fact) => fact.governanceStatus === KnowledgeFactGovernanceStatus.APPROVED);
}
