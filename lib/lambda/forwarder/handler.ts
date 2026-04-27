import type { SNSEvent } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { simpleParser } from 'mailparser';
import { rebuildEmail } from './rewrite';
import { resolveDestinations, Routes } from './routing';

const s3 = new S3Client({});
const ses = new SESClient({});

interface SesReceiveNotification {
  mail: {
    messageId: string;
    destination: string[];
  };
  receipt: {
    action: { type: string };
  };
}

const routes: Routes = (() => {
  const raw = requireEnv('FORWARD_ROUTES');
  try {
    return JSON.parse(raw) as Routes;
  } catch (e) {
    throw new Error(`FORWARD_ROUTES is not valid JSON: ${(e as Error).message}`);
  }
})();
const fromAddress = requireEnv('FORWARD_FROM_ADDRESS');
const bucketName = requireEnv('BUCKET_NAME');
const objectKeyPrefix = process.env.OBJECT_KEY_PREFIX ?? '';
const atIndex = fromAddress.lastIndexOf('@');
if (atIndex < 1) throw new Error(`FORWARD_FROM_ADDRESS must be a valid email address: ${fromAddress}`);
const domain = fromAddress.slice(atIndex + 1);

export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    const notification = JSON.parse(record.Sns.Message) as SesReceiveNotification;
    const destinations = resolveDestinations({
      recipients: notification.mail.destination,
      domain,
      routes,
    });
    if (destinations.length === 0) {
      console.warn('No matching route for recipients:', notification.mail.destination);
      continue;
    }

    const objectKey = `${objectKeyPrefix}${notification.mail.messageId}`;
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
    if (!obj.Body) throw new Error(`S3 object ${objectKey} has empty body`);
    const raw = Buffer.from(await obj.Body.transformToByteArray());
    const parsed = await simpleParser(raw);

    const rebuilt = await rebuildEmail({ parsed, fromAddress, forwardTo: destinations });
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: rebuilt } }));
  }
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}
