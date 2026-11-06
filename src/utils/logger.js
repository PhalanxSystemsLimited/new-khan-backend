import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-signature"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[REDACTED]',
  },
  ...(env.isProd
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }),
});
