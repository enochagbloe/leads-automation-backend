import { RequestHandler } from "express";
import { AuditAction } from "@prisma/client";
import { authService } from "../services/auth.service";
import { auditService } from "../services/audit.service";
import { tokenService } from "../services/token.service";
import { requestMetadata } from "../utils/request";

export const authController = {
  register: async (req, res) => res.status(201).json(await authService.register(req.body, requestMetadata(req))),
  verifyEmail: async (req, res) => res.json(await authService.verifyEmail(req.body.token, requestMetadata(req))),
  resendVerification: async (req, res) => res.json(await authService.resendVerification(req.body.email, requestMetadata(req))),
  login: async (req, res) => res.json(await authService.login(req.body.email, req.body.password, requestMetadata(req))),
  refresh: async (req, res) => res.json(await tokenService.rotateRefreshToken(req.body.refreshToken)),
  me: async (req, res) => res.json(await authService.getProfile(req.auth!.userId, req.get("x-business-id"))),
  logout: async (req, res) => {
    await tokenService.revokeRefreshToken(req.body.refreshToken);
    await auditService.log({ ...requestMetadata(req), action: AuditAction.USER_LOGOUT, userId: req.auth!.userId, businessId: req.auth!.businessId });
    res.json({ message: "Logged out successfully" });
  },
  forgotPassword: async (req, res) => res.json(await authService.forgotPassword(req.body.email, requestMetadata(req))),
  resetPassword: async (req, res) => res.json(await authService.resetPassword(req.body.token, req.body.password, requestMetadata(req))),
} satisfies Record<string, RequestHandler>;
