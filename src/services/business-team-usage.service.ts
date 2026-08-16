import { MembershipStatus, Prisma } from "@prisma/client";

export async function lockBusinessStaffQuota(tx: Prisma.TransactionClient, businessAccountId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('business_staff_quota'), hashtext(${businessAccountId}))`;
}

export async function countDistinctActiveBusinessAccountUsers(
  tx: Prisma.TransactionClient,
  businessAccountId: string,
) {
  const [result] = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT bm."userId")::bigint AS "count"
    FROM "BusinessMember" bm
    INNER JOIN "Business" b ON b."id" = bm."businessId"
    WHERE b."businessAccountId" = ${businessAccountId}
      AND b."deletedAt" IS NULL
      AND bm."status" = CAST(${MembershipStatus.ACTIVE} AS "MembershipStatus")
  `;
  return Number(result?.count ?? 0n);
}

export async function isUserActiveInBusinessAccount(
  tx: Prisma.TransactionClient,
  businessAccountId: string,
  userId: string,
) {
  const membership = await tx.businessMember.findFirst({
    where: {
      userId,
      status: MembershipStatus.ACTIVE,
      business: { businessAccountId, deletedAt: null },
    },
    select: { id: true },
  });
  return Boolean(membership);
}
