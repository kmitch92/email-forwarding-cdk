import { simpleParser, ParsedMail } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { rebuildEmail } from '../lib/lambda/forwarder/rewrite';

async function parseEml(rfc822: string | Buffer): Promise<ParsedMail> {
  return simpleParser(typeof rfc822 === 'string' ? Buffer.from(rfc822) : rfc822);
}

async function composeEml(options: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    new MailComposer(options).compile().build((err, message) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(message);
    });
  });
}

const FORWARD_TO = 'you@gmail.com';
const FROM_ADDRESS = 'noreply@mybusiness.com';
const FROM_DOMAIN = 'mybusiness.com';

describe('rebuildEmail', () => {
  describe('From header rewrite', () => {
    it('preserves the original display name and rewrites the mailbox to fromAddress', async () => {
      const eml = [
        'From: "Alice Example" <alice@external.com>',
        'To: info@mybusiness.com',
        'Subject: Hello',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Hi there.',
      ].join('\r\n');
      const parsed = await parseEml(eml);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.from?.value[0].address).toBe(FROM_ADDRESS);
      expect(reparsed.from?.text).toContain(`Alice Example via ${FROM_DOMAIN}`);
    });

    it('falls back to the original email address when no display name is present', async () => {
      const eml = [
        'From: <bob@external.com>',
        'To: info@mybusiness.com',
        'Subject: No display name',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Plain message body.',
      ].join('\r\n');
      const parsed = await parseEml(eml);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.from?.value[0].address).toBe(FROM_ADDRESS);
      expect(reparsed.from?.text).toContain(`bob@external.com via ${FROM_DOMAIN}`);
    });
  });

  describe('Reply-To header', () => {
    it('sets Reply-To to the original sender so replies route back to the real sender', async () => {
      const eml = [
        'From: "Alice Example" <alice@external.com>',
        'To: info@mybusiness.com',
        'Subject: Reply test',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Some body.',
      ].join('\r\n');
      const parsed = await parseEml(eml);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.replyTo?.value[0].address).toBe('alice@external.com');
    });
  });

  describe('To header', () => {
    it('sets To to the forwardTo argument', async () => {
      const eml = [
        'From: "Alice Example" <alice@external.com>',
        'To: info@mybusiness.com',
        'Subject: To test',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Body.',
      ].join('\r\n');
      const parsed = await parseEml(eml);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.to).toBeDefined();
      const toObject = Array.isArray(reparsed.to) ? reparsed.to[0] : reparsed.to;
      expect(toObject?.value[0].address).toBe(FORWARD_TO);
    });

    it('accepts forwardTo as an array and sets multiple To recipients', async () => {
      const eml = [
        'From: "Alice Example" <alice@external.com>',
        'To: info@mybusiness.com',
        'Subject: Multi recipient test',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Body.',
      ].join('\r\n');
      const parsed = await parseEml(eml);

      const rebuilt = await rebuildEmail({
        parsed,
        fromAddress: FROM_ADDRESS,
        forwardTo: ['a@example.com', 'b@example.com'],
      });
      const reparsed = await parseEml(rebuilt);

      const toObject = Array.isArray(reparsed.to) ? reparsed.to[0] : reparsed.to;
      expect(toObject?.value).toHaveLength(2);
      expect(toObject?.value.map((v) => v.address)).toEqual(['a@example.com', 'b@example.com']);
    });
  });

  describe('Subject preservation', () => {
    it('preserves the original subject including non-ASCII / emoji characters', async () => {
      // Build the .eml via MailComposer so the UTF-8 subject is correctly RFC2047-encoded
      // for input. The assertion is on the round-tripped decoded value.
      const inboundBuffer = await composeEml({
        from: '"Alice Example" <alice@external.com>',
        to: 'info@mybusiness.com',
        subject: 'Café meeting ☕',
        text: 'See you there.',
      });
      const parsed = await parseEml(inboundBuffer);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.subject).toBe('Café meeting ☕');
    });
  });

  describe('Body preservation', () => {
    it('preserves the plain text body verbatim', async () => {
      const bodyText = 'Hello,\n\nThis is the original message body.\nLine three.';
      const inboundBuffer = await composeEml({
        from: '"Alice Example" <alice@external.com>',
        to: 'info@mybusiness.com',
        subject: 'Plain text test',
        text: bodyText,
      });
      const parsed = await parseEml(inboundBuffer);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.text).toBeDefined();
      expect(reparsed.text).toContain('This is the original message body.');
      expect(reparsed.text).toContain('Line three.');
    });

    it('preserves the HTML body when present', async () => {
      const htmlBody = '<p>Hello <strong>world</strong>, this is <em>HTML</em>.</p>';
      const inboundBuffer = await composeEml({
        from: '"Alice Example" <alice@external.com>',
        to: 'info@mybusiness.com',
        subject: 'HTML body test',
        text: 'Plain text alternative.',
        html: htmlBody,
      });
      const parsed = await parseEml(inboundBuffer);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.html).toBeTruthy();
      expect(typeof reparsed.html === 'string' ? reparsed.html : '').toContain('<strong>world</strong>');
      expect(typeof reparsed.html === 'string' ? reparsed.html : '').toContain('<em>HTML</em>');
    });
  });

  describe('Attachment preservation', () => {
    it('preserves attachment filename, contentType, and content bytes', async () => {
      const attachmentBytes = Buffer.from('hello pdf');
      // Build the inbound .eml via MailComposer so that constructing a valid multipart
      // attachment fixture is straightforward. The assertion is on the rebuilt output.
      const inboundBuffer = await composeEml({
        from: '"Alice Example" <alice@external.com>',
        to: 'info@mybusiness.com',
        subject: 'Attachment test',
        text: 'See attached.',
        attachments: [
          {
            filename: 'report.pdf',
            content: attachmentBytes,
            contentType: 'application/pdf',
          },
        ],
      });
      const parsed = await parseEml(inboundBuffer);

      // Sanity check the fixture itself includes the attachment (guards against bad setup).
      expect(parsed.attachments).toHaveLength(1);

      const rebuilt = await rebuildEmail({ parsed, fromAddress: FROM_ADDRESS, forwardTo: FORWARD_TO });
      const reparsed = await parseEml(rebuilt);

      expect(reparsed.attachments).toHaveLength(1);
      const attachment = reparsed.attachments[0];
      expect(attachment.filename).toBe('report.pdf');
      expect(attachment.contentType).toBe('application/pdf');
      expect(Buffer.isBuffer(attachment.content)).toBe(true);
      expect(attachment.content.equals(attachmentBytes)).toBe(true);
    });
  });
});
