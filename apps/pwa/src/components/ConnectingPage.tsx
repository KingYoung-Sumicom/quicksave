import { useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useConnectionStore } from '../stores/connectionStore';
import { useMachineStore } from '../stores/machineStore';
import { useIdentityStore } from '../stores/identityStore';

interface ConnectingPageProps {
  onConnect: (agentId: string, publicKey: string) => void;
  onAbort: () => void;
  clientReady: boolean;
}

export function ConnectingPage({ onConnect, onAbort, clientReady }: ConnectingPageProps) {
  const { agentId } = useParams<{ agentId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, error, connectionStep, keyExchangeAttempt, agentOnline, setPendingRepoPath } = useConnectionStore();
  const { getMachine, addMachine } = useMachineStore();
  const { initialized: identityInitialized } = useIdentityStore();
  const hasInitiated = useRef(false);

  // Handle connection on mount - only run once identity and client are ready
  useEffect(() => {
    // Wait for identity to be initialized and WebSocket client to be created
    if (!identityInitialized || !clientReady) {
      return;
    }

    // Skip if already initiated
    if (hasInitiated.current) {
      return;
    }

    // No agentId in URL, redirect to home
    if (!agentId) {
      navigate('/', { replace: true });
      return;
    }

    // Mark as initiated immediately to prevent re-runs
    hasInitiated.current = true;

    // Check if we have connection params in URL (for QR code / link sharing)
    const publicKeyParam = searchParams.get('pk');
    const nameParam = searchParams.get('name');
    const repoParam = searchParams.get('repo');

    // Set pending repo path if specified in URL (do this before checking connection state)
    if (repoParam) {
      setPendingRepoPath(repoParam);
    }

    // If already in a connection state, don't start a new connection
    if (state === 'connecting' || state === 'connected') {
      return;
    }

    if (publicKeyParam) {
      // New connection via URL params - save machine if not exists
      if (!getMachine(agentId)) {
        addMachine({
          agentId,
          publicKey: publicKeyParam,
          nickname: nameParam || `Machine ${agentId.slice(0, 8)}`,
          icon: '💻',
        });
      }
      onConnect(agentId, publicKeyParam);
    } else {
      // Reconnecting to saved machine
      const machine = getMachine(agentId);
      if (machine) {
        onConnect(machine.agentId, machine.publicKey);
      } else {
        // Machine not found, redirect to home
        navigate('/', { replace: true });
      }
    }

    // Reset on cleanup for StrictMode compatibility
    return () => {
      hasInitiated.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityInitialized, clientReady]); // Re-run when identity and client become ready

  const handleBack = () => {
    onAbort();
    navigate('/', { replace: true });
  };

  // Show error state
  if (state === 'error' && error) {
    return (
      <div className="min-h-screen flex flex-col p-6 bg-slate-900">
        {/* Back button */}
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors self-start"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="w-full max-w-sm text-center">
            {/* Error Icon */}
            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>

            <h1 className="text-xl font-semibold text-white mb-2">Connection Failed</h1>
            <p className="text-slate-400 mb-6">{error}</p>

            <button
              onClick={handleBack}
              className="px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Derive step progress
  const isAgentOffline = connectionStep === 'waiting-for-agent' && agentOnline === false;
  const stepIndex = connectionStep === 'signaling' ? 0
    : connectionStep === 'waiting-for-agent' ? 1
    : connectionStep === 'key-exchange' ? 2
    : connectionStep === 'handshake' ? 3
    : 0;

  const getTitle = () => {
    if (state === 'reconnecting') return 'Reconnecting...';
    if (isAgentOffline) return 'Agent Offline';
    if (connectionStep === 'signaling') return 'Connecting to server...';
    if (connectionStep === 'waiting-for-agent') return 'Checking agent...';
    if (connectionStep === 'key-exchange') return 'Exchanging keys...';
    if (connectionStep === 'handshake') return 'Securing connection...';
    return 'Connecting...';
  };

  const getSubtitle = () => {
    if (state === 'reconnecting') return 'Connection lost, attempting to reconnect';
    if (isAgentOffline) return 'Waiting for agent to come online...';
    if (connectionStep === 'waiting-for-agent' && agentOnline === null) return 'Checking if agent is available';
    if (connectionStep === 'key-exchange' && keyExchangeAttempt) return `Key exchange attempt ${keyExchangeAttempt} of 5`;
    if (connectionStep === 'handshake') return 'Verifying identity';
    return 'Preparing connection';
  };

  // Show connecting animation
  return (
    <div className="min-h-screen flex flex-col p-6 bg-slate-900">
      {/* Back button */}
      <button
        onClick={handleBack}
        className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors self-start"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-full max-w-sm text-center">
          {/* Animated connecting indicator */}
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
                {/* Outer rotating ring */}
                <div className="absolute inset-0 rounded-full border-4 border-slate-700" />
                <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-500 animate-spin" />
                {/* Inner pulsing dot */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-4 h-4 bg-blue-500 rounded-full animate-pulse" />
                </div>
              </>
            )}
          </div>

          <h1 className="text-xl font-semibold text-white mb-2">{getTitle()}</h1>
          <p className="text-slate-400 text-sm">{getSubtitle()}</p>

          {/* Connection steps indicator */}
          <div className="mt-8 flex justify-center gap-3">
            <StepDot active={stepIndex >= 0} completed={stepIndex > 0} label="Server" />
            <StepDot active={stepIndex >= 1} completed={stepIndex > 1} warn={isAgentOffline} label="Agent" />
            <StepDot active={stepIndex >= 2} completed={stepIndex > 2} label="Key" />
            <StepDot active={stepIndex >= 3} completed={false} label="Secure" />
          </div>
        </div>
      </div>
    </div>
  );
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
