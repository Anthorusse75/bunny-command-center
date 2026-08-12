import pino from "pino";

export function createLogger(level: string) {
  const isTty = process.stdout.isTTY;
  return pino({
    level,
    ...(isTty ? { transport: { target: "pino-pretty" } } : {}),
  });
}
