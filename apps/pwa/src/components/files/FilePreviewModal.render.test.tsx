// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PreviewContent } from './FilePreviewModal';

const baseProps = {
  displayPath: '/work/archive.bin',
  cwd: '/work',
  agentId: 'agent-1',
  renderMarkdown: false,
  renderHtml: false,
  renderSvg: false,
  renderCsv: false,
  showLineNumbers: false,
};

describe('PreviewContent binary download state', () => {
  it('renders the native player for audio received over WebRTC', () => {
    const originalCreateObjectURL = URL.createObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:audio-preview'),
    });
    const html = renderToStaticMarkup(
      <PreviewContent
        {...baseProps}
        data={{
          success: true,
          kind: 'binary',
          content: 'SUQzAAEC',
          encoding: 'base64',
          mimeType: 'audio/mpeg',
        }}
        canDownload
        onDownload={vi.fn()}
      />,
    );

    expect(html).toContain('<audio');
    expect(html).toContain('src="blob:audio-preview"');
    expect(html).not.toContain("Preview isn&#x27;t available");
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
  });

  it('shows a direct download action after WebRTC fetched the binary body', () => {
    const html = renderToStaticMarkup(
      <PreviewContent
        {...baseProps}
        data={{ success: true, kind: 'binary', content: 'AAEC', encoding: 'base64' }}
        canDownload
        onDownload={vi.fn()}
      />,
    );

    expect(html).toContain("Preview isn&#x27;t available for this file format.");
    expect(html).toContain('received over the direct connection');
    expect(html).toContain('Download file');
    expect(html).not.toContain('Binary file — preview not shown.');
  });

  it('shows the direct-transfer error when download bytes are unavailable', () => {
    const html = renderToStaticMarkup(
      <PreviewContent
        {...baseProps}
        data={{ success: true, kind: 'binary', transferError: 'WebRTC timed out' }}
        canDownload={false}
        onDownload={vi.fn()}
      />,
    );

    expect(html).toContain('Download unavailable: WebRTC timed out');
    expect(html).not.toContain('>Download file<');
  });
});
