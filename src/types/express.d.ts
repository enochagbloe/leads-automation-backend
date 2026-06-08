import { BusinessRole, PlatformRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        businessAccountId: string | null;
        businessId: string | null;
        membershipId: string | null;
        role: BusinessRole | PlatformRole;
      };
    }
  }
}

export {};
