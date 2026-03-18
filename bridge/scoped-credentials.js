/**
 * Scoped S3 Credentials — Per-user IAM isolation via STS session policies.
 *
 * Creates STS AssumeRole session credentials that restrict S3 access to
 * a single user's namespace prefix. Prevents cross-user data access even
 * if the agent's bash/code execution tools are used to call the AWS CLI/SDK.
 *
 * Usage:
 *   const { createScopedCredentials, writeCredentialFiles } = require("./scoped-credentials");
 *   const creds = await createScopedCredentials(namespace);
 *   writeCredentialFiles(creds, "/tmp/scoped");
 */

const fs = require("fs");
const path = require("path");

const VALID_NAMESPACE = /^[a-zA-Z][a-zA-Z0-9_-]{1,64}$/;

/**
 * Build an IAM session policy JSON string that scopes S3 access to a user's namespace.
 *
 * @param {object} opts
 * @param {string} opts.bucket - S3 bucket name
 * @param {string} opts.namespace - User namespace (e.g. "telegram_12345")
 * @param {string} [opts.cmkArn] - KMS CMK ARN for encrypted bucket
 * @param {string} [opts.eventbridgeRoleArn] - EventBridge scheduler role ARN for iam:PassRole
 * @param {string} [opts.identityTableArn] - DynamoDB identity table ARN (scopes DynamoDB access)
 * @param {string} [opts.scheduleGroupArn] - EventBridge schedule group ARN (scopes scheduler access)
 * @returns {string} JSON policy document
 */
function buildSessionPolicy({ bucket, namespace, cmkArn, eventbridgeRoleArn, identityTableArn, scheduleGroupArn }) {
  if (!namespace || !VALID_NAMESPACE.test(namespace)) {
    throw new Error(
      `Invalid namespace "${namespace}" — must match ${VALID_NAMESPACE}`,
    );
  }

  // EventBridge Scheduler resources:
  // - CRUD actions (Create/Update/Delete/Get) operate on individual schedules
  //   ARN format: arn:aws:scheduler:REGION:ACCOUNT:schedule/GROUP/SCHEDULE
  // - ListSchedules operates on the schedule-group resource
  const scheduleCrudArn = scheduleGroupArn
    ? scheduleGroupArn.replace(":schedule-group/", ":schedule/") + "/*"
    : "*";
  const scheduleListArn = scheduleGroupArn || "*";

  // DynamoDB resources: table + GSI indexes
  const dynamoResources = identityTableArn
    ? [identityTableArn, `${identityTableArn}/index/*`]
    : "*";

  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "S3ObjectAccess",
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:AbortMultipartUpload",
        ],
        Resource: `arn:aws:s3:::${bucket}/${namespace}/*`,
      },
      {
        Sid: "S3ListBucket",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: {
          StringLike: {
            "s3:prefix": [`${namespace}/*`, `${namespace}`],
          },
        },
      },
      // KMS — only included when cmkArn is set (always set by CDK in production)
      ...(cmkArn ? [{
        Sid: "KMSDecrypt",
        Effect: "Allow",
        Action: ["kms:Decrypt", "kms:GenerateDataKey", "kms:GenerateDataKeyWithoutPlaintext"],
        Resource: cmkArn,
      }] : []),
      // EventBridge cron skill — CRUD scoped to schedule group's schedules
      {
        Sid: "EventBridgeSchedulerCRUD",
        Effect: "Allow",
        Action: [
          "scheduler:CreateSchedule",
          "scheduler:UpdateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
        ],
        Resource: scheduleCrudArn,
      },
      // EventBridge — ListSchedules operates on the schedule-group resource
      {
        Sid: "EventBridgeSchedulerList",
        Effect: "Allow",
        Action: "scheduler:ListSchedules",
        Resource: scheduleListArn,
      },
      // DynamoDB identity table (scoped to table + GSI indexes)
      {
        Sid: "DynamoDBIdentity",
        Effect: "Allow",
        Action: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ],
        Resource: dynamoResources,
      },
      // PassRole scoped to EventBridge scheduler role (prevents privilege escalation)
      ...(eventbridgeRoleArn ? [{
        Sid: "IAMPassRole",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: eventbridgeRoleArn,
      }] : []),
    ],
  };

  return JSON.stringify(policy);
}

/**
 * Create scoped S3 credentials via STS AssumeRole with a session policy.
 *
 * @param {string} namespace - User namespace (e.g. "telegram_12345")
 * @param {object} [opts] - Options
 * @param {object} [opts.stsClient] - Pre-configured STS client (for testing)
 * @returns {Promise<{accessKeyId: string, secretAccessKey: string, sessionToken: string, expiration: Date}>}
 */
async function createScopedCredentials(namespace, opts = {}) {
  const bucket = process.env.S3_USER_FILES_BUCKET;
  const roleArn = process.env.EXECUTION_ROLE_ARN;
  const cmkArn = process.env.CMK_ARN;
  const eventbridgeRoleArn = process.env.EVENTBRIDGE_ROLE_ARN;
  const region = process.env.AWS_REGION;

  if (!bucket) {
    throw new Error("createScopedCredentials: S3_USER_FILES_BUCKET is required");
  }
  if (!roleArn) {
    throw new Error("createScopedCredentials: EXECUTION_ROLE_ARN is required");
  }

  // Extract account ID from role ARN (arn:aws:iam::ACCOUNT:role/NAME)
  const arnParts = roleArn.split(":");
  const account = arnParts.length >= 5 ? arnParts[4] : null;

  // Construct scoped resource ARNs when account and region are available
  const identityTableName = process.env.IDENTITY_TABLE_NAME;
  const scheduleGroup = process.env.EVENTBRIDGE_SCHEDULE_GROUP;

  const identityTableArn = (account && region && identityTableName)
    ? `arn:aws:dynamodb:${region}:${account}:table/${identityTableName}`
    : undefined;
  const scheduleGroupArn = (account && region && scheduleGroup)
    ? `arn:aws:scheduler:${region}:${account}:schedule-group/${scheduleGroup}`
    : undefined;

  const sessionPolicy = buildSessionPolicy({
    bucket, namespace, cmkArn, eventbridgeRoleArn,
    identityTableArn, scheduleGroupArn,
  });

  const commandInput = {
    RoleArn: roleArn,
    RoleSessionName: `scoped-${namespace}`.slice(0, 64),
    DurationSeconds: 3600, // Max for self-assume (role chaining)
    Policy: sessionPolicy,
  };

  let stsClient = opts.stsClient;
  let command;

  if (stsClient) {
    // Mock/test path — use plain object with input property (avoids SDK require)
    command = { input: commandInput };
  } else {
    // Production path — use real STS SDK
    const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");
    stsClient = new STSClient({ region: process.env.AWS_REGION });
    command = new AssumeRoleCommand(commandInput);
  }

  const resp = await stsClient.send(command);

  return {
    accessKeyId: resp.Credentials.AccessKeyId,
    secretAccessKey: resp.Credentials.SecretAccessKey,
    sessionToken: resp.Credentials.SessionToken,
    expiration: resp.Credentials.Expiration,
  };
}

/**
 * Write credential files for AWS SDK credential_process integration.
 *
 * Creates two files:
 * - scoped-creds.json: Credential process output format (Version 1)
 * - scoped-aws-config: AWS config file with credential_process directive
 *
 * @param {object} creds - Credentials from createScopedCredentials()
 * @param {string} dir - Directory to write files in
 */
function writeCredentialFiles(creds, dir) {
  fs.mkdirSync(dir, { recursive: true });

  const credsJson = {
    Version: 1,
    AccessKeyId: creds.accessKeyId,
    SecretAccessKey: creds.secretAccessKey,
    SessionToken: creds.sessionToken,
    Expiration: creds.expiration instanceof Date
      ? creds.expiration.toISOString()
      : creds.expiration,
  };

  // Atomic write: write to .tmp then rename — prevents credential_process
  // from reading a partially-written file during refresh.
  const credsPath = path.join(dir, "scoped-creds.json");
  const credsTmp = credsPath + ".tmp";
  fs.writeFileSync(credsTmp, JSON.stringify(credsJson, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(credsTmp, credsPath);

  const configContent = [
    "[default]",
    `credential_process = /bin/cat "${credsPath}"`,
    `region = ${process.env.AWS_REGION || "eu-west-1"}`,
    "",
  ].join("\n");

  const configPath = path.join(dir, "scoped-aws-config");
  const configTmp = configPath + ".tmp";
  fs.writeFileSync(configTmp, configContent, {
    mode: 0o600,
  });
  fs.renameSync(configTmp, configPath);
}

module.exports = {
  buildSessionPolicy,
  createScopedCredentials,
  writeCredentialFiles,
};
