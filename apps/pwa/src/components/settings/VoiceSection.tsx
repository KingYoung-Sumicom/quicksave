// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useEffect } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Spinner } from '../ui/Spinner';
import { ErrorBox } from '../ui/ErrorBox';
import { getVoiceConfig, saveVoiceConfig } from '../../lib/secureStorage';
import { listModelsViaAgent } from '../../lib/voiceTranscription';
import { useConnectionStore } from '../../stores/connectionStore';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'whisper-1';

interface VoiceSectionProps {
  isOpen: boolean;
}

/**
 * Voice-input transcription settings. The key/baseUrl/model are stored
 * locally and synced across devices via the shared mailbox, so the user
 * configures this once (single source of truth). Transcription runs on the
 * agent, so the model list can be refreshed via the connected agent — which
 * works for OpenAI too, since the agent has no browser CORS limit.
 */
export function VoiceSection({ isOpen }: VoiceSectionProps) {
  const intl = useIntl();
  const agentId = useConnectionStore((s) => s.agentId);
  const connected = useConnectionStore((s) => s.state === 'connected');

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [keyStored, setKeyStored] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [models, setModels] = useState<string[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    getVoiceConfig().then((c) => {
      if (!c) return;
      if (c.baseUrl) setBaseUrl(c.baseUrl);
      if (c.model) setModel(c.model);
      setKeyStored(c.apiKey.length > 0);
    });
  }, [isOpen]);

  // Build the config to use for a request, preferring the typed key but
  // falling back to the stored one when the (masked) field is left blank.
  async function resolveConfig() {
    const existing = await getVoiceConfig();
    return {
      apiKey: apiKey.trim() || existing?.apiKey || '',
      baseUrl: baseUrl.trim(),
      model: model.trim() || DEFAULT_MODEL,
    };
  }

  async function handleSave(): Promise<void> {
    if (!baseUrl.trim()) {
      setError(intl.formatMessage({ id: 'settings.voice.error.noBaseUrl' }));
      return;
    }
    setIsSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const next = await resolveConfig();
      await saveVoiceConfig(next);
      setKeyStored(next.apiKey.length > 0);
      setApiKey('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : intl.formatMessage({ id: 'settings.voice.error.saveFailed' }),
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRefreshModels(): Promise<void> {
    if (!agentId || !connected) {
      setRefreshError(intl.formatMessage({ id: 'settings.voice.models.notConnected' }));
      return;
    }
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const list = await listModelsViaAgent(await resolveConfig(), agentId);
      setModels(list);
      if (list.length > 0 && !list.includes(model.trim())) {
        // Keep the user's current model if present; otherwise leave as-is so
        // they can pick from the dropdown explicitly.
      }
    } catch (err) {
      setModels(null);
      setRefreshError(
        err instanceof Error ? err.message : intl.formatMessage({ id: 'settings.voice.models.refreshFailed' }),
      );
    } finally {
      setIsRefreshing(false);
    }
  }

  const keyPlaceholder = intl.formatMessage({
    id: keyStored ? 'settings.voice.apiKey.placeholder.update' : 'settings.voice.apiKey.placeholder.new',
  });

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
        <FormattedMessage id="settings.voice.title" />
      </h3>

      <p className="text-sm text-slate-300">
        <FormattedMessage id="settings.voice.description" />
      </p>

      <label className="block text-xs text-slate-400">
        <FormattedMessage id="settings.voice.baseUrl.label" />
      </label>
      <input
        type="url"
        value={baseUrl}
        onChange={(e) => { setBaseUrl(e.target.value); setModels(null); }}
        placeholder={DEFAULT_BASE_URL}
        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        disabled={isSaving}
      />

      <div className="flex items-center justify-between">
        <label className="block text-xs text-slate-400">
          <FormattedMessage id="settings.voice.model.label" />
        </label>
        <button
          type="button"
          onClick={handleRefreshModels}
          disabled={isRefreshing || !baseUrl.trim()}
          className="text-xs text-purple-400 hover:text-purple-300 disabled:text-slate-500 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {isRefreshing && <Spinner color="border-purple-400" />}
          <FormattedMessage id="settings.voice.models.refresh" />
        </button>
      </div>
      {models && models.length > 0 ? (
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
          disabled={isSaving}
        >
          {!models.includes(model) && model && <option value={model}>{model}</option>}
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={DEFAULT_MODEL}
          className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
          disabled={isSaving}
        />
      )}
      {refreshError && <p className="text-xs text-amber-400">{refreshError}</p>}

      <div className="flex items-center justify-between">
        <label className="block text-xs text-slate-400">
          <FormattedMessage id="settings.voice.apiKey.label" />
        </label>
        {keyStored && (
          <span className="text-xs text-green-400">
            <FormattedMessage id="settings.apiKey.configured" />
          </span>
        )}
      </div>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={keyPlaceholder}
        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        disabled={isSaving}
      />

      <p className="text-xs text-slate-400">
        <FormattedMessage id="settings.voice.storageNote" />
      </p>

      {error && <ErrorBox>{error}</ErrorBox>}
      {success && (
        <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
          <FormattedMessage id="settings.voice.success" />
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={isSaving || !baseUrl.trim()}
        className="w-full py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md font-medium text-white transition-colors flex items-center justify-center gap-2"
      >
        {isSaving ? (
          <>
            <Spinner color="border-white" />
            <FormattedMessage id="settings.voice.saving" />
          </>
        ) : (
          <FormattedMessage id="settings.voice.save" />
        )}
      </button>
    </div>
  );
}
