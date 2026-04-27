import type { SNSEvent, Context } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { Logger } from '@aws-lambda-powertools/logger';
import { simpleParser } from 'mailparser';
import { rebuildEmail } from './rewrite';
import { resolveDestinations, Routes } from './routing';

const s3 = new S3Client({});
const ses = new SESClient({});
const logger = new Logger({ serviceName: 'email-forwarder' });

interface SesReceiveNotification {
  mail: {
    messageId: string;
    source: string;
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

export const handler = async (event: SNSEvent, context: Context): Promise<void> => {
  logger.addContext(context);
  logger.info('Lambda invoked', { recordCount: event.Records.length });

  for (const record of event.Records) {
    const notification = JSON.parse(record.Sns.Message) as SesReceiveNotification;
    const messageId = notification.mail.messageId;

    try {
      logger.info('SES notification received', {
        messageId,
        source: notification.mail.source,
        destinations: notification.mail.destination,
      });

      const destinations = resolveDestinations({
        recipients: notification.mail.destination,
        domain,
        routes,
      });
      if (destinations.length === 0) {
        logger.warn('No matching route — dropping', {
          messageId,
          recipients: notification.mail.destination,
        });
        continue;
      }
      logger.info('Resolved destinations', { messageId, destinations });

      const objectKey = `${objectKeyPrefix}${messageId}`;
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
      if (!obj.Body) throw new Error(`S3 object ${objectKey} has empty body`);
      const raw = Buffer.from(await obj.Body.transformToByteArray());
      logger.debug('Fetched raw email from S3', {
        messageId,
        bucket: bucketName,
        key: objectKey,
        sizeBytes: raw.length,
      });

      const parsed = await simpleParser(raw);
      logger.info('Parsed inbound mail', {
        messageId,
        subject: parsed.subject,
        from: parsed.from?.text,
        attachmentCount: parsed.attachments?.length ?? 0,
      });

      const rebuilt = await rebuildEmail({ parsed, fromAddress, forwardTo: destinations });
      const sendResult = await ses.send(new SendRawEmailCommand({ RawMessage: { Data: rebuilt } }));
      logger.info('Forwarded email', {
        messageId,
        sesMessageId: sendResult.MessageId,
        destinationCount: destinations.length,
      });
    } catch (err) {
      logger.error('Forward failed', { messageId, error: err as Error });
      throw err;
    }
  }
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}
