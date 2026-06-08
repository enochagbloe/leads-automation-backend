import { Router } from "express";
import { authController } from "../controllers/auth.controller";
import { authenticate } from "../middleware/auth";
import { emailLimiter, loginLimiter, passwordResetLimiter, registrationLimiter } from "../middleware/rate-limit";
import { validate } from "../middleware/validate";
import { emailSchema, loginSchema, logoutSchema, registerSchema, resetPasswordSchema, tokenSchema } from "../validation/auth.schemas";

export const authRouter = Router();

authRouter.post("/register", registrationLimiter, validate(registerSchema), authController.register);
authRouter.post("/login", loginLimiter, validate(loginSchema), authController.login);
authRouter.post("/refresh", loginLimiter, validate(logoutSchema), authController.refresh);
authRouter.post("/logout", authenticate, validate(logoutSchema), authController.logout);
authRouter.get("/me", authenticate, authController.me);
authRouter.post("/verify-email", emailLimiter, validate(tokenSchema), authController.verifyEmail);
authRouter.post("/resend-verification", emailLimiter, validate(emailSchema), authController.resendVerification);
authRouter.post("/forgot-password", passwordResetLimiter, validate(emailSchema), authController.forgotPassword);
authRouter.post("/reset-password", passwordResetLimiter, validate(resetPasswordSchema), authController.resetPassword);
