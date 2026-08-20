import crypto from "node:crypto";
import { WaitlistStatus } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { emailService } from "./email.service";

const SIGNUP_MESSAGE = "Check your email to confirm your waitlist spot.";
const RESEND_MESSAGE = "If this email is on the waitlist, a confirmation email has been sent.";
const CONFIRMED_MESSAGE = "Your email has been confirmed. You're now on the BizReply waitlist.";

type SignupInput = {
  name: string;
  email: string;
  businessName?: string;
  businessType?: string;
  whatsapp?: string;
  problem?: string;
  source?: string;
  marketingConsent: boolean;
};

export function hashWaitlistConfirmationToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function waitlistConfirmationWindow(now = new Date()) {
  return new Date(now.getTime() + env.WAITLIST_CONFIRMATION_EXPIRY_HOURS * 60 * 60 * 1_000);
}

export function waitlistResendAllowed(lastRequestedAt: Date | null, now = new Date()) {
  return !lastRequestedAt
    || now.getTime() - lastRequestedAt.getTime() >= env.WAITLIST_RESEND_COOLDOWN_SECONDS * 1_000;
}

function tokenPair() {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, tokenHash: hashWaitlistConfirmationToken(token) };
}

async function issueConfirmation(input: {
  email: string;
  signup?: SignupInput;
  genericResponse: boolean;
}) {
  const now = new Date();
  const issued = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('public_waitlist'), hashtext(${input.email}))`;
    const existing = await tx.waitlistEntry.findUnique({ where: { email: input.email } });

    if (!existing && !input.signup) return null;
    if (existing?.status === WaitlistStatus.CONFIRMED) return { alreadyConfirmed: true as const };
    if (existing && !waitlistResendAllowed(existing.confirmationRequestedAt, now)) {
      return { cooldown: true as const };
    }

    const { token, tokenHash } = tokenPair();
    const tokenData = {
      status: WaitlistStatus.PENDING,
      confirmationTokenHash: tokenHash,
      confirmationExpiresAt: waitlistConfirmationWindow(now),
      confirmationRequestedAt: now,
      confirmedAt: null,
    };
    const entry = existing
      ? await tx.waitlistEntry.update({
          where: { id: existing.id },
          data: {
            ...tokenData,
            ...(input.signup ? {
              name: input.signup.name,
              businessName: input.signup.businessName ?? null,
              businessType: input.signup.businessType ?? null,
              whatsapp: input.signup.whatsapp ?? null,
              problem: input.signup.problem ?? null,
              source: input.signup.source ?? null,
              marketingConsent: input.signup.marketingConsent,
            } : {}),
          },
        })
      : await tx.waitlistEntry.create({
          data: {
            ...input.signup!,
            ...tokenData,
            businessName: input.signup!.businessName ?? null,
            businessType: input.signup!.businessType ?? null,
            whatsapp: input.signup!.whatsapp ?? null,
            problem: input.signup!.problem ?? null,
            source: input.signup!.source ?? null,
          },
        });
    return { entry, token, tokenHash };
  }, { maxWait: 10_000, timeout: 20_000 });

  if (!issued || "cooldown" in issued) return { success: true, message: input.genericResponse ? RESEND_MESSAGE : SIGNUP_MESSAGE };
  if ("alreadyConfirmed" in issued) {
    return {
      success: true,
      message: input.genericResponse ? RESEND_MESSAGE : "You're already on the BizReply waitlist.",
    };
  }

  const sent = await emailService.sendWaitlistConfirmation(issued.entry.email, issued.entry.name, issued.token);
  if (!sent) {
    await prisma.waitlistEntry.updateMany({
      where: {
        id: issued.entry.id,
        status: WaitlistStatus.PENDING,
        confirmationTokenHash: issued.tokenHash,
      },
      data: { confirmationRequestedAt: null },
    }).catch((error) => console.error("Waitlist email failure recovery failed", {
      entryId: issued.entry.id,
      error: error instanceof Error ? error.message : "Unknown database error",
    }));
    throw new AppError(503, "Confirmation email could not be sent. Please try again.", "WAITLIST_EMAIL_DELIVERY_FAILED");
  }

  return { success: true, message: input.genericResponse ? RESEND_MESSAGE : SIGNUP_MESSAGE };
}

export const waitlistService = {
  signup(input: SignupInput) {
    return issueConfirmation({ email: input.email, signup: input, genericResponse: false });
  },

  resend(email: string) {
    return issueConfirmation({ email, genericResponse: true });
  },

  async confirm(token: string) {
    const tokenHash = hashWaitlistConfirmationToken(token);
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('public_waitlist_token'), hashtext(${tokenHash}))`;
      const entry = await tx.waitlistEntry.findUnique({ where: { confirmationTokenHash: tokenHash } });
      if (!entry) throw new AppError(400, "This confirmation link is invalid.", "WAITLIST_CONFIRMATION_INVALID");
      if (entry.status === WaitlistStatus.CONFIRMED) return { success: true, message: CONFIRMED_MESSAGE };
      if (!entry.confirmationExpiresAt || entry.confirmationExpiresAt <= now) {
        throw new AppError(410, "This confirmation link has expired. Request a new confirmation email.", "WAITLIST_CONFIRMATION_EXPIRED");
      }
      if (entry.status !== WaitlistStatus.PENDING) {
        throw new AppError(409, "This waitlist entry cannot be confirmed.", "WAITLIST_CONFIRMATION_NOT_ALLOWED");
      }

      const changed = await tx.waitlistEntry.updateMany({
        where: {
          id: entry.id,
          status: WaitlistStatus.PENDING,
          confirmationTokenHash: tokenHash,
          confirmationExpiresAt: { gt: now },
        },
        data: {
          status: WaitlistStatus.CONFIRMED,
          confirmedAt: now,
          confirmationTokenHash: null,
          confirmationExpiresAt: null,
        },
      });
      if (changed.count !== 1) {
        throw new AppError(409, "The waitlist entry changed. Please try again.", "WAITLIST_CONFIRMATION_STATE_CHANGED");
      }
      return { success: true, message: CONFIRMED_MESSAGE };
    }, { maxWait: 10_000, timeout: 20_000 });
  },
};
