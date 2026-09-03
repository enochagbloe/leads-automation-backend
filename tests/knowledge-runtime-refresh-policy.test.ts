import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeRuntimeRefreshDisposition } from "../src/services/knowledge-document/knowledge-runtime-refresh.service";

const completedInput = {
  requestedRevision: 2,
  processingRevision: 2,
  attemptCount: 1,
  maximumAttempts: 5,
  cacheInvalidated: true,
  embeddingsSynced: true,
};

test("runtime refresh completes only after both durable checkpoints", () => {
  assert.equal(knowledgeRuntimeRefreshDisposition(completedInput), "COMPLETE");
  assert.equal(knowledgeRuntimeRefreshDisposition({ ...completedInput, embeddingsSynced: false }), "RETRY");
  assert.equal(knowledgeRuntimeRefreshDisposition({ ...completedInput, cacheInvalidated: false }), "RETRY");
});

test("a newer governance revision is rescheduled even when the current pass succeeded", () => {
  assert.equal(knowledgeRuntimeRefreshDisposition({
    ...completedInput,
    requestedRevision: 3,
  }), "RESCHEDULE");
});

test("runtime refresh becomes exhausted only at the configured attempt limit", () => {
  assert.equal(knowledgeRuntimeRefreshDisposition({
    ...completedInput,
    embeddingsSynced: false,
    attemptCount: 4,
  }), "RETRY");
  assert.equal(knowledgeRuntimeRefreshDisposition({
    ...completedInput,
    embeddingsSynced: false,
    attemptCount: 5,
  }), "EXHAUST");
});
