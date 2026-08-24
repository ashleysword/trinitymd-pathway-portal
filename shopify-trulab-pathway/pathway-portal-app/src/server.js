import http from 'node:http';
import { Readable } from 'node:stream';
import { jsonResponse } from './app.js';
import { getPortalRuntime } from './runtime.js';

const { config, handler } = getPortalRuntime();

function toWebRequest(request) {
  const url = new URL(request.url, `https://${request.headers.host || config.shop}`);
  const init = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function writeWebResponse(response, nodeResponse) {
  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer(async (request, response) => {
  try {
    await writeWebResponse(await handler(toWebRequest(request)), response);
  } catch (error) {
    console.error('PATHWAY Node adapter failed.', error);
    await writeWebResponse(
      jsonResponse(500, { error: 'The secure portal could not complete that request.' }),
      response,
    );
  }
});

server.listen(config.port, () => {
  console.log(`TrinityMD PATHWAY portal API listening on port ${config.port}`);
});

function shutdown() {
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
