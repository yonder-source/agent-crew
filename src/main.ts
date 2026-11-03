import { createLogger, startController } from './app/controller.js';
import { loadConfig } from './app/config.js';

const result = loadConfig(process.env);

if (!result.success) {
  console.error(JSON.stringify({
    level: 'fatal',
    message: 'Invalid Controller configuration',
    issues: result.issues,
  }));
  process.exitCode = 1;
} else {
  const logger = createLogger(result.config.logLevel);

  try {
    const controller = await startController(result.config, logger);
    let stopping = false;

    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      logger.info({ signal }, 'Shutdown requested');
      void controller.close().catch((error: unknown) => {
        logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Shutdown failed');
        process.exitCode = 1;
      });
    };

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    logger.fatal(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'Controller failed to start; check the database path and port availability',
    );
    process.exitCode = 1;
  }
}
