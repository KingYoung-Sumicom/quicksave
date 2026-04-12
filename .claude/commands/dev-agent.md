---
description: Restart quicksave daemon from source with tsx (dev mode)
---

Restart the quicksave dev daemon. Kill any existing daemon, then spawn a new one from source using tsx.

## Steps

1. Kill existing daemon:

```bash
quicksave service stop 2>/dev/null || true
```

If that fails, force kill:

```bash
kill $(cat ~/.quicksave/run/service.lock 2>/dev/null) 2>/dev/null || true
```

2. Wait briefly for the process to die, then spawn the dev daemon:

```bash
cd /Users/jimmy/workspace/quicksave/apps/agent && nohup node --import tsx src/index.ts service run >> ~/.quicksave/run/daemon.log 2>&1 &
```

3. Verify it started:

```bash
quicksave service status
```

Confirm the output shows version `0.6.0` (or whatever the current dev version is) and `connected` status.

If it fails, check the log:

```bash
tail -30 ~/.quicksave/run/daemon.log
```
