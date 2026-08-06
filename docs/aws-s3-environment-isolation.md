# AWS S3 Environment Isolation

BizReply uses separate private S3 buckets and separate IAM principals for each deployment environment. Application validation is defense in depth; IAM is the authoritative boundary that prevents one environment's credentials from accessing another environment's files.

## Required application configuration

Each deployment must set matching values:

```text
DEPLOYMENT_ENVIRONMENT=development|test|staging|production
AWS_S3_BUCKET_ENVIRONMENT=development|test|staging|production
AWS_S3_BUCKET=bizreply-<environment>-files-<account-id>-<region>
```

The API refuses to start with S3 enabled when:

- the two environment values differ;
- the bucket name does not contain the declared environment as a delimiter-separated token; or
- the bucket name contains identifiers for multiple environments.

`NODE_ENV` controls Node runtime behavior. `DEPLOYMENT_ENVIRONMENT` identifies the deployed infrastructure, so a staging deployment may use `NODE_ENV=production` and `DEPLOYMENT_ENVIRONMENT=staging`.

## IAM policy per environment

Create a distinct IAM role or user for each environment. Replace the placeholders below for development, then attach an equivalent policy with the appropriate bucket names to staging and production credentials.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowDevelopmentBucketMetadata",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation"
      ],
      "Resource": "arn:aws:s3:::bizreply-development-files-<account-id>-<region>"
    },
    {
      "Sid": "AllowDevelopmentObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::bizreply-development-files-<account-id>-<region>/*"
    },
    {
      "Sid": "DenyNonDevelopmentBizReplyBuckets",
      "Effect": "Deny",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::bizreply-production-files-<account-id>-<region>",
        "arn:aws:s3:::bizreply-production-files-<account-id>-<region>/*",
        "arn:aws:s3:::bizreply-staging-files-<account-id>-<region>",
        "arn:aws:s3:::bizreply-staging-files-<account-id>-<region>/*"
      ]
    }
  ]
}
```

For production credentials, invert the policy: allow only the production bucket and explicitly deny development, test, and staging buckets. Apply the same separation to CI credentials.

## Bucket controls

For every bucket:

- enable S3 Block Public Access at the account and bucket levels;
- disable ACL-based public access and keep object ownership enforced;
- require TLS with a bucket policy denying `aws:SecureTransport=false`;
- enable default server-side encryption;
- enable versioning where the retention and recovery policy requires it;
- never place AWS credentials or signed download URLs in frontend configuration.

Prefer workload IAM roles over long-lived access keys when the deployment platform supports them. If access keys are required, create environment-specific keys, store them only in the deployment secret manager, rotate them, and never reuse a principal across environments.
