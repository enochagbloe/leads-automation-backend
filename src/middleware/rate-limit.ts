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

export const aiPromptAutosaveLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.auth?.userId ?? "anonymous";
    const businessId = req.auth?.businessId ?? "no-business";
    const versionId = req.params.versionId ?? "no-version";
    return `ai-prompt-autosave:${userId}:${businessId}:${versionId}`;
  },
  message: {
    error: {
      code: "AI_PROMPT_AUTOSAVE_RATE_LIMITED",
      message: "Too many autosave requests. Please wait briefly and try again.",
    },
  },
});
