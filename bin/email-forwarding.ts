#!/usr/bin/env node
import 'source-map-support/register';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { EmailForwardingStack } from '../lib/email-forwarding-stack';
import { Routes } from '../lib/lambda/forwarder/routing';

interface LocalConfig {
  domain: string;
  routes: Routes;
}

const configPath = path.join(__dirname, '..', 'local.config.json');
if (!fs.existsSync(configPath)) {
  throw new Error(
    `Missing ${configPath}. Copy local.config.example.json to local.config.json and fill in your domain and routes values.`,
  );
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as LocalConfig;
if (!config.domain || typeof config.domain !== 'string') {
  throw new Error('local.config.json must contain a "domain" string');
}
if (!config.routes || typeof config.routes !== 'object' || Object.keys(config.routes).length === 0) {
  throw new Error('local.config.json must contain a non-empty "routes" map');
}

const app = new cdk.App();
new EmailForwardingStack(app, 'EmailForwardingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-west-1',
  },
  description: 'Inbound email for the business domain → Gmail forwarder via SES',
  domain: config.domain,
  routes: config.routes,
});
