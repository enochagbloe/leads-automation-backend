import { BusinessRole, PlatformRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      auth?: {
        userId: string;
        businessAccountId: string | null;
        businessId: string | null;
        membershipId: string | null;
        role: BusinessRole | PlatformRole | null;
        accessTokenExpiresAt: number;
      };
    }
  }
}

export {};
