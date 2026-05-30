---
description: Restart quicksave daemon from source with tsx (dev mode)
---

Restart the quicksave dev daemon from source using the repo script. This is a forced restart: daemon-owned Claude / Codex sessions will be killed when the daemon exits.

## Steps

1. Schedule the forced delayed restart:

```bash
bash scripts/dev-daemon-delayed.sh 5
```

Use a longer delay if you need time to return a final message before the daemon exits:

```bash
bash scripts/dev-daemon-delayed.sh 30
```

2. Verify it started after the delay:

```bash
quicksave service status
```

If it fails, check the log:

```bash
tail -30 ~/.quicksave/run/daemon.log
```
