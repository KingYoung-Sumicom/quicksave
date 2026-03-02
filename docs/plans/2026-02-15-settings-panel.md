# Settings Slide-in Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a settings slide-in panel accessible from the home screen with API key configuration and primary key export/import.

**Architecture:** A new `SettingsPanel` component renders as a right-side slide-in drawer with overlay. It is toggled from a gear icon added to `FleetDashboard` and `ConnectionSetup` headers. API key section reuses logic from existing `Settings.tsx`. Primary key section uses existing `exportMasterSecret`/`importMasterSecret` from `secureStorage.ts`.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Zustand, IndexedDB (via secureStorage)

---

### Task 1: Add slide-in panel CSS animation

**Files:**
- Modify: `apps/pwa/src/index.css`

**Step 1: Add the slide-in keyframe and utility class**

Add at the end of `apps/pwa/src/index.css`:

```css
/* Settings panel slide-in */
@keyframes slide-in-right {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}

.animate-slide-in-right {
  animation: slide-in-right 0.2s ease-out;
}
```

**Step 2: Verify no build errors**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm --filter pwa build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/pwa/src/index.css
git commit -m "feat: add slide-in-right CSS animation for settings panel"
```

---

### Task 2: Create SettingsPanel component — Primary Key section

This is the core new functionality. Build primary key export/import first since it's self-contained.

**Files:**
- Create: `apps/pwa/src/components/SettingsPanel.tsx`

**Step 1: Create the SettingsPanel component**

Create `apps/pwa/src/components/SettingsPanel.tsx` with:

```tsx
import { useState, useRef } from 'react';
import { exportMasterSecret, importMasterSecret } from '../lib/secureStorage';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  // Primary key state
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCopyKey = async () => {
    try {
      const secret = await exportMasterSecret();
      await navigator.clipboard.writeText(secret);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {
      setImportError('Failed to copy key to clipboard');
    }
  };

  const handleDownloadKey = async () => {
    try {
      const secret = await exportMasterSecret();
      const backup = JSON.stringify({
        version: 1,
        masterSecret: secret,
        exportedAt: new Date().toISOString(),
      }, null, 2);
      const blob = new Blob([backup], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quicksave-key-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setImportError('Failed to download key');
    }
  };

  const confirmImport = (secret: string) => {
    setPendingImport(secret);
    setShowConfirm(true);
  };

  const executeImport = async () => {
    if (!pendingImport) return;
    setShowConfirm(false);
    setImportError(null);
    setImportSuccess(false);
    try {
      await importMasterSecret(pendingImport);
      setImportSuccess(true);
      setImportText('');
      setPendingImport(null);
      setTimeout(() => setImportSuccess(false), 3000);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import key');
      setPendingImport(null);
    }
  };

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data.masterSecret) {
          setImportError('Invalid backup file: missing masterSecret');
          return;
        }
        confirmImport(data.masterSecret);
      } catch {
        setImportError('Invalid backup file format');
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const handleTextImport = () => {
    if (!importText.trim()) {
      setImportError('Please paste a key');
      return;
    }
    confirmImport(importText.trim());
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 w-[90%] max-w-[400px] bg-slate-800 z-50 animate-slide-in-right flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">

          {/* Primary Key Backup Section */}
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wide">Primary Key</h3>
            <p className="text-xs text-slate-400">
              Your primary key encrypts all connections. Back it up to restore access on a new device.
            </p>

            {/* Export */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-300">Export</p>
              <div className="flex gap-2">
                <button
                  onClick={handleCopyKey}
                  className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
                >
                  {copyFeedback ? 'Copied!' : 'Copy to Clipboard'}
                </button>
                <button
                  onClick={handleDownloadKey}
                  className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
                >
                  Download File
                </button>
              </div>
            </div>

            {/* Import */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-300">Restore</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
              >
                Restore from File
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleFileImport}
                className="hidden"
              />

              <div className="relative">
                <p className="text-xs text-slate-400 mb-1">Or paste key:</p>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="Paste base64 key here..."
                  rows={2}
                  className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none font-mono text-xs"
                />
                <button
                  onClick={handleTextImport}
                  disabled={!importText.trim()}
                  className="mt-1 w-full py-2 px-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md text-sm font-medium text-white transition-colors"
                >
                  Restore
                </button>
              </div>
            </div>

            {importError && (
              <div className="p-2 bg-red-500/20 border border-red-500/50 rounded text-sm text-red-400">
                {importError}
              </div>
            )}

            {importSuccess && (
              <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
                Key restored successfully!
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
          <div className="bg-slate-800 rounded-lg p-6 max-w-sm w-full shadow-xl border border-slate-700">
            <h3 className="text-lg font-semibold text-white mb-2">Replace Primary Key?</h3>
            <p className="text-sm text-slate-400 mb-4">
              This will replace your current key. Existing machine connections may need to be re-established.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => { setShowConfirm(false); setPendingImport(null); }}
                className="flex-1 py-2 px-3 bg-slate-700 hover:bg-slate-600 rounded-md text-sm font-medium text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeImport}
                className="flex-1 py-2 px-3 bg-red-600 hover:bg-red-700 rounded-md text-sm font-medium text-white transition-colors"
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

**Step 2: Verify build**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm --filter pwa build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/pwa/src/components/SettingsPanel.tsx
git commit -m "feat: create SettingsPanel component with primary key export/import"
```

---

### Task 3: Add API Key section to SettingsPanel

**Files:**
- Modify: `apps/pwa/src/components/SettingsPanel.tsx`

**Step 1: Add API key props and section**

Add an optional `onSaveApiKey` prop to `SettingsPanelProps`:

```tsx
interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveApiKey?: (apiKey: string) => Promise<boolean>;
}
```

Add API key state variables alongside the existing ones:

```tsx
const { apiKeyConfigured } = useGitStore();
const [apiKey, setApiKey] = useState('');
const [apiKeySaving, setApiKeySaving] = useState(false);
const [apiKeyError, setApiKeyError] = useState<string | null>(null);
const [apiKeySuccess, setApiKeySuccess] = useState(false);
```

Add the import for `useGitStore`:

```tsx
import { useGitStore } from '../stores/gitStore';
```

Add API key save handler:

```tsx
const handleSaveApiKey = async () => {
  if (!apiKey.trim() || !onSaveApiKey) return;
  setApiKeySaving(true);
  setApiKeyError(null);
  setApiKeySuccess(false);
  try {
    const result = await onSaveApiKey(apiKey.trim());
    if (result) {
      setApiKeySuccess(true);
      setApiKey('');
      setTimeout(() => setApiKeySuccess(false), 2000);
    } else {
      setApiKeyError('Failed to save API key');
    }
  } catch (err) {
    setApiKeyError(err instanceof Error ? err.message : 'Failed to save API key');
  } finally {
    setApiKeySaving(false);
  }
};
```

Insert the API Key section BEFORE the Primary Key section in the scrollable content area:

```tsx
{/* API Key Section */}
<section className="space-y-3">
  <h3 className="text-sm font-medium text-slate-300 uppercase tracking-wide">Anthropic API Key</h3>

  {!onSaveApiKey ? (
    <p className="text-xs text-slate-400">
      Connect to a machine first to configure the API key.
    </p>
  ) : (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">Required for AI commit summaries</p>
        {apiKeyConfigured && (
          <span className="text-xs text-green-400 flex items-center gap-1">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
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
        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
        disabled={apiKeySaving}
      />

      <p className="text-xs text-slate-500">
        Your API key is stored on your local machine and never sent to our servers.
      </p>

      {apiKeyError && (
        <div className="p-2 bg-red-500/20 border border-red-500/50 rounded text-sm text-red-400">
          {apiKeyError}
        </div>
      )}

      {apiKeySuccess && (
        <div className="p-2 bg-green-500/20 border border-green-500/50 rounded text-sm text-green-400">
          API key saved!
        </div>
      )}

      <button
        onClick={handleSaveApiKey}
        disabled={apiKeySaving || !apiKey.trim()}
        className="w-full py-2 px-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-md text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
      >
        {apiKeySaving ? (
          <>
            <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Saving...
          </>
        ) : (
          'Save API Key'
        )}
      </button>
    </>
  )}
</section>

{/* Divider between sections */}
<div className="border-t border-slate-700" />
```

**Step 2: Verify build**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm --filter pwa build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/pwa/src/components/SettingsPanel.tsx
git commit -m "feat: add API key configuration section to SettingsPanel"
```

---

### Task 4: Add gear icon to FleetDashboard

**Files:**
- Modify: `apps/pwa/src/components/FleetDashboard.tsx`

**Step 1: Add SettingsPanel import and state**

Add to imports:

```tsx
import { SettingsPanel } from './SettingsPanel';
```

Add state inside the `FleetDashboard` component:

```tsx
const [showSettings, setShowSettings] = useState(false);
```

**Step 2: Add gear icon to the header**

Replace the existing header `<div>`:

```tsx
{/* Header */}
<div className="text-center mb-8 relative">
  <button
    onClick={() => setShowSettings(true)}
    className="absolute right-0 top-0 p-2 text-slate-400 hover:text-white transition-colors"
    aria-label="Settings"
  >
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  </button>
  <h1 className="text-3xl font-bold text-white mb-2">Quicksave</h1>
  <p className="text-slate-400">Select a machine to connect</p>
</div>
```

**Step 3: Add SettingsPanel render at bottom of component return, before closing `</div>`**

Add after the `EditMachineModal` block:

```tsx
{/* Settings Panel */}
<SettingsPanel
  isOpen={showSettings}
  onClose={() => setShowSettings(false)}
/>
```

**Step 4: Verify build**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm --filter pwa build 2>&1 | tail -5`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add apps/pwa/src/components/FleetDashboard.tsx
git commit -m "feat: add gear icon and settings panel to FleetDashboard"
```

---

### Task 5: Add gear icon to ConnectionSetup

**Files:**
- Modify: `apps/pwa/src/components/ConnectionSetup.tsx`

**Step 1: Add SettingsPanel import and state**

Add to imports:

```tsx
import { SettingsPanel } from './SettingsPanel';
```

Add state inside the component:

```tsx
const [showSettings, setShowSettings] = useState(false);
```

**Step 2: Add gear icon to the header**

Replace the existing logo `<div>`:

```tsx
{/* Logo */}
<div className="text-center mb-8 relative">
  <button
    onClick={() => setShowSettings(true)}
    className="absolute right-0 top-0 p-2 text-slate-400 hover:text-white transition-colors"
    aria-label="Settings"
  >
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  </button>
  <h1 className="text-3xl font-bold text-white mb-2">Quicksave</h1>
  <p className="text-slate-400">Remote git control with E2E encryption</p>
</div>
```

**Step 3: Add SettingsPanel render before the closing `</div>` of the outermost container**

```tsx
{/* Settings Panel */}
<SettingsPanel
  isOpen={showSettings}
  onClose={() => setShowSettings(false)}
/>
```

**Step 4: Verify build**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm --filter pwa build 2>&1 | tail -5`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add apps/pwa/src/components/ConnectionSetup.tsx
git commit -m "feat: add gear icon and settings panel to ConnectionSetup"
```

---

### Task 6: Wire up API key save when connected

The `onSaveApiKey` prop should only be passed when the user is connected to an agent (since the API key is sent to the agent). This requires threading `setApiKey` from `App.tsx` through to the home components.

**Files:**
- Modify: `apps/pwa/src/components/FleetDashboard.tsx`
- Modify: `apps/pwa/src/components/ConnectionSetup.tsx`
- Modify: `apps/pwa/src/App.tsx`

**Step 1: Add `onSaveApiKey` prop to FleetDashboard and ConnectionSetup**

In `FleetDashboard.tsx`, update props interface:

```tsx
interface FleetDashboardProps {
  onConnect: (agentId: string, publicKey: string) => void;
  onSaveApiKey?: (apiKey: string) => Promise<boolean>;
}
```

Update destructuring:

```tsx
export function FleetDashboard({ onConnect, onSaveApiKey }: FleetDashboardProps) {
```

Pass to SettingsPanel:

```tsx
<SettingsPanel
  isOpen={showSettings}
  onClose={() => setShowSettings(false)}
  onSaveApiKey={onSaveApiKey}
/>
```

In `ConnectionSetup.tsx`, update props interface:

```tsx
interface Props {
  onConnect: (agentId: string, publicKey: string) => void;
  onSaveApiKey?: (apiKey: string) => Promise<boolean>;
}
```

Update destructuring:

```tsx
export function ConnectionSetup({ onConnect, onSaveApiKey }: Props) {
```

Pass to SettingsPanel:

```tsx
<SettingsPanel
  isOpen={showSettings}
  onClose={() => setShowSettings(false)}
  onSaveApiKey={onSaveApiKey}
/>
```

**Step 2: Pass `setApiKey` from App.tsx**

In `App.tsx`, update the `homeElement` useMemo to pass `onSaveApiKey`:

```tsx
const homeElement = useMemo(() => {
  const saveApiKey = isConnected ? setApiKey : undefined;
  return machines.length > 0 ? (
    <FleetDashboard onConnect={handleConnect} onSaveApiKey={saveApiKey} />
  ) : (
    <ConnectionSetup onConnect={handleConnect} onSaveApiKey={saveApiKey} />
  );
}, [machines.length, handleConnect, isConnected, setApiKey]);
```

Add `setApiKey` to the dependency array (it should already be available from `useGitOperations`).

**Step 3: Verify build**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm --filter pwa build 2>&1 | tail -5`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add apps/pwa/src/components/FleetDashboard.tsx apps/pwa/src/components/ConnectionSetup.tsx apps/pwa/src/App.tsx
git commit -m "feat: wire up API key save to settings panel when connected"
```

---

### Task 7: Manual verification

**Step 1: Start the dev server**

Run: `cd /Users/jimmy/workspace/quicksave && pnpm --filter pwa dev`

**Step 2: Verify in browser**

1. Open the PWA in browser
2. Verify gear icon appears in top-right of home screen
3. Click gear icon — panel slides in from right
4. Verify overlay appears and clicking it closes the panel
5. Verify "Primary Key" section with Export (Copy/Download) and Restore
6. Click "Copy to Clipboard" — verify it copies and shows "Copied!" feedback
7. Click "Download File" — verify a `.json` file downloads
8. Test restore from the downloaded file — verify confirmation dialog appears
9. Verify API key section shows "Connect to a machine first" message when disconnected
10. If able to connect to agent, verify API key section becomes active

**Step 3: Commit any fixes if needed**
