import { useEffect, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface QRScannerProps {
  onScan: (agentId: string, publicKey: string, name?: string) => void;
  onPairingScan?: (publicKey: string) => void;
  onError?: (error: string) => void;
}

export function QRScanner({ onScan, onPairingScan, onError }: QRScannerProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [shouldStart, setShouldStart] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const handleScan = useCallback((decodedText: string) => {
    try {
      // Try to parse as URL
      const url = new URL(decodedText);
      const id = url.searchParams.get('id');
      const pk = url.searchParams.get('pk');

      if (id && pk) {
        const name = url.searchParams.get('name') || undefined;
        // Stop scanning before calling callback
        if (scannerRef.current?.isScanning) {
          scannerRef.current.stop().catch(console.error);
        }
        setIsScanning(false);
        setShouldStart(false);
        onScan(id, pk, name);
        return;
      }

      // Check for pairing URL format: ?pair=PUBLIC_KEY
      const pairKey = url.searchParams.get('pair');
      if (pairKey && onPairingScan) {
        if (scannerRef.current?.isScanning) {
          scannerRef.current.stop().catch(console.error);
        }
        setIsScanning(false);
        setShouldStart(false);
        onPairingScan(pairKey);
        return;
      }

      // Try to parse as JSON (alternative format)
      try {
        const data = JSON.parse(decodedText);
        if (data.id && data.pk) {
          if (scannerRef.current?.isScanning) {
            scannerRef.current.stop().catch(console.error);
          }
          setIsScanning(false);
          setShouldStart(false);
          onScan(data.id, data.pk);
          return;
        }
      } catch {
        // Not JSON, ignore
      }

      // Invalid QR code format
      setError('Invalid QR code. Please scan the QR code from quicksave-agent.');
    } catch {
      // Not a URL, try other formats
      setError('Invalid QR code format.');
    }
  }, [onScan, onPairingScan]);

  // Start scanner when shouldStart becomes true and element is mounted
  useEffect(() => {
    if (!shouldStart) return;

    const scannerId = 'qr-scanner';
    const element = document.getElementById(scannerId);
    if (!element) return;

    const startScanner = async () => {
      setIsStarting(true);
      setError(null);
      setPermissionDenied(false);

      try {
        scannerRef.current = new Html5Qrcode(scannerId);

        await scannerRef.current.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 250, height: 250 },
          },
          (decodedText) => {
            handleScan(decodedText);
          },
          () => {
            // QR code not found - ignore
          }
        );

        setIsScanning(true);
        setError(null);
      } catch (err) {
        console.error('Failed to start scanner:', err);
        const message = err instanceof Error ? err.message : 'Failed to access camera';
        setError(message);
        setPermissionDenied(true);
        setShouldStart(false);
        onError?.(message);
      } finally {
        setIsStarting(false);
      }
    };

    startScanner();
  }, [shouldStart, handleScan, onError]);

  const stopScanner = useCallback(async () => {
    if (scannerRef.current?.isScanning) {
      await scannerRef.current.stop().catch(console.error);
    }
    setIsScanning(false);
    setShouldStart(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(console.error);
      }
    };
  }, []);

  const showStartButton = !shouldStart && !isScanning;

  return (
    <div className="text-center">
      {/* Scanner area */}
      <div className="relative w-full max-w-[280px] mx-auto mb-4">
        {/* Placeholder shown when not scanning */}
        {showStartButton && (
          <div className="w-full aspect-square bg-slate-700 rounded-lg flex items-center justify-center">
            <svg
              className="w-16 h-16 text-slate-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
              />
            </svg>
          </div>
        )}

        {/* Scanner container - rendered when starting/scanning */}
        {(shouldStart || isScanning) && (
          <>
            {/* Loading overlay */}
            {isStarting && (
              <div className="absolute inset-0 bg-slate-700 rounded-lg flex items-center justify-center z-10">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
              </div>
            )}

            {/* The actual scanner element - kept empty for html5-qrcode */}
            <div
              id="qr-scanner"
              className="w-full aspect-square bg-slate-700 rounded-lg overflow-hidden"
            />

            {/* Scanning indicator overlay */}
            {isScanning && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-4 border-2 border-blue-500 rounded-lg">
                  <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-blue-400 rounded-tl" />
                  <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-blue-400 rounded-tr" />
                  <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-blue-400 rounded-bl" />
                  <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-blue-400 rounded-br" />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Status messages */}
      {showStartButton && (
        permissionDenied ? (
          <>
            <p className="text-red-400 text-sm mb-2">Camera access denied</p>
            <p className="text-slate-400 text-xs mb-4">
              Please allow camera access in your browser settings.
            </p>
          </>
        ) : error ? (
          <p className="text-yellow-400 text-sm mb-4">{error}</p>
        ) : (
          <p className="text-slate-400 text-sm mb-4">
            Tap the button below to scan the QR code from your agent.
          </p>
        )
      )}

      {isStarting && (
        <p className="text-slate-400 text-sm mb-4">Starting camera...</p>
      )}

      {isScanning && !error && (
        <p className="text-slate-400 text-sm mb-4">
          Point your camera at the QR code displayed by the agent.
        </p>
      )}

      {isScanning && error && (
        <p className="text-yellow-400 text-sm mb-4">{error}</p>
      )}

      {/* Action buttons */}
      {showStartButton && (
        <button
          onClick={() => setShouldStart(true)}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium text-white transition-colors"
        >
          {permissionDenied ? 'Try Again' : 'Start Camera'}
        </button>
      )}

      {isScanning && (
        <button
          onClick={stopScanner}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 rounded-lg text-sm text-white transition-colors"
        >
          Stop Camera
        </button>
      )}
    </div>
  );
}
