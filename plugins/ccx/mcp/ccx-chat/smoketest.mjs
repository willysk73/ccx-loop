#!/usr/bin/env node
import { connect, framer, writeJson } from './ipc.mjs';
import { SOCK } from './paths.mjs';

const TIMEOUT_MS = 15000;

(async () => {
  let sock;
  try {
    sock = await connect(SOCK, { timeoutMs: 2000 });
  } catch (err) {
    console.error(`[smoketest] cannot reach broker at ${SOCK}: ${err.message}`);
    process.exit(2);
  }

  const reqId = `smoke-${Date.now()}`;
  const finished = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `broker response timeout after ${TIMEOUT_MS}ms` }), TIMEOUT_MS);
    sock.on('data', framer((msg) => {
      if (msg.reqId !== reqId) return;
      clearTimeout(timer);
      resolve(msg);
    }));
    sock.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    sock.on('close', () => { clearTimeout(timer); resolve({ ok: false, error: 'broker closed connection' }); });
  });

  // Wait for Discord readiness before sending the test message.
  const readyReqId = `ready-${Date.now()}`;
  const readyFinished = new Promise((resolve) => {
    const readyTimer = setTimeout(() => resolve({ ok: false, error: 'waitReady timeout' }), TIMEOUT_MS);
    sock.on('data', framer((msg) => {
      if (msg.reqId !== readyReqId) return;
      clearTimeout(readyTimer);
      resolve(msg);
    }));
  });
  writeJson(sock, { op: 'waitReady', reqId: readyReqId, params: {} });
  const readyResult = await readyFinished;
  if (!readyResult.ok) {
    console.error(`[smoketest] broker not ready: ${readyResult.error ?? 'unknown'}`);
    sock.destroy();
    process.exit(3);
  }

  writeJson(sock, { op: 'smoketest', reqId, params: { text: '✅ ccx-chat setup smoke test — please ignore.' } });

  const msg = await finished;
  sock.destroy();
  if (msg.ok) {
    console.log(`[smoketest] ok — Discord send succeeded (${JSON.stringify(msg.result)})`);
    process.exit(0);
  }
  console.error(`[smoketest] FAIL — ${msg.error ?? 'unknown'}`);
  process.exit(1);
})();
