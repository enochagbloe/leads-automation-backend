import assert from "node:assert/strict";
import test from "node:test";
import { detectCustomerWhatsAppConsentSignal } from "../src/services/customer-contact-consent.service";

test("explicit customer stop requests are classified as opt-out", () => {
  const messages = [
    "Stop messaging me",
    "Do not contact me again",
    "Remove my number",
    "Unsubscribe",
    "I am not interested.",
    "I withdraw my consent to messages",
    "Do\u200B not\ncontact me again",
  ];

  for (const message of messages) {
    assert.equal(detectCustomerWhatsAppConsentSignal(message), "OPT_OUT", message);
  }
});

test("only explicit renewed consent clears an opt-out", () => {
  const messages = [
    "Please message me again",
    "You can contact me again",
    "Resubscribe",
    "Opt me in",
    "I consent to being contacted",
  ];

  for (const message of messages) {
    assert.equal(detectCustomerWhatsAppConsentSignal(message), "OPT_IN", message);
  }
});

test("ordinary positive replies do not change durable consent", () => {
  const messages = [
    "Yes, that appointment works for me",
    "Thanks for the information",
    "I am interested in the premium service",
    "Please send the quotation",
  ];

  for (const message of messages) {
    assert.equal(detectCustomerWhatsAppConsentSignal(message), null, message);
  }
});

test("a conflicting message fails closed as opt-out", () => {
  assert.equal(
    detectCustomerWhatsAppConsentSignal("Subscribe me, but stop messaging me"),
    "OPT_OUT",
  );
});
