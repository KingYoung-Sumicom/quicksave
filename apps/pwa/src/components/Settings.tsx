// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { Spinner } from './ui/Spinner';
import { ErrorBox } from './ui/ErrorBox';
import { useGitStore } from '../stores/gitStore';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveApiKey: (apiKey: string) => Promise<boolean>;
}

export function Settings({ isOpen, onClose, onSaveApiKey }: SettingsProps) {
  const { apiKeyConfigured } = useGitStore();
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError('Please enter an API key');
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const result = await onSaveApiKey(apiKey.trim());
      if (result) {
        setSuccess(true);
        setApiKey('');
        setTimeout(() => {
          setSuccess(false);
        }, 2000);
      } else {
        setError('Failed to save API key');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-lg w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white"><FormattedMessage id="settings.title" /></h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* API Key Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-300">
                Anthropic API Key
              </label>
              {apiKeyConfigured && (
                <span className="text-xs text-green-400 flex items-center gap-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Configured
                </span>
              )}
            </div>

            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={apiKeyConfigured ? 'Enter new key to update...' : 'sk-ant-...'}
              className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              disabled={isSaving}
            />

            <p className="text-xs text-slate-400">
              Your API key is stored securely on your local machine and never sent to our servers.
            </p>

            {error && (
              <ErrorBox>{error}</ErrorBox>
            )}

            {success && (
              <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
                API key saved successfully!
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={isSaving || !apiKey.trim()}
              className="w-full py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
            >
              {isSaving ? (
                <>
                  <Spinner color="border-white" />
                  Saving...
                </>
              ) : (
                'Save API Key'
              )}
            </button>
          </div>

          {/* Explanation about API key requirement */}
          <div className="p-3 bg-slate-700/50 rounded-lg text-sm text-slate-300 space-y-2">
            <p className="font-medium">Why is an API key required?</p>
            <p className="text-slate-400">
              Quicksave uses Claude AI to generate commit message summaries from your diffs.
              Claude Pro/Max subscriptions only work with the official Claude apps.
              Third-party tools like quicksave require a separate API key with usage-based billing.
            </p>
          </div>

          {/* How to get API Key */}
          <div className="p-3 bg-slate-700/50 rounded-lg text-sm space-y-3">
            <p className="font-medium text-slate-300">How to get your API key:</p>
            <ol className="list-decimal list-inside space-y-1.5 text-slate-400">
              <li>
                Go to{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-400 hover:text-purple-300 underline"
                >
                  console.anthropic.com/settings/keys
                </a>
              </li>
              <li>Sign in or create an Anthropic account</li>
              <li>Click "Create Key" and give it a name</li>
              <li>Copy the key (starts with sk-ant-...)</li>
              <li>Paste it above and click Save</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
