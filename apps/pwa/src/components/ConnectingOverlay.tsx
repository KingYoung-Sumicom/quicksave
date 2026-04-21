import { FormattedMessage } from 'react-intl';
import { useConnectionStore, type ConnectionStep } from '../stores/connectionStore';

interface ConnectingOverlayProps {
  onAbort: () => void;
  onRetry: () => void;
}

export function ConnectingOverlay({ onAbort, onRetry }: ConnectingOverlayProps) {
  const { state, error, connectionStep, keyExchangeAttempt, agentOnline } = useConnectionStore();

  // Only show for connecting/reconnecting states
  if (state !== 'connecting' && state !== 'reconnecting' && !(state === 'error' && error)) {
    return null;
  }

  // Error state
  if (state === 'error' && error) {
    return (
      <div className="fixed inset-0 z-50 bg-slate-900/90 flex items-center justify-center safe-area-top safe-area-bottom">
        <div className="w-full max-w-sm text-center px-6">
          <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">
            <FormattedMessage id="connecting.error.title" />
          </h1>
          <p className="text-slate-400 mb-6">{error}</p>
          <button
            onClick={onAbort}
            className="px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-colors"
          >
            <FormattedMessage id="connecting.error.dismiss" />
          </button>
        </div>
      </div>
    );
  }

  const isAgentOffline = connectionStep === 'waiting-for-agent' && agentOnline === false;
  const stepIndex = getStepIndex(connectionStep);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/90 flex items-center justify-center safe-area-top safe-area-bottom">
      <div className="w-full max-w-sm text-center px-6">
        {/* Animated indicator */}
        <div className="relative w-20 h-20 mx-auto mb-8">
          {isAgentOffline ? (
            <>
              <div className="absolute inset-0 rounded-full border-4 border-amber-500/30" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-4 h-4 bg-amber-500 rounded-full animate-pulse" />
              </div>
            </>
          ) : (
            <>
              <div className="absolute inset-0 rounded-full border-4 border-slate-700" />
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-500 animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-4 h-4 bg-blue-500 rounded-full animate-pulse" />
              </div>
            </>
          )}
        </div>

        <h1 className="text-xl font-semibold text-white mb-2">
          <FormattedMessage id={getTitleMessageId(state, isAgentOffline, connectionStep)} />
        </h1>
        <p className="text-slate-400 text-sm">
          <FormattedMessage
            id={getSubtitleMessageId(state, isAgentOffline, connectionStep, agentOnline, keyExchangeAttempt)}
            values={{ attempt: keyExchangeAttempt ?? 0 }}
          />
        </p>

        {/* Steps */}
        <div className="mt-8 flex justify-center gap-3">
          <StepDot active={stepIndex >= 0} completed={stepIndex > 0} labelId="connecting.step.server" />
          <StepDot active={stepIndex >= 1} completed={stepIndex > 1} warn={isAgentOffline} labelId="connecting.step.agent" />
          <StepDot active={stepIndex >= 2} completed={stepIndex > 2} labelId="connecting.step.key" />
          <StepDot active={stepIndex >= 3} completed={false} labelId="connecting.step.secure" />
        </div>

        {/* Actions */}
        <div className="mt-8 flex items-center justify-center gap-4">
          <button
            onClick={onAbort}
            className="px-5 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-red-400 rounded-lg font-medium transition-colors"
          >
            <FormattedMessage id="connecting.cancel" />
          </button>
          {isAgentOffline && (
            <button
              onClick={onRetry}
              className="px-5 py-2 text-sm bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-medium transition-colors"
            >
              <FormattedMessage id="connecting.retry" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function getStepIndex(step: ConnectionStep | null): number {
  switch (step) {
    case 'signaling': return 0;
    case 'waiting-for-agent': return 1;
    case 'key-exchange': return 2;
    case 'handshake': return 3;
    default: return 0;
  }
}

function getTitleMessageId(state: string, isAgentOffline: boolean, step: ConnectionStep | null): string {
  if (state === 'reconnecting') return 'connecting.title.reconnecting';
  if (isAgentOffline) return 'connecting.title.agentOffline';
  if (step === 'signaling') return 'connecting.title.signaling';
  if (step === 'waiting-for-agent') return 'connecting.title.waitingForAgent';
  if (step === 'key-exchange') return 'connecting.title.keyExchange';
  if (step === 'handshake') return 'connecting.title.handshake';
  return 'connecting.title.fallback';
}

function getSubtitleMessageId(
  state: string,
  isAgentOffline: boolean,
  step: ConnectionStep | null,
  agentOnline: boolean | null,
  keyExchangeAttempt: number | null,
): string {
  if (state === 'reconnecting') return 'connecting.subtitle.reconnecting';
  if (isAgentOffline) return 'connecting.subtitle.agentOffline';
  if (step === 'waiting-for-agent' && agentOnline === null) return 'connecting.subtitle.checkingAgent';
  if (step === 'key-exchange' && keyExchangeAttempt) return 'connecting.subtitle.keyExchangeAttempt';
  if (step === 'handshake') return 'connecting.subtitle.handshake';
  return 'connecting.subtitle.fallback';
}

function StepDot({ active, completed, warn, labelId }: { active: boolean; completed: boolean; warn?: boolean; labelId: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
          completed
            ? 'bg-green-500'
            : warn
            ? 'bg-amber-500 animate-pulse'
            : active
            ? 'bg-blue-500 animate-pulse'
            : 'bg-slate-600'
        }`}
      />
      <span className={`text-xs ${warn ? 'text-amber-400' : active || completed ? 'text-slate-300' : 'text-slate-600'}`}>
        <FormattedMessage id={labelId} />
      </span>
    </div>
  );
}
