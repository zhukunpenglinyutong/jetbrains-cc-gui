import { AsyncLocalStorage } from 'node:async_hooks';

// Metadata correlation only. This is not an approval capability or a provider/session identifier.
const scopes = new AsyncLocalStorage();
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VALID_SCOPE = new RegExp(`^${UUID}/${UUID}$`);

export function normalizeExecutionScope(value) {
  return typeof value === 'string' && VALID_SCOPE.test(value) ? value : '';
}

export function withExecutionScope(value, operation) {
  return scopes.run(normalizeExecutionScope(value), operation);
}

export function currentExecutionScope() {
  return scopes.getStore() || '';
}
