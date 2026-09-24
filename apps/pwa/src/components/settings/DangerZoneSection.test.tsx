// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DangerZoneSection } from './DangerZoneSection';

vi.mock('../DevicePairingSection', () => ({ DevicePairingSection: () => <div>Rotate identity action</div> }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages = {
  'settings.dangerZone.title': 'Danger Zone',
  'settings.dangerZone.primaryKey.label': 'Primary key backup',
  'settings.dangerZone.primaryKey.description': 'Back up and restore your primary key.',
  'settings.dangerZone.primaryKey.copy': 'Copy',
  'settings.dangerZone.primaryKey.download': 'Download',
  'settings.dangerZone.primaryKey.restoreFromFile': 'Restore from file',
  'settings.dangerZone.primaryKey.restoreFromPasteLabel': 'Paste',
  'settings.dangerZone.primaryKey.restoreFromPastePlaceholder': 'Paste here',
  'settings.dangerZone.primaryKey.restore': 'Restore',
};

describe('DangerZoneSection collapsible', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <DangerZoneSection />
        </IntlProvider>,
      );
    });
  }

  it('is collapsed by default and expands when toggled', async () => {
    await render();
    const details = container.querySelector('details')!;
    const summary = container.querySelector('summary')!;
    expect(details.open).toBe(false);
    expect(container.textContent).toContain('Danger Zone');
    await act(async () => { summary.click(); });
    expect(details.open).toBe(true);
    expect(container.textContent).toContain('Rotate identity action');
    expect(container.textContent).not.toContain('Primary key backup');
    expect(container.textContent).not.toContain('Session history cache');
    await act(async () => { summary.click(); });
    expect(details.open).toBe(false);
  });
});
