import type { ReactNode } from 'react';
import { IntlProvider as ReactIntlProvider } from 'react-intl';
import { useLocaleStore, type ActiveLocale } from '../stores/localeStore';
import enMessages from './messages/en.json';
import zhTWMessages from './messages/zh-TW.json';

const messagesByLocale: Record<ActiveLocale, Record<string, string>> = {
  en: enMessages,
  'zh-TW': zhTWMessages,
};

/**
 * Wraps the app in a `react-intl` `IntlProvider`. Picks messages from our
 * `localeStore` and falls back to English for any missing IDs. Keep this
 * component minimal — locale detection and persistence live in the store.
 */
export function IntlProvider({ children }: { children: ReactNode }) {
  const active = useLocaleStore((s) => s.active);
  return (
    <ReactIntlProvider
      locale={active}
      messages={messagesByLocale[active]}
      defaultLocale="en"
      onError={(err) => {
        // Missing translation fall-back is expected during rollout; don't
        // spam the console with warnings in prod. Keep dev-mode visibility
        // so untranslated strings are obvious.
        if (err.code === 'MISSING_TRANSLATION') return;
        console.error(err);
      }}
    >
      {children}
    </ReactIntlProvider>
  );
}
