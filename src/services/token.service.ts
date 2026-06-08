import { AuthTokenType } from "@prisma/client";
import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { createOpaqueToken, hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";

export type AccessPayload = JwtPayload & { sub: string };

export const tokenService = {
  createAccessToken(userId: string) {
    return jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
      issuer: "bizreplyai",
      audience: "bizreplyai-api",
    });
  },

  verifyAccessToken(token: string) {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: "bizreplyai",
      audience: "bizreplyai-api",
    }) as AccessPayload;
  },

  async createRefreshToken(userId: string) {
    const token = jwt.sign({ sub: userId, type: "refresh" }, env.JWT_REFRESH_SECRET, {
      expiresIn: `${env.JWT_REFRESH_EXPIRES_IN_DAYS}d`,
      issuer: "bizreplyai",
      audience: "bizreplyai-refresh",
    });
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + env.JWT_REFRESH_EXPIRES_IN_DAYS * 86_400_000),
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
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!stored || stored.revokedAt || stored.expiresAt <= new Date() || stored.userId !== payload.sub) {
      throw new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
    }
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    return {
      accessToken: this.createAccessToken(stored.userId),
      refreshToken: await this.createRefreshToken(stored.userId),
    };
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
