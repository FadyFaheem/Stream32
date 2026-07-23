const {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_KEEP_FILES = 5;
const MAX_LINE_BYTES = 8 * 1024;
const SENSITIVE_KEY =
  /action|command|field|image|password|path|port|secret|serial|setting|token|url/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeLogText(value, { homeDirectory, userDataDirectory } = {}) {
  let text = String(value)
    .replace(/data:[^\s"'<>]+/gi, '[data-url]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(
      /\b(password|secret|token|api[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi,
      '$1=[redacted]',
    );

  for (const directory of [homeDirectory, userDataDirectory]) {
    if (directory) {
      text = text.replace(
        new RegExp(escapeRegExp(directory), 'gi'),
        '[redacted-path]',
      );
    }
  }

  text = text
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, '[home]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '[home]')
    .replace(/\bCOM\d+\b/gi, '[port]')
    .replace(/\/dev\/(?:cu\.|tty)[^\s,;]+/gi, '[port]');

  if (/^\s*(?:\$|>|cmd(?:\.exe)?\s|powershell\s|bash\s)/i.test(text)) {
    return '[command line redacted]';
  }

  if (/\b(?:action text|command line)\b\s*[:=]/i.test(text)) {
    return '[sensitive text redacted]';
  }

  return text.replace(/[\r\n]+/g, ' ').slice(0, 2000);
}

function sanitizeDetails(value, options, key = '') {
  if (SENSITIVE_KEY.test(key)) {
    return '[redacted]';
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeLogText(value, options);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => sanitizeDetails(item, options));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([name, item]) => [
          name,
          sanitizeDetails(item, options, name),
        ]),
    );
  }

  return String(value);
}

function rotatedPath(filePath, index) {
  return index === 0 ? filePath : `${filePath}.${index}`;
}

function rotateLogs(filePath, keepFiles) {
  rmSync(rotatedPath(filePath, keepFiles - 1), { force: true });

  for (let index = keepFiles - 2; index >= 0; index--) {
    const source = rotatedPath(filePath, index);

    if (existsSync(source)) {
      renameSync(source, rotatedPath(filePath, index + 1));
    }
  }
}

function createDiagnosticLogger({
  directory,
  homeDirectory,
  keepFiles = DEFAULT_KEEP_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
  now = () => new Date(),
  userDataDirectory,
}) {
  if (!Number.isInteger(keepFiles) || keepFiles < 1) {
    throw new TypeError('Log retention must be a positive integer.');
  }

  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, 'stream32.log');
  const sanitizingOptions = { homeDirectory, userDataDirectory };

  function log(level, event, details = {}) {
    const entry = {
      time: now().toISOString(),
      level: sanitizeLogText(level, sanitizingOptions).slice(0, 16),
      event: sanitizeLogText(event, sanitizingOptions).slice(0, 80),
      details: sanitizeDetails(details, sanitizingOptions),
    };
    let line = `${JSON.stringify(entry)}\n`;

    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      entry.details = { message: '[entry exceeded log limit]' };
      line = `${JSON.stringify(entry)}\n`;
    }

    try {
      if (
        existsSync(filePath) &&
        statSync(filePath).size + Buffer.byteLength(line, 'utf8') > maxBytes
      ) {
        rotateLogs(filePath, keepFiles);
      }

      appendFileSync(filePath, line, 'utf8');
      return true;
    } catch {
      // Diagnostics must never take down the application.
      return false;
    }
  }

  return {
    directory,
    error(event, error, details = {}) {
      log('error', event, {
        ...details,
        errorName: error?.name || 'Error',
        message: error instanceof Error ? error.message : String(error),
      });
    },
    filePath,
    info(event, details) {
      log('info', event, details);
    },
    log,
  };
}

module.exports = {
  DEFAULT_KEEP_FILES,
  DEFAULT_MAX_BYTES,
  createDiagnosticLogger,
  rotateLogs,
  sanitizeDetails,
  sanitizeLogText,
};
