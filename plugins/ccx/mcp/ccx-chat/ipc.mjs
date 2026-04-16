import { createConnection } from 'node:net';

export function framer(onMessage) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  };
}

export function writeJson(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`);
}

export function connect(path, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    const timer = setTimeout(() => {
      sock.destroy();
      const err = new Error(`ipc connect timeout after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
