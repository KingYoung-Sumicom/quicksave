import { FormattedMessage } from 'react-intl';
import { useLocaleStore, type LocalePref } from '../../stores/localeStore';

const OPTIONS: { value: LocalePref; labelId: string }[] = [
  { value: 'auto', labelId: 'settings.language.auto' },
  { value: 'en', labelId: 'settings.language.en' },
  { value: 'zh-TW', labelId: 'settings.language.zhTW' },
];

export function LanguageSection() {
  const pref = useLocaleStore((s) => s.pref);
  const setPref = useLocaleStore((s) => s.setPref);

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
        <FormattedMessage id="settings.language.title" />
      </h3>
      <div className="space-y-1.5">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors ${
              pref === opt.value ? 'bg-blue-600/20 border border-blue-600/50' : 'bg-slate-700/50 hover:bg-slate-700'
            }`}
          >
            <span className="text-sm text-white">
              <FormattedMessage id={opt.labelId} />
            </span>
            <input
              type="radio"
              name="locale-pref"
              value={opt.value}
              checked={pref === opt.value}
              onChange={() => setPref(opt.value)}
              className="accent-blue-500"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
