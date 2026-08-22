import { normalizeUpdatePlanInput } from './codex-tool-normalization.js';

const UPDATE_PLAN_TOKEN = 'tools.update_plan';
const INVALID = Symbol('invalid-js-literal');

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char ?? '');
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char ?? '');
}

function skipString(source, start) {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    const current = source[cursor++];
    if (current === '\\' && cursor < source.length) {
      cursor += 1;
    } else if (current === quote) {
      break;
    }
  }
  return cursor;
}

function skipTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const lineEnd = source.indexOf('\n', cursor + 2);
      cursor = lineEnd >= 0 ? lineEnd + 1 : source.length;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const blockEnd = source.indexOf('*/', cursor + 2);
      cursor = blockEnd >= 0 ? blockEnd + 2 : source.length;
      continue;
    }
    break;
  }
  return cursor;
}

function findToken(source, token, start) {
  let cursor = Math.max(0, start);
  while (cursor < source.length) {
    const current = source[cursor];
    if (current === '"' || current === "'" || current === '`') {
      cursor = skipString(source, cursor);
      continue;
    }
    if (source.startsWith('//', cursor)) {
      cursor = skipTrivia(source, cursor);
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      cursor = skipTrivia(source, cursor);
      continue;
    }
    if (source.startsWith(token, cursor)) {
      const before = cursor > 0 ? source[cursor - 1] : '';
      const after = source[cursor + token.length] ?? '';
      if (!isIdentifierPart(before) && before !== '.' && !isIdentifierPart(after)) {
        return cursor;
      }
    }
    cursor += 1;
  }
  return -1;
}

function parseJavaScriptLiteral(source, start) {
  let cursor = start;

  function parseStringLiteral() {
    const quote = source[cursor++];
    let value = '';
    while (cursor < source.length) {
      const current = source[cursor++];
      if (current === quote) return value;
      if (quote === '`' && current === '$' && source[cursor] === '{') return INVALID;
      if (current !== '\\' || cursor >= source.length) {
        value += current;
        continue;
      }

      const escaped = source[cursor++];
      const simpleEscapes = {
        b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0',
      };
      if (Object.hasOwn(simpleEscapes, escaped)) {
        value += simpleEscapes[escaped];
      } else if (escaped === 'x' || escaped === 'u') {
        const length = escaped === 'x' ? 2 : 4;
        const hex = source.slice(cursor, cursor + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) return INVALID;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        cursor += length;
      } else if (escaped === '\r') {
        if (source[cursor] === '\n') cursor += 1;
      } else if (escaped !== '\n') {
        value += escaped;
      }
    }
    return INVALID;
  }

  function parseIdentifier() {
    if (!isIdentifierStart(source[cursor])) return INVALID;
    const startIndex = cursor++;
    while (isIdentifierPart(source[cursor])) cursor += 1;
    return source.slice(startIndex, cursor);
  }

  function parseArray() {
    const values = [];
    cursor += 1;
    while (cursor < source.length) {
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === ']') {
        cursor += 1;
        return values;
      }
      const value = parseValue();
      if (value === INVALID) return INVALID;
      values.push(value);
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === ',') {
        cursor += 1;
        continue;
      }
      if (source[cursor] !== ']') return INVALID;
    }
    return INVALID;
  }

  function parseObject() {
    const value = Object.create(null);
    cursor += 1;
    while (cursor < source.length) {
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === '}') {
        cursor += 1;
        return value;
      }

      const key = source[cursor] === '"' || source[cursor] === "'" || source[cursor] === '`'
        ? parseStringLiteral()
        : parseIdentifier();
      if (key === INVALID || typeof key !== 'string') return INVALID;
      cursor = skipTrivia(source, cursor);
      if (source[cursor] !== ':') return INVALID;
      cursor = skipTrivia(source, cursor + 1);
      const propertyValue = parseValue();
      if (propertyValue === INVALID) return INVALID;
      value[key] = propertyValue;
      cursor = skipTrivia(source, cursor);
      if (source[cursor] === ',') {
        cursor += 1;
        continue;
      }
      if (source[cursor] !== '}') return INVALID;
    }
    return INVALID;
  }

  function parseValue() {
    cursor = skipTrivia(source, cursor);
    const current = source[cursor];
    if (current === '"' || current === "'" || current === '`') return parseStringLiteral();
    if (current === '{') return parseObject();
    if (current === '[') return parseArray();

    const numberMatch = source.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      cursor += numberMatch[0].length;
      return Number(numberMatch[0]);
    }

    const identifier = parseIdentifier();
    if (identifier === 'true') return true;
    if (identifier === 'false') return false;
    if (identifier === 'null') return null;
    if (identifier === 'undefined') return undefined;
    return INVALID;
  }

  const value = parseValue();
  return value === INVALID ? null : { value, nextIndex: cursor };
}

function extractSource(payload) {
  if (typeof payload?.input === 'string') return payload.input;
  if (payload?.input && typeof payload.input === 'object' && typeof payload.input.code === 'string') {
    return payload.input.code;
  }
  return '';
}

export function extractUpdatePlanFromResponseItemPayload(payload) {
  if (!payload || payload.type !== 'custom_tool_call') return null;
  if (String(payload.name || '').toLowerCase() !== 'exec') return null;

  const source = extractSource(payload);
  if (!source) return null;

  let searchStart = 0;
  let latestPlan = null;
  while (searchStart < source.length) {
    const callStart = findToken(source, UPDATE_PLAN_TOKEN, searchStart);
    if (callStart < 0) break;
    let cursor = skipTrivia(source, callStart + UPDATE_PLAN_TOKEN.length);
    if (source[cursor] === '(') {
      latestPlan = null;
      cursor = skipTrivia(source, cursor + 1);
      const parsed = parseJavaScriptLiteral(source, cursor);
      if (parsed?.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
          && Array.isArray(parsed.value.plan)) {
        latestPlan = normalizeUpdatePlanInput(parsed.value);
      }
    }
    searchStart = callStart + UPDATE_PLAN_TOKEN.length;
  }
  return latestPlan;
}
