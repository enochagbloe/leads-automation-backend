import rateLimit from "express-rate-limit";

const buildLimiter = (limit: number, windowMs = 15 * 60 * 1000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
  });

export const registrationLimiter = buildLimiter(10, 60 * 60 * 1000);
export const loginLimiter = buildLimiter(10);
export const emailLimiter = buildLimiter(5, 60 * 60 * 1000);
export const passwordResetLimiter = buildLimiter(5, 60 * 60 * 1000);
export const mutationLimiter = buildLimiter(120);
