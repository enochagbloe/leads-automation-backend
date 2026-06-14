import { AuthTokenType, UserStatus } from "@prisma/client";
import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { createOpaqueToken, hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";

export type AccessPayload = JwtPayload & { sub: string };

function signAccessToken(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    issuer: "bizreplyai",
    audience: "bizreplyai-api",
  });
}

function signRefreshToken(userId: string) {
  return {
    token: jwt.sign({ sub: userId, type: "refresh" }, env.JWT_REFRESH_SECRET, {
      expiresIn: `${env.JWT_REFRESH_EXPIRES_IN_DAYS}d`,
      issuer: "bizreplyai",
      audience: "bizreplyai-refresh",
    }),
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400_000),
  };
}

export const tokenService = {
  createAccessToken(userId: string) {
    return signAccessToken(userId);
  },

  verifyAccessToken(token: string) {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: "bizreplyai",
      audience: "bizreplyai-api",
    }) as AccessPayload;
  },

  async createRefreshToken(userId: string) {
    const { token, expiresAt } = signRefreshToken(userId);
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
    return token;
  },

  async rotateRefreshToken(token: string) {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_REFRESH_SECRET, {
        issuer: "bizreplyai",
        audience: "bizreplyai-refresh",
      }) as JwtPayload;
    } catch {
      throw new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
    }
    if (typeof payload.sub !== "string") {
      throw new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
    }
    const tokenHash = hashToken(token);
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { status: true, deletedAt: true } } },
      });
      if (
        !stored
        || stored.revokedAt
        || stored.expiresAt <= now
        || stored.userId !== payload.sub
        || stored.user.status !== UserStatus.ACTIVE
        || stored.user.deletedAt
      ) {
        throw new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
      }
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      if (claimed.count !== 1) throw new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");

      const next = signRefreshToken(stored.userId);
      await tx.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: hashToken(next.token),
          expiresAt: next.expiresAt,
        },
      });
      return {
        accessToken: signAccessToken(stored.userId),
        refreshToken: next.token,
      };
    });
  },

  async revokeRefreshToken(token: string) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async createAuthToken(userId: string, type: AuthTokenType, expiresInMs: number) {
    const { token, tokenHash } = createOpaqueToken();
    await prisma.$transaction([
      prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.authToken.create({ data: { userId, type, tokenHash, expiresAt: new Date(Date.now() + expiresInMs) } }),
    ]);
    return token;
  },
};
