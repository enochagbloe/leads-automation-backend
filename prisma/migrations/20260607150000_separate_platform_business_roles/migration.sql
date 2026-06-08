CREATE TYPE "BusinessRole" AS ENUM ('BUSINESS_OWNER', 'MANAGER', 'STAFF');
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_ADMIN');

ALTER TABLE "User" ADD COLUMN "platformRoleNew" "PlatformRole";
UPDATE "User" SET "platformRoleNew" = 'PLATFORM_ADMIN' WHERE "platformRole" = 'PLATFORM_ADMIN';
ALTER TABLE "User" DROP COLUMN "platformRole";
ALTER TABLE "User" RENAME COLUMN "platformRoleNew" TO "platformRole";

ALTER TABLE "BusinessMember" ADD COLUMN "roleNew" "BusinessRole";
UPDATE "BusinessMember" SET "roleNew" = "role"::text::"BusinessRole";
ALTER TABLE "BusinessMember" ALTER COLUMN "roleNew" SET NOT NULL;
ALTER TABLE "BusinessMember" DROP COLUMN "role";
ALTER TABLE "BusinessMember" RENAME COLUMN "roleNew" TO "role";

ALTER TABLE "BusinessInvitation" ADD COLUMN "roleNew" "BusinessRole";
UPDATE "BusinessInvitation" SET "roleNew" = "role"::text::"BusinessRole";
ALTER TABLE "BusinessInvitation" ALTER COLUMN "roleNew" SET NOT NULL;
ALTER TABLE "BusinessInvitation" DROP COLUMN "role";
ALTER TABLE "BusinessInvitation" RENAME COLUMN "roleNew" TO "role";

DROP TYPE "UserRole";
