import pino from "pino";
import fs from "node:fs";
import path from "node:path";

export interface LoggerOptions {
  logDir?: string;
  verbose?: boolean;
}

export function initLogger(options: LoggerOptions = {}) {
  const logDir = options.logDir ?? ".wqb/logs";
  const verbose = options.verbose ?? false;

  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Ignore error if directory already exists
  }

  const logFilePath = path.join(logDir, "wqb.log");

  return pino({
    level: verbose ? "debug" : "info",
    transport: {
      targets: [
        {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname"
          },
          level: verbose ? "debug" : "info"
        },
        {
          target: "pino/file",
          options: { destination: logFilePath, mkdir: true },
          level: "debug"
        }
      ]
    }
  });
}

export const logger = initLogger();
