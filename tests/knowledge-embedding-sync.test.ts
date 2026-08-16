import assert from "node:assert/strict";
import test from "node:test";
import { prepareAndReplaceEmbeddingBatch } from "../src/services/knowledge-embedding.service";

test("failed document embedding preparation preserves the existing set", async () => {
  const existing = ["old-1", "old-2"];
  let replacements = 0;

  await assert.rejects(
    prepareAndReplaceEmbeddingBatch({
      items: ["new-1", "new-2", "new-3"],
      prepare: async (item) => item === "new-2" ? null : `prepared:${item}`,
      replace: async (prepared) => {
        replacements += 1;
        existing.splice(0, existing.length, ...prepared);
      },
      failure: () => new Error("provider failed"),
    }),
    /provider failed/,
  );

  assert.equal(replacements, 0);
  assert.deepEqual(existing, ["old-1", "old-2"]);
});

test("complete document embedding preparation replaces the set once", async () => {
  const existing = ["old-1", "old-2"];
  let replacements = 0;

  await prepareAndReplaceEmbeddingBatch({
    items: ["new-1", "new-2"],
    prepare: async (item) => `prepared:${item}`,
    replace: async (prepared) => {
      replacements += 1;
      existing.splice(0, existing.length, ...prepared);
    },
    failure: () => new Error("provider failed"),
  });

  assert.equal(replacements, 1);
  assert.deepEqual(existing, ["prepared:new-1", "prepared:new-2"]);
});
