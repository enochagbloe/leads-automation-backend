import assert from "node:assert/strict";
import test from "node:test";
import { validateStorageEnvironment } from "../src/config/storage-environment-policy";

test("accepts a bucket whose declared and named environment matches the deployment", () => {
  assert.deepEqual(validateStorageEnvironment({
    deploymentEnvironment: "development",
    bucketEnvironment: "development",
    bucketName: "bizreply-development-files-401780891202-eu-central-1-an",
  }), []);
});

test("rejects a bucket declared for another deployment environment", () => {
  const issues = validateStorageEnvironment({
    deploymentEnvironment: "development",
    bucketEnvironment: "production",
    bucketName: "bizreply-production-files-401780891202-eu-central-1",
  });

  assert.ok(issues.some((issue) => issue.code === "STORAGE_BUCKET_ENVIRONMENT_MISMATCH"));
});

test("rejects a bucket name without the declared environment token", () => {
  const issues = validateStorageEnvironment({
    deploymentEnvironment: "production",
    bucketEnvironment: "production",
    bucketName: "bizreply-files-401780891202-eu-central-1",
  });

  assert.ok(issues.some((issue) => issue.code === "STORAGE_BUCKET_NAME_ENVIRONMENT_MISMATCH"));
});

test("rejects bucket names containing more than one environment identity", () => {
  const issues = validateStorageEnvironment({
    deploymentEnvironment: "production",
    bucketEnvironment: "production",
    bucketName: "bizreply-development-production-files",
  });

  assert.ok(issues.some((issue) => issue.code === "STORAGE_BUCKET_NAME_AMBIGUOUS_ENVIRONMENT"));
});

test("requires an explicit bucket environment for S3", () => {
  const issues = validateStorageEnvironment({
    deploymentEnvironment: "staging",
    bucketName: "bizreply-staging-files",
  });

  assert.deepEqual(issues.map((issue) => issue.code), ["STORAGE_BUCKET_ENVIRONMENT_REQUIRED"]);
});
