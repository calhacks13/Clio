/** The server's only logging port, so tests can capture or silence output. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, error) =>
    error === undefined ? console.error(message) : console.error(message, error),
};

/** A short, single-line description of an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
