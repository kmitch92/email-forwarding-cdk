import type { SNSEvent } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { simpleParser } from 'mailparser';
import { rebuildEmail } from './rewrite';

const s3 = new S3Client({});
const ses = new SESClient({});

interface SesReceiveNotification {
  receipt: {
    action: { type: 'S3'; bucketName: string; objectKey: string };
  };
}

export const handler = async (event: SNSEvent): Promise<void> => {
  const forwardTo = requireEnv('FORWARD_TO_EMAIL');
  const fromAddress = requireEnv('FORWARD_FROM_ADDRESS');

  for (const record of event.Records) {
    const notification = JSON.parse(record.Sns.Message) as SesReceiveNotification;
    const { bucketName, objectKey } = notification.receipt.action;

    const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
    if (!obj.Body) throw new Error(`S3 object ${objectKey} has empty body`);
    const raw = Buffer.from(await obj.Body.transformToByteArray());
    const parsed = await simpleParser(raw);

    const rebuilt = await rebuildEmail({ parsed, fromAddress, forwardTo });
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: rebuilt } }));
  }
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}
