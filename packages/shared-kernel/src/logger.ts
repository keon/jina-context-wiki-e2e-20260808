export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export const consoleLogger: Logger = {
  log(level, message, fields) {
    console[level === "debug" ? "log" : level](message, fields ?? {});
  },
};

