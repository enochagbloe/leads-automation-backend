import assert from "node:assert/strict";
import test from "node:test";
import { isDatabaseUnavailableError } from "../src/utils/database-error";

test("transaction acquisition failures are treated as database unavailable", () => {
  assert.equal(isDatabaseUnavailableError({
    code: "P2028",
    meta: { error: "Unable to start a transaction in the given time." },
  }), true);
});

test("transactions lost after disconnect are treated as database unavailable", () => {
  assert.equal(isDatabaseUnavailableError({
    code: "P2028",
    meta: { error: "Transaction not found. Transaction ID was obtained before disconnecting." },
  }), true);
});

test("application transaction timeouts remain visible as code errors", () => {
  assert.equal(isDatabaseUnavailableError({
    code: "P2028",
    meta: { error: "Transaction already closed: A query cannot be executed after timeout." },
  }), false);
});
