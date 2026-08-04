type LogFields = Record<string, unknown>;

/** Portable review-runtime logger. Trigger adapters keep their SDK logger, while
 * Board workers use this implementation without importing Trigger at runtime. */
export const logger = {
  info(message: string, fields: LogFields = {}): void {
    write("INFO", message, fields);
  },
  warn(message: string, fields: LogFields = {}): void {
    write("WARNING", message, fields);
  }
};

function write(severity: "INFO" | "WARNING", message: string, fields: LogFields): void {
  const record = JSON.stringify({
    severity,
    time: new Date().toISOString(),
    message,
    service: process.env.K_SERVICE ?? "jina-review-agent",
    ...fields
  });
  if (severity === "WARNING") console.warn(record);
  else console.info(record);
}
