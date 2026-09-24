import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { resolve } from 'node:path';

const host = '127.0.0.1';
const port = await reservePort(host);
const exportRoot = resolve(import.meta.dirname, '..', 'out');
const server = createServer((request, response) => {
  void serveExport(request, response);
});

async function serveExport(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? '/', `http://${host}:${String(port)}`).pathname;
  const file =
    pathname === '/registration/success/' ? 'registration/success/index.html' : 'index.html';
  if (request.method !== 'GET' || (pathname !== '/' && pathname !== '/registration/success/')) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }
  try {
    const html = await readFile(resolve(exportRoot, file));
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(html);
  } catch {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Static export unavailable');
  }
}

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(port, host, resolveListen);
});

try {
  const origin = `http://${host}:${String(port)}`;
  const [registration, success] = await Promise.all([
    fetch(origin),
    fetch(`${origin}/registration/success/`),
  ]);
  const [registrationHtml, successHtml] = await Promise.all([registration.text(), success.text()]);
  if (
    !registration.ok ||
    !registrationHtml.includes('Devrandom Labs') ||
    !registrationHtml.includes('registration')
  ) {
    throw new Error('site smoke did not return the registration page');
  }
  if (!success.ok || !successHtml.includes('Credential issued')) {
    throw new Error('site smoke did not return the success page');
  }
} finally {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

async function reservePort(hostname: string): Promise<number> {
  const socket = createTcpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    socket.once('error', rejectListen);
    socket.listen(0, hostname, resolveListen);
  });
  const address = socket.address();
  if (address === null || typeof address === 'string') {
    throw new Error('site smoke could not reserve a TCP port');
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    socket.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
  return address.port;
}
