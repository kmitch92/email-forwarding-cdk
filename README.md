# email-forwarding

AWS CDK stack (eu-west-1) that receives inbound email for a Route 53-managed business domain via SES and forwards it to a Gmail address. The Lambda rewrites `From:` to `noreply@<domain>` (keeping the original sender's display name) and sets `Reply-To:` to the original sender, so replies in Gmail go directly back to the real sender. Attachments pass through intact. The destination Gmail address is stored in SSM Parameter Store and is hot-swappable without a redeploy.

## Architecture

```
Sender → MX → SES (eu-west-1) → S3 (raw .eml) + SNS notification
                                         ↓
                                 Lambda (Node 20, TS)
                                         ↓
                                 SES SendRawEmail
                                         ↓
                                 Gmail inbox
```

SES receives inbound mail on the domain's MX record and writes the raw `.eml` to S3 under `inbound/`. An SNS notification triggers the Lambda, which reads the `.eml` from S3, rewrites the headers, and sends the message via `SES:SendRawEmail`. The destination address is fetched from SSM at cold start and cached for 5 minutes.

## Prerequisites

- AWS account with credentials configured — `aws sts get-caller-identity` must succeed
- Route 53 hosted zone for the domain already exists in the same account
- Node 18+ installed
- AWS CDK v2 installed: `npm install -g aws-cdk`
- CDK bootstrapped in eu-west-1:
  ```bash
  cdk bootstrap aws://<account-id>/eu-west-1
  ```

## One-time setup: SSM parameters

These parameters must exist **before** the first `cdk synth` or `cdk deploy` — the stack reads `/email-forwarding/domain` at synth time to look up the hosted zone.

```bash
aws ssm put-parameter --region eu-west-1 \
  --name /email-forwarding/domain --type String --value "yourbusiness.com"

aws ssm put-parameter --region eu-west-1 \
  --name /email-forwarding/forward-to --type String --value "you@gmail.com"
```

## Deploy

```bash
npm install
npm run build
npx cdk deploy
```

## Post-deploy verification

1. Open the SES console (eu-west-1) → **Verified identities** → confirm the domain shows `Verified` and DKIM is `Successful`. This can take up to 24 hours but usually completes within minutes.
2. SES → **Email receiving** → **Rule sets** → confirm `email-forwarding-default` is the active rule set.
3. Send a test email from any external mailbox to `info@yourbusiness.com` (or any address `@yourbusiness.com`).
4. Check the Gmail inbox — the forwarded email should arrive within seconds.
5. Reply from Gmail — confirm the reply reaches the original external sender.

## SES sandbox caveat

Brand-new AWS accounts start in **sandbox mode**. In sandbox mode:

- **Inbound** (receiving) works fine — no restriction.
- **Outbound** (the forwarding step) only works to verified email addresses. If the destination Gmail address has not been verified as an SES identity, the Lambda will fail with `MessageRejected: Email address is not verified`.

To fix this, do one of the following:

**(a) Verify the destination address** (quick): In the SES console → Verified identities → Add identity → enter the Gmail address → AWS sends a verification link.

**(b) Request production access**: SES console → Account dashboard → Request production access. Usually approved within 24 hours. This removes the sandbox restriction entirely.

## Rotating the forwarding address

No redeploy needed. Overwrite the SSM parameter:

```bash
aws ssm put-parameter --overwrite --region eu-west-1 \
  --name /email-forwarding/forward-to --value "new@gmail.com"
```

The Lambda picks up the new value on the next cold start, or within 5 minutes (cache TTL).

## Other things to know

- Raw `.eml` files are stored in S3 under `inbound/` with a **30-day lifecycle expiration**.
- The bucket has `RemovalPolicy.DESTROY` + `autoDeleteObjects: true`. Running `cdk destroy` deletes the bucket and all stored emails. Edit the stack if you want to retain them.
- **Active receipt rule sets are a singleton per region per account.** Deploying this stack will overwrite any existing active rule set in eu-west-1.
- Do not configure Gmail to forward anything back to `@yourbusiness.com` — that creates an infinite loop.

## Useful commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all Jest tests |
| `npx cdk diff` | Preview changes against deployed stack |
| `npx cdk synth` | Print the CloudFormation template |
| `npx cdk deploy` | Deploy or update the stack |
| `npx cdk destroy` | Tear down the stack (deletes the bucket and all stored emails) |
