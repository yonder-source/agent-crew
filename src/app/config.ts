import { z } from 'zod';

const environmentSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_PATH: z.string().trim().min(1).default('./state/agent-crew.sqlite'),
  LOCK_PATH: z.string().trim().min(1).default('./state/controller.lock'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type ControllerConfig = {
  host: string;
  port: number;
  databasePath: string;
  lockPath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
};

export type ConfigResult =
  | { success: true; config: ControllerConfig }
  | { success: false; issues: Array<{ field: string; message: string }> };

export function loadConfig(environment: NodeJS.ProcessEnv): ConfigResult {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'environment',
        message: issue.message,
      })),
    };
  }

  return {
    success: true,
    config: {
      host: result.data.HOST,
      port: result.data.PORT,
      databasePath: result.data.DATABASE_PATH,
      lockPath: result.data.LOCK_PATH,
      logLevel: result.data.LOG_LEVEL,
    },
  };
}
