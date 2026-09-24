// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '../i18n/messages/en.json';
import { SettingsNavigation } from './settings/SettingsNavigation';
import { SettingsPage } from './SettingsPage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./settings/LanguageSection', () => ({ LanguageSection: () => <div>Language controls</div> }));
vi.mock('./settings/NotificationSection', () => ({ NotificationSection: () => <div>Notification controls</div> }));
vi.mock('./settings/ApiKeySection', () => ({ ApiKeySection: () => <div>API key controls</div> }));
vi.mock('./settings/VoiceSection', () => ({ VoiceSection: () => <div>Voice controls</div> }));
vi.mock('./settings/MachinesSection', () => ({ MachinesSection: () => <div>Machine controls</div> }));
vi.mock('./settings/DangerZoneSection', () => ({ DangerZoneSection: () => <div>Rotate identity controls</div> }));
vi.mock('./settings/PrimaryKeySection', () => ({ PrimaryKeySection: () => <div>Primary key backup</div> }));
vi.mock('./settings/SessionHistoryCacheSection', () => ({ SessionHistoryCacheSection: () => <div>Cache controls</div> }));

describe('settings navigation', () => {
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

  async function render(desktop: boolean) {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={enMessages}>
          <MemoryRouter initialEntries={[{ pathname: '/settings', state: { returnTo: '/p/project-a/s/session-a' } }]}>
            {desktop && <aside><SettingsNavigation desktop /></aside>}
            <Routes>
              <Route path="/settings" element={<SettingsPage desktop={desktop} />} />
              <Route path="/settings/:section" element={<SettingsPage desktop={desktop} />} />
              <Route path="/p/project-a/s/session-a" element={<p>Original session</p>} />
            </Routes>
          </MemoryRouter>
        </IntlProvider>,
      );
    });
  }

  it('switches the desktop content by category and returns to the original session', async () => {
    await render(true);
    expect(container.textContent).toContain('Language controls');
    expect(container.textContent).toContain('Notification controls');

    await act(async () => {
      (container.querySelector('a[href="/settings/sync"]') as HTMLAnchorElement).click();
    });
    expect(container.textContent).toContain('Rotate identity controls');
    expect(container.textContent).toContain('Primary key backup');
    expect(container.textContent).not.toContain('Language controls');
    expect(container.querySelector('a[href="/settings/sync"]')?.getAttribute('aria-current')).toBe('page');

    await act(async () => {
      (container.querySelector('aside button[aria-label="Back"]') as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain('Original session');
  });

  it('shows a category index on mobile and opens a single settings page', async () => {
    await render(false);
    expect(container.querySelector('nav[aria-label="Settings categories"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('a[href="/settings/voice"]') as HTMLAnchorElement).click();
    });
    expect(container.textContent).toContain('Voice controls');
    expect(container.textContent).not.toContain('Language controls');
    await act(async () => {
      (container.querySelector('button[aria-label="Back"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('nav[aria-label="Settings categories"]')).not.toBeNull();
  });
});
