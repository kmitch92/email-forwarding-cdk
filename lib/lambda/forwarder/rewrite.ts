import { ParsedMail, AddressObject, Attachment as ParsedAttachment } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { Attachment as MailAttachment } from 'nodemailer/lib/mailer';

export interface RebuildArgs {
  parsed: ParsedMail;
  fromAddress: string;
  forwardTo: string | string[];
}

interface OriginalSender {
  address: string;
  name: string;
}

function extractOriginalSender(from: AddressObject | AddressObject[] | undefined): OriginalSender {
  const fromObj = Array.isArray(from) ? from[0] : from;
  const value = fromObj?.value?.[0];
  return {
    address: value?.address ?? '',
    name: value?.name ?? '',
  };
}

function buildFromHeader(original: OriginalSender, fromAddress: string): string {
  const domain = fromAddress.split('@')[1] ?? '';
  const rawLabel = original.name && original.name.length > 0 ? original.name : original.address;
  // RFC 5321 quoted-string: escape backslash then double-quote
  const label = rawLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${label} via ${domain}" <${fromAddress}>`;
}

function mapAttachments(attachments: ParsedAttachment[] | undefined): MailAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: a.content,
  }));
}

export async function rebuildEmail(args: RebuildArgs): Promise<Buffer> {
  const { parsed, fromAddress, forwardTo } = args;
  const original = extractOriginalSender(parsed.from);

  const mailOptions: ConstructorParameters<typeof MailComposer>[0] = {
    from: buildFromHeader(original, fromAddress),
    to: forwardTo,
    replyTo: original.address || undefined,
    subject: parsed.subject,
    text: parsed.text,
    html: parsed.html === false ? undefined : parsed.html,
    attachments: mapAttachments(parsed.attachments),
  };

  return new Promise<Buffer>((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, message) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(message);
    });
  });
}
