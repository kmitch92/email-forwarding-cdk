#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EmailForwardingStack } from '../lib/email-forwarding-stack';

const app = new cdk.App();
new EmailForwardingStack(app, 'EmailForwardingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-west-1', // SES email receiving requires eu-west-1, us-east-1, or us-west-2
  },
  description: 'Inbound email for the business domain → Gmail forwarder via SES',
});
