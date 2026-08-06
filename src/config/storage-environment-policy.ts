export const STORAGE_ENVIRONMENTS = ["development", "test", "staging", "production"] as const;

export type StorageEnvironment = (typeof STORAGE_ENVIRONMENTS)[number];

export type StorageEnvironmentPolicyIssue = {
  code:
    | "STORAGE_BUCKET_ENVIRONMENT_REQUIRED"
    | "STORAGE_BUCKET_ENVIRONMENT_MISMATCH"
    | "STORAGE_BUCKET_NAME_ENVIRONMENT_MISMATCH"
    | "STORAGE_BUCKET_NAME_AMBIGUOUS_ENVIRONMENT";
  field: "AWS_S3_BUCKET" | "AWS_S3_BUCKET_ENVIRONMENT";
  message: string;
};

function environmentTokens(bucketName: string) {
  const tokens = new Set(bucketName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return STORAGE_ENVIRONMENTS.filter((environment) => tokens.has(environment));
}

export function validateStorageEnvironment(input: {
  deploymentEnvironment: StorageEnvironment;
  bucketEnvironment?: StorageEnvironment;
  bucketName: string;
}): StorageEnvironmentPolicyIssue[] {
  if (!input.bucketEnvironment) {
    return [{
      code: "STORAGE_BUCKET_ENVIRONMENT_REQUIRED",
      field: "AWS_S3_BUCKET_ENVIRONMENT",
      message: "AWS_S3_BUCKET_ENVIRONMENT is required when S3 storage is enabled",
    }];
  }

  const issues: StorageEnvironmentPolicyIssue[] = [];
  if (input.bucketEnvironment !== input.deploymentEnvironment) {
    issues.push({
      code: "STORAGE_BUCKET_ENVIRONMENT_MISMATCH",
      field: "AWS_S3_BUCKET_ENVIRONMENT",
      message: `The ${input.deploymentEnvironment} deployment cannot use a bucket declared for ${input.bucketEnvironment}`,
    });
  }

  const tokens = environmentTokens(input.bucketName);
  if (!tokens.includes(input.bucketEnvironment)) {
    issues.push({
      code: "STORAGE_BUCKET_NAME_ENVIRONMENT_MISMATCH",
      field: "AWS_S3_BUCKET",
      message: `AWS_S3_BUCKET must contain the declared environment token "${input.bucketEnvironment}"`,
    });
  }
  if (tokens.some((environment) => environment !== input.bucketEnvironment)) {
    issues.push({
      code: "STORAGE_BUCKET_NAME_AMBIGUOUS_ENVIRONMENT",
      field: "AWS_S3_BUCKET",
      message: "AWS_S3_BUCKET must not contain identifiers for multiple deployment environments",
    });
  }

  return issues;
}
