import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as actions from 'aws-cdk-lib/aws-ses-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Routes } from './lambda/forwarder/routing';

export interface EmailForwardingStackProps extends cdk.StackProps {
  domain: string;
  routes: Routes;
}

export class EmailForwardingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EmailForwardingStackProps) {
    super(scope, id, props);

    // 1. Domain provided via stack props (loaded from gitignored local.config.json)
    const domain = props.domain;

    // 2. HostedZone lookup
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: domain });

    // 3. S3 bucket for raw inbound .eml
    const bucket = new s3.Bucket(this, 'EmailStore', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 5. SES EmailIdentity with DKIM auto-published to Route 53
    new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(hostedZone),
    });

    // 6. MX record at the apex
    new route53.MxRecord(this, 'InboundMx', {
      zone: hostedZone,
      values: [{ priority: 10, hostName: 'inbound-smtp.eu-west-1.amazonaws.com' }],
    });

    // 7. SPF TXT record at the apex
    new route53.TxtRecord(this, 'SpfRecord', {
      zone: hostedZone,
      values: ['v=spf1 include:amazonses.com ~all'],
    });

    // 8. SNS topic
    const topic = new sns.Topic(this, 'InboundNotifications');

    // 10. NodejsFunction
    const fn = new nodejs.NodejsFunction(this, 'EmailForwarder', {
      entry: path.join(__dirname, 'lambda/forwarder/handler.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        nodeModules: ['mailparser', 'nodemailer'],
        minify: true,
      },
      environment: {
        FORWARD_ROUTES: JSON.stringify(props.routes),
        FORWARD_FROM_ADDRESS: `noreply@${props.domain}`,
      },
    });

    // 11. IAM grants on the Lambda role
    bucket.grantRead(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendRawEmail'],
        resources: ['*'],
      }),
    );

    // 12. SNS -> Lambda subscription
    topic.addSubscription(new subs.LambdaSubscription(fn));

    // 13. SES ReceiptRuleSet + ReceiptRule with both S3 and SNS actions
    const ruleSet = new ses.ReceiptRuleSet(this, 'InboundRuleSet', {
      receiptRuleSetName: 'email-forwarding-default',
    });
    ruleSet.addRule('InboundRule', {
      recipients: [domain],
      enabled: true,
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        new actions.S3({ bucket, objectKeyPrefix: 'inbound/' }),
        new actions.Sns({ topic }),
      ],
    });

    // 14. AwsCustomResource to set the rule set active
    const activate = new cr.AwsCustomResource(this, 'ActivateRuleSet', {
      onCreate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of('email-forwarding-active-rule-set'),
      },
      onUpdate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: cr.PhysicalResourceId.of('email-forwarding-active-rule-set'),
      },
      onDelete: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {},
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    activate.node.addDependency(ruleSet);

    // 15. CfnOutputs
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
