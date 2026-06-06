// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { FormattedMessage, useIntl } from 'react-intl';
import { Spinner } from '../ui/Spinner';
import { ErrorBox } from '../ui/ErrorBox';
import { getVoiceConfig, saveVoiceConfig } from '../../lib/secureStorage';
import { listModelsViaAgent, filterVoiceModels } from '../../lib/voiceTranscription';
import { useConnectionStore } from '../../stores/connectionStore';
import { VoiceRtcDebugPanel } from './VoiceRtcDebugPanel';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TRANSCRIBE_MODEL = 'whisper-1';
const DEFAULT_STREAM_MODEL = 'gpt-4o-transcribe';
/** Known OpenAI(-compatible) TTS voices — `/models` doesn't list these, so the
 *  voice picker is a fixed dropdown (a saved custom value is still preserved). */
const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

interface VoiceSectionProps {
  isOpen: boolean;
}

/** A model field that renders a dropdown of fetched (voice-filtered) models
 *  when available, else a free-text input. */
function ModelField({
  labelId, hintId, label, hint, value, onChange, models, placeholder, disabled, allowEmpty,
}: {
  labelId?: string;
  hintId?: string;
  /** Literal label/hint, used when no i18n id is supplied. */
  label?: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  models: string[] | null;
  placeholder: string;
  disabled: boolean;
  /** Show a blank option (for optional fields that may be left empty). */
  allowEmpty?: boolean;
}) {
  const cls = 'w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent';
  return (
    <div className="space-y-1">
      <label className="block text-xs text-slate-400">{labelId ? <FormattedMessage id={labelId} /> : label}</label>
      {models && models.length > 0 ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={cls} disabled={disabled}>
          {allowEmpty && <option value="">—</option>}
          {!models.includes(value) && value && <option value={value}>{value}</option>}
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cls} disabled={disabled} />
      )}
      {(hintId || hint) && <p className="text-[11px] text-slate-500">{hintId ? <FormattedMessage id={hintId} /> : hint}</p>}
    </div>
  );
}

/**
 * Voice-input transcription settings. The key/baseUrl/models are stored
 * locally and synced across devices via the shared mailbox, so the user
 * configures this once (single source of truth). Transcription runs on the
 * agent, so the model list can be refreshed via the connected agent — which
 * works for OpenAI too, since the agent has no browser CORS limit.
 *
 * Batch and streaming use different models (e.g. whisper-1 vs gpt-4o-transcribe),
 * so they are configured separately.
 */
export function VoiceSection({ isOpen }: VoiceSectionProps) {
  const intl = useIntl();
  const agentId = useConnectionStore((s) => s.agentId);
  const connected = useConnectionStore((s) => s.state === 'connected');

  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState<'streaming' | 'batch'>('streaming');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [transcribeModel, setTranscribeModel] = useState(DEFAULT_TRANSCRIBE_MODEL);
  const [streamModel, setStreamModel] = useState(DEFAULT_STREAM_MODEL);
  // Voice intermediary ("AI coworker") — brain (chat) + TTS, same endpoint.
  const [agentModel, setAgentModel] = useState('');
  const [ttsModel, setTtsModel] = useState('');
  const [ttsVoice, setTtsVoice] = useState('');
  const [keyStored, setKeyStored] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [models, setModels] = useState<string[] | null>(null);
  // Full, unfiltered list — the coworker's chat/TTS models aren't voice models,
  // so they need the raw `/models` list, not the voice-filtered `models`.
  const [allModels, setAllModels] = useState<string[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    getVoiceConfig().then((c) => {
      if (!c) return;
      setMode(c.mode);
      if (c.baseUrl) setBaseUrl(c.baseUrl);
      if (c.transcribeModel) setTranscribeModel(c.transcribeModel);
      if (c.streamModel) setStreamModel(c.streamModel);
      if (c.agentModel) setAgentModel(c.agentModel);
      if (c.ttsModel) setTtsModel(c.ttsModel);
      if (c.ttsVoice) setTtsVoice(c.ttsVoice);
      setKeyStored(c.apiKey.length > 0);
    });
  }, [isOpen]);

  // Build the config to use for a request, preferring the typed key but
  // falling back to the stored one when the (masked) field is left blank.
  async function resolveConfig() {
    const existing = await getVoiceConfig();
    return {
      apiKey: apiKey.trim() || existing?.apiKey || '',
      mode,
      baseUrl: baseUrl.trim(),
      transcribeModel: transcribeModel.trim() || DEFAULT_TRANSCRIBE_MODEL,
      streamModel: streamModel.trim() || DEFAULT_STREAM_MODEL,
      agentModel: agentModel.trim() || undefined,
      ttsModel: ttsModel.trim() || undefined,
      ttsVoice: ttsVoice.trim() || undefined,
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
      // Trim to voice-relevant models so the picker isn't full of chat/image
      // models (falls back to the full list for self-hosted servers).
      setModels(filterVoiceModels(list));
      setAllModels(list);
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

  // TTS models out of the full list (fall back to the full list if none match).
  const ttsModelOptions = allModels
    ? (allModels.filter((m) => /tts|speech|audio/i.test(m)).length > 0
        ? allModels.filter((m) => /tts|speech|audio/i.test(m))
        : allModels)
    : null;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
        <FormattedMessage id="settings.voice.title" />
      </h3>

      <p className="text-sm text-slate-300">
        <FormattedMessage id="settings.voice.description" />
      </p>

      {/* Input mode: live streaming (WebRTC) vs record-then-send (batch). */}
      <label className="block text-xs text-slate-400">
        <FormattedMessage id="settings.voice.mode.label" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {(['streaming', 'batch'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            disabled={isSaving}
            className={clsx(
              'rounded-md border px-3 py-2 text-left transition-colors',
              mode === m
                ? 'border-purple-500 bg-purple-500/10'
                : 'border-slate-600 bg-slate-700 hover:bg-slate-600',
            )}
          >
            <span className="block text-sm text-white">
              <FormattedMessage id={`settings.voice.mode.${m}`} />
            </span>
            <span className="block text-[11px] text-slate-400">
              <FormattedMessage id={`settings.voice.mode.${m}.hint`} />
            </span>
          </button>
        ))}
      </div>

      <label className="block text-xs text-slate-400">
        <FormattedMessage id="settings.voice.baseUrl.label" />
      </label>
      <input
        type="url"
        value={baseUrl}
        onChange={(e) => { setBaseUrl(e.target.value); setModels(null); setAllModels(null); }}
        placeholder={DEFAULT_BASE_URL}
        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
        disabled={isSaving}
      />

      <div className="flex items-center justify-end">
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

      <ModelField
        labelId="settings.voice.transcribeModel.label"
        hintId="settings.voice.transcribeModel.hint"
        value={transcribeModel}
        onChange={setTranscribeModel}
        models={models}
        placeholder={DEFAULT_TRANSCRIBE_MODEL}
        disabled={isSaving}
      />
      <ModelField
        labelId="settings.voice.streamModel.label"
        hintId="settings.voice.streamModel.hint"
        value={streamModel}
        onChange={setStreamModel}
        models={models}
        placeholder={DEFAULT_STREAM_MODEL}
        disabled={isSaving}
      />
      {refreshError && <p className="text-xs text-amber-400">{refreshError}</p>}

      {/* Voice intermediary ("AI coworker") — brain + TTS on the same endpoint. */}
      <div className="pt-3 mt-1 border-t border-slate-700/60 space-y-2">
        <h4 className="text-xs font-semibold text-slate-300">語音同事（中介 agent）</h4>
        <p className="text-xs text-slate-500">
          用同一個 endpoint 詮釋 coding agent 的輸出、並讓你用語音操控。留空即停用；按上方「Refresh models」載入下拉選單。
        </p>

        <ModelField
          label="Brain 模型（chat completions）"
          hint="例如 gpt-4o-mini"
          value={agentModel}
          onChange={setAgentModel}
          models={allModels}
          placeholder="gpt-4o-mini"
          disabled={isSaving}
          allowEmpty
        />
        <ModelField
          label="TTS 模型（audio/speech）"
          hint="例如 gpt-4o-mini-tts 或 tts-1"
          value={ttsModel}
          onChange={setTtsModel}
          models={ttsModelOptions}
          placeholder="gpt-4o-mini-tts"
          disabled={isSaving}
          allowEmpty
        />
        <ModelField
          label="TTS 語音"
          hint="例如 alloy / nova"
          value={ttsVoice}
          onChange={setTtsVoice}
          models={TTS_VOICES}
          placeholder="alloy"
          disabled={isSaving}
          allowEmpty
        />
      </div>

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

      <details className="pt-2 mt-1 border-t border-slate-700/60">
        <summary className="text-xs text-slate-400 cursor-pointer select-none hover:text-slate-200">
          WebRTC 診斷（串流語音連線測試）
        </summary>
        <div className="mt-2">
          <VoiceRtcDebugPanel />
        </div>
      </details>
    </div>
  );
}
