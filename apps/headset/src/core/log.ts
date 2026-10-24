// Namespaced logging that also keeps a short in-memory history, so the in-headset HUD can show
// recent warnings when remote devtools aren't attached.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  ns: string;
  message: string;
}

const HISTORY = 50;
const history: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

export function recentLogs(): readonly LogEntry[] {
  return history;
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export function createLogger(ns: string): Logger {
  const write = (level: LogLevel, message: string, rest: unknown[]) => {
    const entry: LogEntry = { at: Date.now(), level, ns, message };
    history.push(entry);
    if (history.length > HISTORY) history.shift();
    for (const l of listeners) l(entry);
    const line = `[${ns}] ${message}`;
    if (level === 'error') console.error(line, ...rest);
    else if (level === 'warn') console.warn(line, ...rest);
    else if (level === 'info') console.info(line, ...rest);
    else console.debug(line, ...rest);
  };
  return {
    debug: (m, ...r) => write('debug', m, r),
    info: (m, ...r) => write('info', m, r),
    warn: (m, ...r) => write('warn', m, r),
    error: (m, ...r) => write('error', m, r),
  };
}
