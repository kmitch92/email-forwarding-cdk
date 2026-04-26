# email-forwarding

AWS CDK stack (eu-west-1) that receives inbound email for a Route 53-managed business domain via SES and routes each inbound address to one or more destination addresses. The Lambda rewrites `From:` to `noreply@<domain>` (keeping the original sender's display name) and sets `Reply-To:` to the original sender, so replies go directly back to the real sender. Attachments pass through intact. Routing rules and the domain are kept in a gitignored `local.config.json` — not committed to the repo.

## Architecture

```
Sender → MX → SES (eu-west-1) → S3 (raw .eml) + SNS notification
                                         ↓
                                 Lambda (Node 20, TS)
                                         ↓
                                 SES SendRawEmail
                                         ↓
                                 destination inbox
```

SES receives inbound mail on the domain's MX record and writes the raw `.eml` to S3 under `inbound/`. An SNS notification triggers the Lambda, which reads the `.eml` from S3, rewrites the headers, and sends the message via `SES:SendRawEmail`.

## Prerequisites

- AWS account with credentials configured — `aws sts get-caller-identity` must succeed
- Route 53 hosted zone for the domain already exists in the same account
- Node 18+

The project pins its own CDK (`aws-cdk@2.1031.0`, `aws-cdk-lib@2.219.0`, `constructs@10.4.2`). Use `npx cdk` throughout to pick up the pinned version automatically. If you prefer a global install, it must match: `npm install -g aws-cdk@2.1031.0`.

## One-time setup: local config

```bash
cp local.config.example.json local.config.json
# open local.config.json and fill in "domain" and "routes"
```

`local.config.json` is in `.gitignore` and will never be committed. The values stay on your machine only.

The `routes` field is a map from the local part of an inbound address to one or more destination addresses:

```json
{
  "domain": "yourbusiness.com",
  "routes": {
    "info": "you+info@gmail.com",
    "support": ["alice@gmail.com", "bob@gmail.com"],
    "*": "you+catchall@gmail.com"
  }
}
```

- Each key is the local part of the inbound address (`info`, `support`, etc.). Matching is case-insensitive.
- Each value is a single destination address or an array of destination addresses.
- `*` is a fallback that matches any local part not explicitly listed.
- Mail with no matching route and no `*` fallback is dropped (CloudWatch warning logged). Add an explicit `"*"` entry if you want to receive everything.
- When a route has multiple destinations, all recipients are included in a single SES call. Co-recipients will see each other in `To:`.

### Sub-inbox routing with Gmail

Use Gmail's `+suffix` plus-addressing in destination addresses combined with a filter to auto-file mail into labelled sub-inboxes.

1. Set `"info": "you+info@gmail.com"` in routes.
2. In Gmail: Settings → See all settings → Filters and Blocked Addresses → Create a new filter.
3. In the **To** field enter `you+info@gmail.com`, then **Create filter**.
4. Choose **Apply the label** and select or create a label (e.g. "Info"), then **Create filter**.

Repeat for each route. Mail forwarded to `you+info@gmail.com` will be delivered to your inbox and automatically labelled "Info".

## Deploy

```bash
npm install
npx cdk bootstrap aws://<account-id>/eu-west-1   # one-off; skip if already bootstrapped
npx cdk deploy
```

> **Bootstrap version note:** bootstrap must use the same CDK version as the app. If you have a globally-installed CDK at a different version you may see a schema-mismatch error. Run bootstrap with `npx cdk bootstrap ...` (pinned version) to avoid this.

## Post-deploy verification

1. Open the SES console (eu-west-1) → **Verified identities** → confirm the domain shows `Verified` and DKIM is `Successful`. This can take up to 24 hours but usually completes within minutes.
2. SES → **Email receiving** → **Rule sets** → confirm `email-forwarding-default` is the active rule set.
3. Send a test email from any external mailbox to `info@yourbusiness.com` (or any address `@yourbusiness.com`).
4. Check the destination inbox — the forwarded email should arrive within seconds.
5. Reply from the destination inbox — confirm the reply reaches the original external sender.

## SES sandbox caveat

Brand-new AWS accounts start in **sandbox mode**. In sandbox mode:

- **Inbound** (receiving) works fine — no restriction.
- **Outbound** (the forwarding step) only works to verified email addresses. If the destination address has not been verified as an SES identity, the Lambda will fail with `MessageRejected: Email address is not verified`.

To fix this, do one of the following:

**(a) Verify the destination address** (quick): SES console → Verified identities → Add identity → enter the address → AWS sends a verification link.

**(b) Request production access**: SES console → Account dashboard → Request production access. Usually approved within 24 hours. This removes the sandbox restriction entirely.

## Updating routes

Routes live in `local.config.json`. To add, change, or remove a route:

1. Edit `local.config.json`, update the `routes` map.
2. `npx cdk deploy`

The Lambda environment variable gets updated in place. The new configuration is live within ~30 seconds.

## Other things to know

- Raw `.eml` files are stored in S3 under `inbound/` with a **30-day lifecycle expiration**.
- The bucket has `RemovalPolicy.DESTROY` + `autoDeleteObjects: true`. Running `npx cdk destroy` deletes the bucket and all stored emails. Edit the stack if you want to retain them.
- **Active receipt rule sets are a singleton per region per account.** Deploying this stack will overwrite any existing active rule set in eu-west-1.
- Do not route any inbound address back to `@yourdomain.com` — that creates an infinite loop.
- Do not commit `local.config.json`. The `.gitignore` handles this, but worth repeating since the domain and routes are private.

## Useful commands

| Command | Description |
|---------|-------------|
| `npm test` | Run all Jest tests |
| `npx cdk diff` | Preview changes against deployed stack |
| `npx cdk synth` | Print the CloudFormation template |
| `npx cdk deploy` | Deploy or update the stack |
| `npx cdk destroy` | Tear down the stack (deletes the bucket and all stored emails) |
