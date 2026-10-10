/** Scrubs diagnostics without retaining submitted question answers in another cache. */
export function redactCodexDiagnostic(value, secrets = []) {
  let text = String(value ?? '');
  if (/"answers"\s*:|request_user_input.*(?:result|response)/i.test(text)) {
    return '[redacted structured interaction output]';
  }
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      text = text.replaceAll(secret, '[redacted credential]');
    }
  }
  return text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted credential]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}
