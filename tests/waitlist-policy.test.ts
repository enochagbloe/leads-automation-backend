import assert from "node:assert/strict";
import test from "node:test";
import { waitlistConfirmationSchema, waitlistSignupSchema } from "../src/validation/waitlist.schemas";
import { hashWaitlistConfirmationToken, waitlistResendAllowed } from "../src/services/waitlist.service";

test("waitlist signup normalizes email and sanitizes text", () => {
  const parsed = waitlistSignupSchema.parse({
    name: "  Ama\n Mensah  ",
    email: " AMA@Example.COM ",
    businessName: " Ama   Consulting ",
    whatsapp: "+233244001122",
  });

  assert.equal(parsed.name, "Ama Mensah");
  assert.equal(parsed.email, "ama@example.com");
  assert.equal(parsed.businessName, "Ama Consulting");
  assert.equal(parsed.marketingConsent, false);
});

test("waitlist input rejects unknown fields and invalid WhatsApp numbers", () => {
  assert.equal(waitlistSignupSchema.safeParse({ name: "Ama", email: "ama@example.com", admin: true }).success, false);
  assert.equal(waitlistSignupSchema.safeParse({ name: "Ama", email: "ama@example.com", whatsapp: "0244001122" }).success, false);
});

test("confirmation tokens are validated and hashed deterministically", () => {
  const token = "a".repeat(64);
  assert.equal(waitlistConfirmationSchema.parse({ token }).token, token);
  assert.equal(hashWaitlistConfirmationToken(token), hashWaitlistConfirmationToken(token));
  assert.notEqual(hashWaitlistConfirmationToken(token), token);
});

test("resend cooldown blocks rapid repeated confirmation requests", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  assert.equal(waitlistResendAllowed(null, now), true);
  assert.equal(waitlistResendAllowed(new Date("2026-08-20T11:59:30.000Z"), now), false);
  assert.equal(waitlistResendAllowed(new Date("2026-08-20T11:58:00.000Z"), now), true);
});
