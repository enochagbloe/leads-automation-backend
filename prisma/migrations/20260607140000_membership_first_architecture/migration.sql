CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'INVITED', 'DISABLED', 'REMOVED');
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

ALTER TYPE "AuditAction" ADD VALUE 'STAFF_INVITED';
ALTER TYPE "AuditAction" ADD VALUE 'STAFF_INVITATION_ACCEPTED';

ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
UPDATE "User" SET "status" = CASE WHEN "isActive" THEN 'ACTIVE'::"UserStatus" ELSE 'DISABLED'::"UserStatus" END;
ALTER TABLE "User" DROP COLUMN "isActive";

DROP INDEX "Business_ownerId_key";
CREATE INDEX "Business_ownerId_idx" ON "Business"("ownerId");

ALTER TABLE "BusinessMember"
  ADD COLUMN "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "joinedAt" TIMESTAMP(3),
  ADD COLUMN "invitedById" TEXT;

UPDATE "BusinessMember" SET "joinedAt" = "createdAt";

CREATE INDEX "BusinessMember_businessId_status_idx" ON "BusinessMember"("businessId", "status");
CREATE INDEX "BusinessMember_invitedById_idx" ON "BusinessMember"("invitedById");
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BusinessInvitation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "invitedById" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessInvitation_tokenHash_key" ON "BusinessInvitation"("tokenHash");
CREATE INDEX "BusinessInvitation_businessId_status_idx" ON "BusinessInvitation"("businessId", "status");
CREATE INDEX "BusinessInvitation_email_status_idx" ON "BusinessInvitation"("email", "status");
ALTER TABLE "BusinessInvitation" ADD CONSTRAINT "BusinessInvitation_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessInvitation" ADD CONSTRAINT "BusinessInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
