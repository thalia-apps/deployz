import { SESClient, type SendEmailCommand } from '@aws-sdk/client-ses';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderEmailHtml, SesEmailSender } from './email.js';
import { env } from './env.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SesEmailSender', () => {
  it('sends as "Deployz" with a text and an HTML body', async () => {
    const send = vi.spyOn(SESClient.prototype, 'send').mockResolvedValue({} as never);

    await new SesEmailSender('info@e.deployz.dev', 'us-east-1').send({
      to: 'user@example.com',
      subject: 'Hello',
      body: 'Line one',
    });

    const input = (send.mock.calls[0]![0] as SendEmailCommand).input;
    expect(input.Source).toBe('Deployz <info@e.deployz.dev>');
    expect(input.Message?.Body?.Text?.Data).toBe('Line one');
    expect(input.Message?.Body?.Html?.Data).toContain('Line one');
  });
});

describe('renderEmailHtml', () => {
  it('shows the Deployz logo from the web app', () => {
    expect(renderEmailHtml('Hi')).toContain(`<img src="${env.webUrl}/brand/deployz/deployz-icon-512.png"`);
  });

  it('escapes the body, keeps paragraphs and line breaks, and links URLs', () => {
    const html = renderEmailHtml('A <b>&\nB\n\nOpen https://app.deployz.dev/x?a=1&b=2');

    expect(html).toContain('<p style="margin:0 0 16px">A &lt;b&gt;&amp;<br>B</p>');
    expect(html).toContain(
      '<a href="https://app.deployz.dev/x?a=1&amp;b=2" style="color:#2563eb;word-break:break-all">https://app.deployz.dev/x?a=1&amp;b=2</a>',
    );
  });
});
