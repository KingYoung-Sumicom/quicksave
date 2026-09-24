// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { FormattedMessage } from 'react-intl';
import { DevicePairingSection } from '../DevicePairingSection';

/** Collapsed by default: destructive actions should not compete for
 *  attention at the bottom of the settings page. */
export function DangerZoneSection() {
  return (
    <details className="group rounded-lg border border-red-900/40 bg-red-950/10 overflow-hidden">
      <summary className="flex items-center gap-1.5 cursor-pointer list-none px-4 py-3">
        <svg className="w-3 h-3 text-red-400/70 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wide">
          <FormattedMessage id="settings.dangerZone.title" />
        </h3>
      </summary>
      <div className="space-y-4 px-4 pt-1 pb-4 border-t border-red-900/30">
        <DevicePairingSection />
      </div>
    </details>
  );
}
