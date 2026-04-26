import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { EmailForwardingStack } from '../lib/email-forwarding-stack';

const TEST_ACCOUNT = '123456789012';
const TEST_REGION = 'eu-west-1';
const TEST_DOMAIN = 'example.com';
const TEST_FORWARD_TO = 'destination@example.com';

const synthesizeStack = (): Template => {
  const app = new App({
    context: {
      [`hosted-zone:account=${TEST_ACCOUNT}:domainName=${TEST_DOMAIN}:region=${TEST_REGION}`]: {
        Id: '/hostedzone/Z123EXAMPLE',
        Name: `${TEST_DOMAIN}.`,
      },
    },
  });
  const stack = new EmailForwardingStack(app, 'TestStack', {
    env: { account: TEST_ACCOUNT, region: TEST_REGION },
    domain: TEST_DOMAIN,
    forwardTo: TEST_FORWARD_TO,
  });
  return Template.fromStack(stack);
};

describe('EmailForwardingStack', () => {
  let template: Template;

  beforeAll(() => {
    template = synthesizeStack();
  });

  describe('Route 53 records', () => {
    it('creates an MX record at the apex pointing to SES inbound for eu-west-1', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'MX',
        ResourceRecords: Match.arrayWith([
          Match.stringLikeRegexp('inbound-smtp\\.eu-west-1\\.amazonaws\\.com'),
        ]),
      });
    });

    it('creates an SPF TXT record at the apex containing the SES include directive', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'TXT',
        ResourceRecords: Match.arrayWith([
          Match.stringLikeRegexp('v=spf1 include:amazonses\\.com ~all'),
        ]),
      });
    });
  });

  describe('SES email identity', () => {
    it('creates an SES EmailIdentity for the looked-up domain', () => {
      template.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: TEST_DOMAIN,
      });
    });
  });

  describe('S3 inbound mail bucket', () => {
    it('creates a bucket with SSE-S3 (AES256) encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            }),
          ]),
        },
      });
    });

    it('creates a bucket with all four BlockPublicAccess flags enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('creates a bucket with at least one lifecycle rule expiring objects after >= 1 day', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: Match.anyValue(),
            }),
          ]),
        },
      });
    });
  });

  describe('SNS notification topic', () => {
    it('creates an SNS topic for SES inbound notifications', () => {
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });
  });

  describe('Lambda forwarder', () => {
    it('creates a Lambda function on the Node.js 20 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
      });
    });

    it('subscribes the Lambda to the SNS topic via the lambda protocol', () => {
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'lambda',
      });
    });

    it('sets FORWARD_TO_EMAIL and FORWARD_FROM_ADDRESS env vars on the Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            FORWARD_TO_EMAIL: TEST_FORWARD_TO,
            FORWARD_FROM_ADDRESS: `noreply@${TEST_DOMAIN}`,
          }),
        },
      });
    });
  });

  describe('SES receipt rule', () => {
    it('creates a receipt rule with the domain in Recipients and both S3 + SNS actions', () => {
      template.hasResourceProperties('AWS::SES::ReceiptRule', {
        Rule: Match.objectLike({
          Recipients: Match.arrayWith([TEST_DOMAIN]),
          Actions: Match.arrayWith([
            Match.objectLike({ S3Action: Match.anyValue() }),
            Match.objectLike({ SNSAction: Match.anyValue() }),
          ]),
        }),
      });
    });
  });

  describe('Lambda IAM permissions', () => {
    it('grants the Lambda role ses:SendRawEmail on *', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.stringLikeRegexp('ses:SendRawEmail'),
              Effect: 'Allow',
              Resource: '*',
            }),
          ]),
        },
      });
    });

    it('grants the Lambda role s3:GetObject* on the inbound bucket', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith([Match.stringLikeRegexp('s3:GetObject')]),
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });
  });

  describe('Stack outputs', () => {
    it('exports a CfnOutput for the inbound bucket name', () => {
      template.hasOutput(
        '*',
        Match.objectLike({
          Value: Match.objectLike({ Ref: Match.stringLikeRegexp('.*') }),
        }),
      );
    });
  });
});
