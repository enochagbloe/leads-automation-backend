import { z } from "zod";

const password = z
  .string()
  .min(10)
  .max(128)
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^A-Za-z0-9]/, "Password must contain a special character");

export const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password,
  businessName: z.string().trim().min(2).max(120),
  industry: z.string().trim().min(2).max(120),
});

export const loginSchema = z.object({
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(128),
});

export const emailSchema = z.object({
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
});

export const tokenSchema = z.object({ token: z.string().min(32).max(256) });
export const resetPasswordSchema = tokenSchema.extend({ password });
export const logoutSchema = z.object({ refreshToken: z.string().min(1) });

export const inviteMemberSchema = z.object({
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  role: z.enum(["MANAGER", "STAFF"]),
});

export const acceptInvitationSchema = tokenSchema.extend({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  password: password.optional(),
});
