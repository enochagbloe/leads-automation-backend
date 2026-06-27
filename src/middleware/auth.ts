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
            business: { deletedAt: null },
            ...(requestedBusinessId ? { businessId: requestedBusinessId } : {}),
          },
          orderBy: { joinedAt: "asc" },
          ...(requestedBusinessId ? { take: 1 } : {}),
          include: { business: true },
        },
      },
    });
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) throw new AppError(401, "Authentication required", "UNAUTHENTICATED");
    const membership = user.memberships.find((item) => item.status === MembershipStatus.ACTIVE) ?? user.memberships[0];
    const role = user.platformRole ?? membership?.role;
    if (requestedBusinessId && !membership) throw new AppError(403, "You do not have access to this business", "BUSINESS_MEMBERSHIP_NOT_FOUND");
    if (membership?.status === MembershipStatus.INVITED) {
      throw new AppError(403, "You must accept the invitation before accessing this business.", "MEMBERSHIP_INVITE_NOT_ACCEPTED");
    }
    if (membership?.status === MembershipStatus.SUSPENDED_BY_PLAN) {
      throw new AppError(403, "Your access to this business is currently limited by your organization’s subscription plan. Contact your organization for further information.", "MEMBERSHIP_SUSPENDED_BY_PLAN");
    }
    if (membership?.status === MembershipStatus.DISABLED) {
      throw new AppError(403, "Your access to this business has been disabled. Contact your organization for further information.", "MEMBERSHIP_DISABLED");
    }
    if (membership?.status === MembershipStatus.REMOVED) {
      throw new AppError(403, "You do not have access to this business.", "MEMBERSHIP_REMOVED");
    }
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
