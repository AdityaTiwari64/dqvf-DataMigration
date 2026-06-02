export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let globalLevel: LogLevel = 'INFO';

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  agent?: string;
  message: string;
  data?: Record<string, unknown>;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[globalLevel];
}

function formatEntry(entry: LogEntry): string {
  const parts = [
    `[${entry.timestamp}]`,
    `[${entry.level}]`,
    entry.agent ? `[${entry.agent}]` : '',
    entry.message,
  ].filter(Boolean);

  let line = parts.join(' ');
  if (entry.data && Object.keys(entry.data).length > 0) {
    line += ' ' + JSON.stringify(entry.data);
  }
  return line;
}

// All log output goes to stderr so stdout stays clean for JSON / MCP protocol
function emit(level: LogLevel, message: string, agent?: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const formatted = formatEntry({ timestamp: new Date().toISOString(), level, agent, message, data });
  process.stderr.write(formatted + '\n');
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => emit('DEBUG', msg, scope, data),
    info:  (msg: string, data?: Record<string, unknown>) => emit('INFO',  msg, scope, data),
    warn:  (msg: string, data?: Record<string, unknown>) => emit('WARN',  msg, scope, data),
    error: (msg: string, data?: Record<string, unknown>) => emit('ERROR', msg, scope, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
