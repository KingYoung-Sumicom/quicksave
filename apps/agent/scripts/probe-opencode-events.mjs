#!/usr/bin/env node
// Probe: spawn opencode serve, create a session, send a bash-using prompt,
// dump every SSE event type until session.idle.
import { spawn } from 'child_process';

const bin = process.env.OPENCODE_BIN || 'opencode';
const MODEL = process.env.MODEL || 'vllm/palmfuture/Qwen3.6-35B-A3B-GPTQ-Int4';
const PROMPT = process.env.PROMPT || 'Run the shell command `ls -la /tmp` using the bash tool and tell me the result.';

const proc = spawn(bin, ['serve', '--port', '0', '--print-logs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

let port = null;
const onLine = (buf) => {
  const text = buf.toString();
  const m = text.match(/listening on https?:\/\/[^:]+:(\d+)/);
  if (m && !port) { port = Number(m[1]); main().catch((e) => { console.error(e); proc.kill('SIGTERM'); process.exit(1); }); }
};
proc.stdout.on('data', onLine);
proc.stderr.on('data', onLine);

async function main() {
  const baseUrl = `http://127.0.0.1:${port}`;
  console.error(`[probe] opencode serve on ${baseUrl}`);

  // Subscribe to /event in the background
  const ac = new AbortController();
  const sseDone = (async () => {
    const resp = await fetch(`${baseUrl}/event`, { signal: ac.signal });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        try {
          const ev = JSON.parse(dataLines.join('\n'));
          const partType = ev?.properties?.part?.type;
          const toolName = ev?.properties?.part?.tool ?? ev?.properties?.name;
          const status = ev?.properties?.part?.state?.status;
          if (process.env.VERBOSE) {
            console.log(`[ev] ${JSON.stringify(ev)}`);
          } else {
            console.log(`[ev] type=${ev.type}${partType ? ` part.type=${partType}` : ''}${toolName ? ` tool=${toolName}` : ''}${status ? ` status=${status}` : ''}`);
          }
          if (ev.type === 'session.idle') { ac.abort(); return; }
        } catch (e) { /* ignore */ }
      }
    }
  })().catch((e) => { if (!ac.signal.aborted) console.error('[sse]', e); });

  // Create session
  const cs = await fetch(`${baseUrl}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory: process.cwd(), agent: 'build' }),
  });
  const { id: sid } = await cs.json();
  console.error(`[probe] created session ${sid}`);

  const [providerID, ...modelParts] = MODEL.split('/');
  const modelID = modelParts.join('/');
  const pr = await fetch(`${baseUrl}/session/${encodeURIComponent(sid)}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: { providerID, modelID },
      parts: [{ type: 'text', text: PROMPT }],
    }),
  });
  if (!pr.ok) { console.error('prompt failed', pr.status, await pr.text()); ac.abort(); proc.kill('SIGTERM'); process.exit(1); }
  console.error(`[probe] prompt sent`);

  await sseDone;
  console.error(`[probe] session idle — shutting down`);
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

proc.on('exit', (code, signal) => {
  console.error(`[probe] opencode serve exited code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

setTimeout(() => {
  if (!port) { console.error('opencode serve did not start within 15s'); proc.kill('SIGTERM'); process.exit(1); }
}, 15_000);
