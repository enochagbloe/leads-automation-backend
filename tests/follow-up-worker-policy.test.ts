import assert from "node:assert/strict";
import test from "node:test";
import { fairMergeBusinessIds } from "../src/services/follow-up/follow-up-worker-policy";

test("Premium continuation businesses receive capacity under scheduled-job load", () => {
  const selected = fairMergeBusinessIds([
    ["scheduled-1", "scheduled-2", "scheduled-3"],
    [],
    [],
    ["premium-continuation-1", "premium-continuation-2"],
  ], 2);

  assert.deepEqual(selected, ["scheduled-1", "premium-continuation-1"]);
});

test("rotating the starting source prevents starvation when the batch size is one", () => {
  const sources = [
    ["scheduled"],
    ["reconciliation"],
    ["pending-message"],
    ["premium-continuation"],
  ];
  const selections = [0, 1, 2, 3].map((cursor) => (
    fairMergeBusinessIds(sources, 1, cursor)[0]
  ));

  assert.deepEqual(selections, [
    "scheduled",
    "reconciliation",
    "pending-message",
    "premium-continuation",
  ]);
});

test("businesses present in several work sources are processed only once per tick", () => {
  assert.deepEqual(
    fairMergeBusinessIds([
      ["shared-business", "scheduled-only"],
      ["shared-business", "reconciliation-only"],
      [],
      ["shared-business", "continuation-only"],
    ], 10),
    [
      "shared-business",
      "reconciliation-only",
      "continuation-only",
      "scheduled-only",
    ],
  );
});
