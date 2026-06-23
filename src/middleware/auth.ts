import { MembershipStatus, UserStatus } from "@prisma/client";
import { RequestHandler } from "express";
import { JsonWebTokenError, NotBeforeError, TokenExpiredError } from "jsonwebtoken";
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
            business: { deletedAt: null },
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
    if (error instanceof AppError) return next(error);
    if (error instanceof JsonWebTokenError || error instanceof TokenExpiredError || error instanceof NotBeforeError) {
      return next(new AppError(401, "Invalid or expired access token", "INVALID_ACCESS_TOKEN"));
    }
    next(error);
  }
};

export const authenticateUser: RequestHandler = async (req, _res, next) => {
  try {
    const [scheme, token] = req.get("authorization")?.split(" ") ?? [];
    if (scheme !== "Bearer" || !token) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    const payload = tokenService.verifyAccessToken(token);
    if (typeof payload.exp !== "number") throw new AppError(401, "Invalid or expired access token", "INVALID_ACCESS_TOKEN");
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    req.auth = {
      userId: user.id,
      businessAccountId: null,
      businessId: null,
      membershipId: null,
      role: user.platformRole ?? null,
      accessTokenExpiresAt: payload.exp * 1000,
    };
    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    if (error instanceof JsonWebTokenError || error instanceof TokenExpiredError || error instanceof NotBeforeError) {
      return next(new AppError(401, "Invalid or expired access token", "INVALID_ACCESS_TOKEN"));
    }
    next(error);
  }
};
