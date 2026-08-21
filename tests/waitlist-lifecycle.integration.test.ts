import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { WaitlistStatus } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { emailService } from "../src/services/email.service";
import { hashWaitlistConfirmationToken, waitlistService } from "../src/services/waitlist.service";

const run = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? test : test.skip;

run("waitlist immediate confirmation is duplicate-safe and recovers email delivery", async () => {
  const email = `waitlist-${crypto.randomUUID()}@example.com`;
  const retryEmail = `waitlist-retry-${crypto.randomUUID()}@example.com`;
  const legacyEmail = `waitlist-legacy-${crypto.randomUUID()}@example.com`;
  const welcomeEmails: string[] = [];
  const originalSender = emailService.sendWaitlistWelcome;
  emailService.sendWaitlistWelcome = async (to) => {
    welcomeEmails.push(to);
    return true;
  };

  try {
    const input = {
      name: "Ama Mensah",
      email,
      businessName: "Ama Consulting",
      marketingConsent: true,
    };
    const responses = await Promise.all([
      waitlistService.signup(input),
      waitlistService.signup(input),
    ]);
    assert.equal(responses.every((response) => response.success), true);
    assert.equal(welcomeEmails.length, 1);

    const entries = await prisma.waitlistEntry.findMany({ where: { email } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, WaitlistStatus.CONFIRMED);
    assert.equal(entries[0]?.confirmationTokenHash, null);
    assert.equal(entries[0]?.confirmationExpiresAt, null);
    const stored = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email } });
    assert.equal(stored.status, WaitlistStatus.CONFIRMED);
    assert.ok(stored.confirmedAt);
    assert.ok(stored.welcomeEmailSentAt);
    assert.equal(stored.confirmationTokenHash, null);
    assert.equal(stored.confirmationExpiresAt, null);

    const duplicate = await waitlistService.signup(input);
    assert.match(duplicate.message, /already/i);
    assert.equal(welcomeEmails.length, 1);

    const unknownResend = await waitlistService.resend(`unknown-${crypto.randomUUID()}@example.com`);
    assert.match(unknownResend.message, /if this email/i);

    emailService.sendWaitlistWelcome = async () => false;
    await waitlistService.signup({ name: "Failed Email", email: retryEmail, marketingConsent: false });
    const failedDelivery = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: retryEmail } });
    assert.equal(failedDelivery.status, WaitlistStatus.CONFIRMED);
    assert.equal(failedDelivery.welcomeEmailRequestedAt, null);
    assert.equal(failedDelivery.welcomeEmailSentAt, null);

    emailService.sendWaitlistWelcome = async () => true;
    await waitlistService.signup({ name: "Failed Email", email: retryEmail, marketingConsent: false });
    const retriedDelivery = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: retryEmail } });
    assert.ok(retriedDelivery.welcomeEmailSentAt);

    const legacyToken = crypto.randomBytes(32).toString("hex");
    await prisma.waitlistEntry.create({
      data: {
        name: "Legacy Pending",
        email: legacyEmail,
        status: WaitlistStatus.PENDING,
        confirmationTokenHash: hashWaitlistConfirmationToken(legacyToken),
        confirmationExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await waitlistService.confirm(legacyToken);
    const legacyConfirmed = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email: legacyEmail } });
    assert.equal(legacyConfirmed.status, WaitlistStatus.CONFIRMED);
    assert.equal(legacyConfirmed.confirmationTokenHash, null);
    assert.ok(legacyConfirmed.welcomeEmailSentAt);
  } finally {
    emailService.sendWaitlistWelcome = originalSender;
    await prisma.waitlistEntry.deleteMany({ where: { email: { in: [email, retryEmail, legacyEmail] } } });
    await prisma.$disconnect();
  }
});
