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
          <h1 className="text-xl font-semibold text-white mb-2">Connection Failed</h1>
          <p className="text-slate-400 mb-6">{error}</p>
          <button
            onClick={onAbort}
            className="px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-colors"
          >
            Dismiss
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
          {getTitle(state, isAgentOffline, connectionStep)}
        </h1>
        <p className="text-slate-400 text-sm">
          {getSubtitle(state, isAgentOffline, connectionStep, agentOnline, keyExchangeAttempt)}
        </p>

        {/* Steps */}
        <div className="mt-8 flex justify-center gap-3">
          <StepDot active={stepIndex >= 0} completed={stepIndex > 0} label="Server" />
          <StepDot active={stepIndex >= 1} completed={stepIndex > 1} warn={isAgentOffline} label="Agent" />
          <StepDot active={stepIndex >= 2} completed={stepIndex > 2} label="Key" />
          <StepDot active={stepIndex >= 3} completed={false} label="Secure" />
        </div>

        {/* Actions */}
        <div className="mt-8 flex items-center justify-center gap-4">
          <button
            onClick={onAbort}
            className="px-5 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-red-400 rounded-lg font-medium transition-colors"
          >
            Cancel
          </button>
          {isAgentOffline && (
            <button
              onClick={onRetry}
              className="px-5 py-2 text-sm bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-medium transition-colors"
            >
              Retry
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

function getTitle(state: string, isAgentOffline: boolean, step: ConnectionStep | null): string {
  if (state === 'reconnecting') return 'Reconnecting...';
  if (isAgentOffline) return 'Agent Offline';
  if (step === 'signaling') return 'Connecting to server...';
  if (step === 'waiting-for-agent') return 'Checking agent...';
  if (step === 'key-exchange') return 'Exchanging keys...';
  if (step === 'handshake') return 'Securing connection...';
  return 'Connecting...';
}

function getSubtitle(
  state: string,
  isAgentOffline: boolean,
  step: ConnectionStep | null,
  agentOnline: boolean | null,
  keyExchangeAttempt: number | null,
): string {
  if (state === 'reconnecting') return 'Connection lost, attempting to reconnect';
  if (isAgentOffline) return 'Waiting for agent to come online...';
  if (step === 'waiting-for-agent' && agentOnline === null) return 'Checking if agent is available';
  if (step === 'key-exchange' && keyExchangeAttempt) return `Key exchange attempt ${keyExchangeAttempt} of 5`;
  if (step === 'handshake') return 'Verifying identity';
  return 'Preparing connection';
}

function StepDot({ active, completed, warn, label }: { active: boolean; completed: boolean; warn?: boolean; label: string }) {
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
        {label}
      </span>
    </div>
  );
}
