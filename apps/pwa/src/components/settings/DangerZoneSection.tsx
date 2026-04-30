// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { FormattedMessage } from 'react-intl';
import { DevicePairingSection } from '../DevicePairingSection';
import { PrimaryKeySection } from './PrimaryKeySection';

export function DangerZoneSection() {
  return (
    <div className="space-y-4 border border-red-900/40 bg-red-950/10 rounded-lg p-4">
      <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wide">
        <FormattedMessage id="settings.dangerZone.title" />
      </h3>
      <PrimaryKeySection />
      <div className="border-t border-red-900/30" />
      <DevicePairingSection />
    </div>
  );
}
