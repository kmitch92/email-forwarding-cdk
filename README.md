# email-forwarding

AWS CDK stack (eu-west-1) that receives inbound email for a Route 53-managed domain via SES and forwards each message to one or more destination addresses. The Lambda rewrites `From:` to `noreply@<domain>` (preserving the original sender's display name) and sets `Reply-To:` to the original sender, so replies go directly back to them. Attachments pass through intact. Routing rules live in a gitignored `local.config.json` — never committed because this repo is public.

## Architecture

```
Sender → MX → SES (eu-west-1) → S3 (raw .eml) + SNS notification
                                         |
                                 Lambda (Node 20, TS)
                                         |
                                 SES SendRawEmail
                                         |
                                 destination inbox
```

**SES inbound** receives mail on the domain's MX record and writes the raw `.eml` to S3 under `inbound/`. An **SNS** notification triggers the **Lambda**, which reads the `.eml` from S3, rewrites the headers, looks up the destination(s) from the routes config baked into the Lambda's environment variables, and sends via `SES:SendRawEmail`. The **S3 bucket** has a 30-day lifecycle expiry — stored emails are not permanent. **Stack outputs** after deploy give you the bucket name, SNS topic ARN, and Lambda function name.

## Prerequisites

- AWS account with admin-level credentials — `aws sts get-caller-identity --profile <profile>` must succeed. ([Set up AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html))
- A domain with its DNS hosted in a Route 53 Hosted Zone in the same account. If the hosted zone doesn't exist yet, create it in Route 53 before proceeding — the stack does a lookup by domain name at deploy time.
- Node.js 22+: `node --version`

The repo pins CDK at `aws-cdk@2.1031.0` / `aws-cdk-lib@2.219.0`. Always use `npx cdk` so you pick up the pinned version — do not rely on a globally installed `cdk`.

## 1. Clone and install

```bash
git clone <repo-url> email-forwarding
cd email-forwarding
npm install
```

Do not use a global `cdk` binary. The pinned version in `node_modules/.bin/cdk` (invoked via `npx`) is the only one guaranteed to match the CDK library version the stack was built against.

## 2. Configure local secrets

```bash
cp local.config.example.json local.config.json
```

Open `local.config.json` and fill in your values:

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

**Routes map rules:**
- Each key is the local part of the inbound address (`info` matches `info@yourbusiness.com`). Matching is case-insensitive.
- Each value is a single destination address or an array of destination addresses.
- `"*"` is a fallback that matches any local part not explicitly listed.
- Mail with no matching route and no `"*"` fallback is dropped silently (a warning is logged to CloudWatch).
- When a route has multiple destinations, all recipients are included in a single SES call — co-recipients will see each other in `To:`.
- Do not route any address back to `@yourdomain.com` — that creates an infinite forwarding loop.

**Gmail `+suffix` trick:** Setting a destination like `you+info@gmail.com` routes all `info@yourbusiness.com` mail to your Gmail inbox. Gmail treats the `+info` part as a label filter target, letting you auto-file it into a sub-inbox (see Step 10). Each route gets its own suffix so you can filter independently.

`local.config.json` is in `.gitignore` and will never be committed. The domain and routing table stay on your machine only.

## 3. Delegate the domain to Route 53

This is the step most likely to cause silent failures later. SES validates your domain by publishing CNAME records into your hosted zone via Route 53's API — but if your domain registrar is still pointing DNS at its own nameservers, those records are invisible to the public internet.

**Find your Route 53 nameservers:**

1. AWS Console → Route 53 → Hosted zones → click your domain.
2. Find the top-level `NS` record (type NS, name matches your domain). It lists four nameservers, e.g. `ns-123.awsdns-45.com`.

**Point your registrar at those nameservers:**

- If the domain is registered with Route 53: Route 53 → Registered domains → your domain → Edit name servers → paste all four.
- If registered elsewhere (GoDaddy, Namecheap, IONOS, etc.): log in to that registrar's control panel and update the domain's nameserver settings to the four `awsdns-*` values. The Route 53 hosted zone alone does nothing — the registrar must point at it.

**Verify propagation:**

```bash
curl -s 'https://dns.google/resolve?name=<domain>&type=NS' | python3 -m json.tool
```

You should see four entries with `awsdns` in the value. Propagation usually takes 15-60 minutes; occasionally several hours.

> **If NS propagation seems stuck:** TTLs on NS records at registrars can be long (up to 48 hours in rare cases). You can also check with `dig NS <domain> @8.8.8.8` if you have `dig` installed.

## 4. CDK bootstrap (one-off per account/region)

CDK bootstrap creates an S3 staging bucket and IAM roles that CDK uses to deploy assets in your account. You only need to do this once per account/region combination.

```bash
npx cdk bootstrap aws://<account-id>/eu-west-1 --profile <profile>
```

Replace `<account-id>` with your 12-digit AWS account ID (from `aws sts get-caller-identity --profile <profile>`).

**Why eu-west-1:** SES email receiving (inbound) is only available in a handful of regions. This stack is pinned to eu-west-1 (Ireland). All resources deploy there.

> **"Cloud assembly schema version mismatch" error:** Your system's global `cdk` is a different version than `aws-cdk-lib` in this repo. Fix: always run `npx cdk` from inside this directory. The local `node_modules/.bin/cdk` will be used automatically.

## 5. Deploy

Always run `diff` first so you can see what will change:

```bash
npx cdk diff --profile <profile>
```

Then deploy:

```bash
npx cdk deploy --profile <profile>
```

The deploy takes 2-5 minutes. When it finishes, CloudFormation prints three stack outputs:

| Output | What it is |
|--------|-----------|
| `BucketName` | S3 bucket where raw `.eml` files are stored |
| `TopicArn` | SNS topic that triggers the Lambda |
| `FunctionName` | Lambda function name (used for log tailing) |

Note these values — you'll use `FunctionName` in Step 12.

## 6. Verify the SES domain identity

The stack automatically publishes DKIM CNAME records into your Route 53 hosted zone. SES then polls those records until they resolve correctly and flips the identity to `Verified`. This is asynchronous.

**Check status in the console:**

Route 53 console (eu-west-1) → SES → Verified identities → click your domain. Wait for `DKIM status: Successful`. Usually completes within minutes of a successful deploy if DNS is delegated correctly.

**Check status via CLI:**

```bash
aws ses get-identity-verification-attributes \
  --identities <domain> \
  --region eu-west-1 \
  --profile <profile>
```

Look for `"VerificationStatus": "Success"`.

> **Still pending after an hour:** Almost always means the domain is not being served by Route 53 nameservers. Re-run the `dns.google` curl from Step 3 — if you see anything other than `awsdns-*` entries, fix delegation at the registrar and wait for propagation.

## 7. Get out of the SES sandbox

Brand-new AWS accounts start in sandbox mode. Inbound (receiving) works fine in sandbox. Outbound (the forwarding step) only works to SES-verified email addresses.

**Option A — Verify each destination address (quick, limited):**

```bash
aws ses verify-email-identity \
  --email-address <destination@gmail.com> \
  --region eu-west-1 \
  --profile <profile>
```

AWS sends a verification link to that address. Click it. Repeat for each destination. Plus-addressed variants (`you+info@gmail.com`) inherit the base address verification — verify `you@gmail.com` once and all `+suffix` variants are covered.

**Option B — Request production access (recommended, ~24h):**

SES console (eu-west-1) → Account dashboard → Request production access. Fill in the form — explain it's a personal forwarder for your own domain. Usually approved within 24 hours and removes the sandbox restriction entirely.

> **Critical sandbox gotcha:** If a single route has multiple destination addresses and even one is unverified, the entire `SendRawEmail` call fails — even the verified destinations do not receive the mail. Option A requires you to verify every address in every multi-destination route.

## 8. Add DMARC (recommended)

The stack automatically publishes an SPF record (`v=spf1 include:amazonses.com ~all`) to Route 53. DMARC is not added by the stack — add it manually.

In Route 53 → Hosted zones → your domain → Create record:

- Type: `TXT`
- Name: `_dmarc`
- Value: `"v=DMARC1; p=none; rua=mailto:dmarc-reports@<domain>"`

Start with `p=none` (monitor-only). This means no mail is rejected or quarantined, but receiving mail servers log DMARC failures and can send aggregate reports to the `rua` address. It signals to receivers that you're a responsible operator and starts building reputation data so you can tighten to `p=quarantine` or `p=reject` later if needed.

**SPF/DKIM/DMARC briefly:** SPF lists which servers may send for your domain. DKIM cryptographically signs outbound mail. DMARC ties them together and tells receivers what to do when both fail. Forwarded mail can break SPF alignment (you're resending from a different server) — DKIM on the original message keeps receivers trusting it.

## 9. Test the forwarder

Send a test email from any external mailbox (not `@<domain>`) to one of your configured routes, e.g. `info@yourbusiness.com`.

Check the destination inbox and the spam folder. First mail from a new domain often lands in spam until reputation builds.

If nothing arrives, tail the Lambda logs:

```bash
FN=$(aws cloudformation describe-stacks \
  --stack-name EmailForwardingStack \
  --region eu-west-1 \
  --profile <profile> \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" \
  --output text)

aws logs tail /aws/lambda/$FN \
  --follow \
  --region eu-west-1 \
  --profile <profile>
```

**Successful forward:**
```json
{"level":"INFO","message":"SES notification received","messageId":"abc123","source":"sender@example.com"}
{"level":"INFO","message":"Resolved destinations","messageId":"abc123","destinations":["you+info@gmail.com"]}
{"level":"INFO","message":"Forwarded email","messageId":"abc123","sesMessageId":"0102018f..."}
```

**No matching route:**
```json
{"level":"WARN","message":"No matching route — dropping","recipients":["unknown@yourbusiness.com"]}
```

## 10. Set up Gmail sub-inbox filters

After each route delivers mail to a `+suffix` address, configure Gmail to auto-label it:

1. Gmail → Settings (gear icon) → See all settings → Filters and Blocked Addresses → Create a new filter.
2. In the **To** field, enter the full plus-addressed destination: `you+info@gmail.com`.
3. Click **Create filter**.
4. Check **Apply the label**, select or create a label (e.g. "Business - Info").
5. Optionally check **Skip the Inbox** if you want it archived directly into the label.
6. Click **Create filter**.

Repeat for each route. Mail forwarded to `you+support@gmail.com` gets labelled "Business - Support" and stays out of the main inbox.

## 11. Updating routes

Edit `local.config.json`, then redeploy:

```bash
npx cdk diff --profile <profile>
npx cdk deploy --profile <profile>
```

The Lambda's environment variable (`FORWARD_ROUTES`) is updated in place. New configuration is live within approximately 30 seconds of deploy completing.

Route changes are not zero-downtime. There is a brief window (tens of seconds) during Lambda update propagation where in-flight mail may use the old configuration.

## 12. Reading logs

Tail live logs:

```bash
aws logs tail /aws/lambda/<FunctionName> \
  --follow \
  --region eu-west-1 \
  --profile <profile>
```

Every log line is structured JSON from AWS Lambda Powertools, keyed by `messageId` (the SES message ID) and AWS request ID. Useful things to search for:

| Search term | Meaning |
|-------------|---------|
| `"errorType"` | Unhandled exception — check `"errorMessage"` next to it |
| `"No matching route"` | Mail was dropped; local part had no route and no `*` fallback |
| `"Forwarded email"` | Successful send; `sesMessageId` is the SES outbound message ID |
| `"MessageRejected"` | Sandbox violation — destination address not verified (see Step 7) |

## 13. Troubleshooting

### "MessageRejected: Email address is not verified"

You are in SES sandbox mode and the destination address is not a verified SES identity. Either verify the address (Step 7, Option A) or request production access (Step 7, Option B).

### Lambda logs show "No matching route — dropping"

The inbound `To:` address local part does not match any key in your `routes` map and there is no `"*"` fallback. Either add the specific route or add `"*": "you@gmail.com"` as a catch-all.

### SES domain identity stuck on "Pending" after more than an hour

The domain is not being served by Route 53 nameservers. Run:

```bash
curl -s 'https://dns.google/resolve?name=<domain>&type=NS' | python3 -m json.tool
```

If you see anything other than `awsdns-*` values, the registrar still points at its own nameservers. Fix delegation and wait for propagation (Step 3).

### Mail accepted by SES, Lambda completes cleanly, nothing in Gmail

Check **Spam**, **All Mail**, and search `from:noreply@<domain>` in Gmail. First forwards from a new domain almost always go to spam until reputation builds. Adding DMARC (Step 8) helps accelerate this. Mark the first few as "Not spam" to train the filter.

### "Cloud assembly schema version mismatch"

Your system's global `cdk` is older than the project's pinned `aws-cdk-lib`. Always use `npx cdk` from inside this repo. If you must use a global install, pin it: `npm install -g aws-cdk@2.1031.0`.

### Active receipt rule set conflict

SES allows only one active receipt rule set per region per account. If you have an existing active rule set, this stack will overwrite it. Check SES → Email receiving → Rule sets before deploying.

## 14. Costs

At personal-forwarder volume, essentially free:

| Service | Rate | Realistic monthly cost |
|---------|------|----------------------|
| SES inbound | $0.10 per 1,000 emails received | < $0.01 |
| SES outbound | $0.10 per 1,000 emails sent (first 62,000/month free from Lambda) | $0.00 |
| Lambda | 1M requests/month free tier | $0.00 |
| S3 | Pennies per GB; 30-day lifecycle keeps it near zero | < $0.01 |
| SNS | First 1M notifications free | $0.00 |

**Realistic total: $0/month** for a personal or small-business forwarder.

## 15. Teardown

```bash
npx cdk destroy --profile <profile>
```

The bucket has `autoDeleteObjects: true` — all stored `.eml` files are deleted along with the stack. If you want to keep them, edit `lib/email-forwarding-stack.ts` to remove `autoDeleteObjects` and change `removalPolicy` to `RETAIN` before running destroy.

**Not automatically cleaned up:** SES verified email identities (SES console → Verified identities → delete), the `_dmarc` TXT record in Route 53, and SES production access status (stays approved; no action needed).

## Reference: project layout

```
bin/email-forwarding.ts          # CDK app entry point; loads local.config.json
lib/
  email-forwarding-stack.ts      # All AWS resources: S3, SNS, Lambda, SES identity,
                                 # MX record, SPF record, receipt rule set
  lambda/forwarder/
    handler.ts                   # Lambda entry point; orchestrates S3 fetch → parse → send
    rewrite.ts                   # Header rewriting (From, Reply-To) and email rebuild
    routing.ts                   # Route resolution logic; exported Routes type
test/                            # Jest unit tests
local.config.example.json        # Copy to local.config.json and fill in
local.config.json                # gitignored — your domain and routing table
```

## Reference: routes config schema

```json
{
  "domain": "yourbusiness.com",
  "routes": {
    "<local-part>": "<single-destination@example.com>",
    "<local-part>": ["<dest1@example.com>", "<dest2@example.com>"],
    "*": "<fallback@example.com>"
  }
}
```

**Rules:**
- `domain`: the bare domain name, no `@`, no subdomain unless you want to receive mail at a subdomain.
- `routes` keys: local parts only (`info`, not `info@yourbusiness.com`). Case-insensitive matching.
- `routes` values: a string (single destination) or array of strings (multiple destinations).
- `"*"` key: optional catch-all. Without it, unmatched mail is dropped with a CloudWatch warning.
- Multiple destinations in one route: all go in a single `SendRawEmail` call; co-recipients see each other.
- Do not add any `@<domain>` address as a destination — creates an infinite forwarding loop.
