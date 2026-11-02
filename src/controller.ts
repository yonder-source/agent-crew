import { createServer, type Server } from 'node:http';
import pino, { type Logger } from 'pino';
import type { ControllerConfig } from './config.js';
import { getSchemaVersion, openDatabase } from './database.js';

export type RunningController = {
  server: Server;
  close: () => Promise<void>;
  address: string;
};

export function createLogger(level: ControllerConfig['logLevel']): Logger {
  return pino({ level });
}

export async function startController(
  config: ControllerConfig,
  logger: Logger,
): Promise<RunningController> {
  const database = openDatabase(config.databasePath);
  const schemaVersion = getSchemaVersion(database);
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', schemaVersion }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.off('error', onError);
        resolveListen();
      });
    });
  } catch (error) {
    database.close();
    throw error;
  }

  const listenerAddress = server.address();
  if (!listenerAddress || typeof listenerAddress === 'string') {
    database.close();
    throw new Error('Controller did not bind a TCP address');
  }
  const address = `http://${config.host}:${listenerAddress.port}`;
  logger.info({ host: config.host, port: listenerAddress.port, schemaVersion }, 'Controller started');

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        database.close();
        if (error) {
          rejectClose(error);
          return;
        }
        logger.info('Controller stopped');
        resolveClose();
      });
    });
    return closePromise;
  };

  return { server, close, address };
}
