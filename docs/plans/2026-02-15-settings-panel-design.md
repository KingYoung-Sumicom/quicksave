# Settings Slide-in Panel Design

## Overview

Add a settings panel accessible from the home screen (FleetDashboard and ConnectionSetup) via a gear icon in the top-right corner. The panel slides in from the right and contains two sections: API Key configuration and Primary Key backup/restore.

## Trigger

- Gear icon in top-right corner of FleetDashboard header
- Same gear icon on ConnectionSetup page (first-time users with no machines)

## Panel Behavior

- Slides in from the right, full height, ~90% width on mobile (max ~400px)
- Dark overlay behind (click to dismiss)
- Transition: `transform` + `opacity` animation (~200ms ease-out)
- Panel background: `bg-slate-800`

## Panel Layout

### Header
- "Settings" title + X close button (matches existing modal pattern)

### Section 1: API Key
- Reuse existing API key form logic from `Settings.tsx`
- Password input, save button, status indicator, instructions
- When not connected to an agent: show "Connect to a machine first to configure the API key" with input disabled
- When connected: works exactly as current Settings modal

### Section 2: Primary Key Backup

**Export:**
- "Copy to Clipboard" button — copies base64 string, shows "Copied!" feedback
- "Download Backup File" button — downloads `.json` file:
  ```json
  { "version": 1, "masterSecret": "<base64>", "exportedAt": "<ISO date>" }
  ```

**Import/Restore:**
- "Restore from File" button (file input, accepts `.json`)
- "Or paste key" textarea for raw base64 + "Restore" button
- Confirmation dialog before overwriting: "This will replace your current key. Are you sure?"
- Success/error feedback messages

## Files to Create/Modify

- **New**: `apps/pwa/src/components/SettingsPanel.tsx` — the slide-in panel component
- **Modify**: `FleetDashboard.tsx` — add gear icon button + panel toggle state
- **Modify**: `ConnectionSetup.tsx` — add gear icon button
- **Modify**: `App.tsx` — pass `setApiKey` callback if needed

## Existing Code Reuse

- `exportMasterSecret()` and `importMasterSecret()` from `secureStorage.ts`
- API key form logic from `Settings.tsx`
- Styling from existing modals (slate-800, border-slate-700, etc.)
