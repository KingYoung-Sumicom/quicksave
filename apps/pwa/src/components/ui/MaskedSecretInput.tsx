import { useState } from 'react';

/** A consistent secret field: stored values are never prefilled; new input is
 * masked by default and can be revealed only while the user is editing it. */
export function MaskedSecretInput({
  value, onChange, placeholder, disabled, autoComplete = 'off',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoComplete?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return <div className="relative">
    <input type={revealed ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} autoComplete={autoComplete} className="w-full px-3 py-2 pr-10 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent" />
    <button type="button" onClick={() => setRevealed((current) => !current)} disabled={disabled} className="absolute inset-y-0 right-0 px-3 text-xs text-slate-400 hover:text-white disabled:opacity-50" aria-label={revealed ? 'Hide secret' : 'Show secret'}>{revealed ? 'Hide' : 'Show'}</button>
  </div>;
}
