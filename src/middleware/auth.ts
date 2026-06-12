import { MembershipStatus, UserStatus } from "@prisma/client";
import { RequestHandler } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { tokenService } from "../services/token.service";

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const [scheme, token] = req.get("authorization")?.split(" ") ?? [];
    if (scheme !== "Bearer" || !token) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    const payload = tokenService.verifyAccessToken(token);
    if (typeof payload.exp !== "number") throw new AppError(401, "Invalid or expired access token", "INVALID_ACCESS_TOKEN");
    const requestedBusinessId = req.get("x-business-id");
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        memberships: {
          where: {
            status: MembershipStatus.ACTIVE,
            ...(requestedBusinessId ? { businessId: requestedBusinessId } : {}),
          },
          orderBy: { joinedAt: "asc" },
          take: 1,
          include: { business: true },
        },
      },
    });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    const membership = user.memberships[0];
    const role = user.platformRole ?? membership?.role;
    if (requestedBusinessId && !membership) throw new AppError(403, "You do not have access to this business", "BUSINESS_ACCESS_DENIED");
    if (!role) throw new AppError(403, "No role assigned", "FORBIDDEN");
    req.auth = {
      userId: user.id,
      businessAccountId: membership?.business.businessAccountId ?? null,
      businessId: membership?.businessId ?? null,
      membershipId: membership?.id ?? null,
      role,
      accessTokenExpiresAt: payload.exp * 1000,
    };
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError(401, "Invalid or expired access token", "INVALID_ACCESS_TOKEN"));
  }
};
