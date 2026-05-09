/**
 * Secure Logger for Edge Functions
 * Automatically sanitizes sensitive data to prevent PII leakage
 */

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

interface LogContext {
  [key: string]: any;
}

/**
 * Sanitizes sensitive data from objects
 * - Truncates UUIDs to first 8 characters
 * - Masks email addresses
 * - Hides password fields
 * - Truncates phone numbers
 */
function sanitizeData(data: any): any {
  if (typeof data === 'string') {
    // Mask emails
    if (data.includes('@')) {
      const [local, domain] = data.split('@');
      return `${local.substring(0, 2)}***@${domain}`;
    }
    
    // Truncate UUIDs (36 chars with dashes)
    if (data.length === 36 && data.includes('-')) {
      return `${data.substring(0, 8)}...`;
    }
    
    // Mask phone numbers
    if (/^\+?\d{10,}$/.test(data)) {
      return `***${data.slice(-4)}`;
    }
    
    return data;
  }
  
  if (Array.isArray(data)) {
    return data.map(sanitizeData);
  }
  
  if (data && typeof data === 'object') {
    const sanitized: any = {};
    
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      
      // Hide password fields completely
      if (lowerKey.includes('password') || lowerKey.includes('senha')) {
        sanitized[key] = '***REDACTED***';
        continue;
      }
      
      // Hide token fields
      if (lowerKey.includes('token') || lowerKey.includes('key')) {
        sanitized[key] = '***REDACTED***';
        continue;
      }
      
      // Sanitize IDs
      if (lowerKey.includes('_id') || lowerKey === 'id') {
        sanitized[key] = typeof value === 'string' && value.length === 36 
          ? `${value.substring(0, 8)}...` 
          : value;
        continue;
      }
      
      // Recursively sanitize nested objects
      sanitized[key] = sanitizeData(value);
    }
    
    return sanitized;
  }
  
  return data;
}

/**
 * Formats log message with timestamp and level
 */
function formatMessage(level: LogLevel, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString();
  const sanitizedContext = context ? sanitizeData(context) : undefined;
  
  const contextStr = sanitizedContext 
    ? ` | ${JSON.stringify(sanitizedContext)}` 
    : '';
  
  return `[${timestamp}] ${level}: ${message}${contextStr}`;
}

/**
 * Logger class with sanitization
 */
export class EdgeLogger {
  private serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  info(message: string, context?: LogContext) {
    console.log(formatMessage('INFO', `[${this.serviceName}] ${message}`, context));
  }

  warn(message: string, context?: LogContext) {
    console.warn(formatMessage('WARN', `[${this.serviceName}] ${message}`, context));
  }

  error(message: string, error?: Error | unknown, context?: LogContext) {
    const errorContext = {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error(formatMessage('ERROR', `[${this.serviceName}] ${message}`, errorContext));
  }

  debug(message: string, context?: LogContext) {
    // Only log debug in development
    if (Deno.env.get('ENVIRONMENT') !== 'production') {
      console.log(formatMessage('DEBUG', `[${this.serviceName}] ${message}`, context));
    }
  }
}

/**
 * Creates a logger instance for a specific service
 */
export function createLogger(serviceName: string): EdgeLogger {
  return new EdgeLogger(serviceName);
}
