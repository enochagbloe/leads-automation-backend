import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { WaitlistStatus } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { emailService } from "../src/services/email.service";
import { hashWaitlistConfirmationToken, waitlistService } from "../src/services/waitlist.service";

const run = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? test : test.skip;

run("waitlist signup and confirmation are duplicate-safe and store no raw token", async () => {
  const email = `waitlist-${crypto.randomUUID()}@example.com`;
  const sentTokens: string[] = [];
  const originalSender = emailService.sendWaitlistConfirmation;
  emailService.sendWaitlistConfirmation = async (_to, _name, token) => {
    sentTokens.push(token);
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
    assert.equal(sentTokens.length, 1);

    const entries = await prisma.waitlistEntry.findMany({ where: { email } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.status, WaitlistStatus.PENDING);
    assert.equal(entries[0]?.confirmationTokenHash, hashWaitlistConfirmationToken(sentTokens[0]!));
    assert.notEqual(entries[0]?.confirmationTokenHash, sentTokens[0]);

    const confirmed = await waitlistService.confirm(sentTokens[0]!);
    assert.equal(confirmed.success, true);
    const stored = await prisma.waitlistEntry.findUniqueOrThrow({ where: { email } });
    assert.equal(stored.status, WaitlistStatus.CONFIRMED);
    assert.ok(stored.confirmedAt);
    assert.equal(stored.confirmationTokenHash, null);
    assert.equal(stored.confirmationExpiresAt, null);

    const duplicate = await waitlistService.signup(input);
    assert.match(duplicate.message, /already/i);
    assert.equal(sentTokens.length, 1);

    const unknownResend = await waitlistService.resend(`unknown-${crypto.randomUUID()}@example.com`);
    assert.match(unknownResend.message, /if this email/i);
  } finally {
    emailService.sendWaitlistConfirmation = originalSender;
    await prisma.waitlistEntry.deleteMany({ where: { email } });
    await prisma.$disconnect();
  }
});
