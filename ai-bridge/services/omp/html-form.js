/**
 * OMP's `ask` form as questions for the plugin's dialog.
 *
 * From omp 19 on, the `ask` tool sends its whole HTML form in one `form`
 * request and takes the submitted values back by control name. The plugin's
 * dialog asks questions, so every named field becomes one: a radio group or a
 * `<select>` a single choice, a checkbox group a multi-select, an input or a
 * textarea a typed answer. The form text around a field goes along as the
 * question's detail.
 *
 * The HTML is read with OMP's own rules: its `packages/utils/src/dom/parser.ts`,
 * and `parse.ts` and `data.ts` under `packages/coding-agent/src/tools/html-form`.
 * OMP checks an answer against its own reading of the form and fails the whole
 * `ask` call on a mismatch, so both sides must find the same fields, option
 * values and value shapes. Keep this file in step with those three.
 */

// ---- HTML, as OMP's parser reads it ----

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
// Opening the key closes an open element of one of the listed names.
const CLOSED_BY_OPENING = new Map([
  ['li', ['li']],
  ['dt', ['dt', 'dd']],
  ['dd', ['dt', 'dd']],
  ['tr', ['tr']],
  ['th', ['th', 'td']],
  ['td', ['th', 'td']],
  ['option', ['option']],
  ['thead', ['thead', 'tbody', 'tfoot']],
  ['tbody', ['thead', 'tbody', 'tfoot']],
  ['tfoot', ['thead', 'tbody', 'tfoot']],
]);
// Opening one of these closes an open `<p>`.
const CLOSES_PARAGRAPH = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
// Elements whose content is text up to their end tag. Only the second kind has character references.
const RAW_TEXT_END = new Map([['script', /<\/script\s*>/gi], ['style', /<\/style\s*>/gi]]);
const DECODED_TEXT_END = new Map([['textarea', /<\/textarea\s*>/gi], ['title', /<\/title\s*>/gi]]);

const TAG_NAME = /[^\s/>]+/y;
const ATTRIBUTE_NAME = /[^\s=/>]+/y;
const UNQUOTED_VALUE = /[^\s>]+/y;

// The named character references OMP decodes, as `name:code point (hex)`. Any other name stays as written.
const NAMED_ENTITIES = new Map((
  'AElig:c6 Aacute:c1 Acirc:c2 Agrave:c0 Aring:c5 Atilde:c3 Auml:c4 Ccedil:c7 ETH:d0 Eacute:c9 Ecirc:ca '
  + 'Egrave:c8 Euml:cb Iacute:cd Icirc:ce Igrave:cc Iuml:cf Ntilde:d1 Oacute:d3 Ocirc:d4 Ograve:d2 '
  + 'Oslash:d8 Otilde:d5 Ouml:d6 THORN:de Uacute:da Ucirc:db Ugrave:d9 Uuml:dc Yacute:dd aacute:e1 '
  + 'acirc:e2 aelig:e6 agrave:e0 aring:e5 atilde:e3 auml:e4 amp:26 apos:27 bull:2022 brvbar:a6 ccedil:e7 '
  + 'cedil:b8 cent:a2 copy:a9 deg:b0 curren:a4 divide:f7 emsp:2003 ensp:2002 euro:20ac eacute:e9 ecirc:ea '
  + 'egrave:e8 eth:f0 euml:eb frac12:bd frac14:bc frac34:be gt:3e iacute:ed icirc:ee iexcl:a1 igrave:ec '
  + 'iquest:bf iuml:ef hellip:2026 laquo:ab ldquo:201c lsquo:2018 lt:3c mdash:2014 macr:af micro:b5 '
  + 'middot:b7 nbsp:a0 ndash:2013 ntilde:f1 oacute:f3 ocirc:f4 ograve:f2 ordf:aa ordm:ba oslash:f8 '
  + 'otilde:f5 ouml:f6 para:b6 pound:a3 plusmn:b1 quot:22 raquo:bb rdquo:201d reg:ae rsquo:2019 sect:a7 '
  + 'shy:ad szlig:df thorn:fe sup1:b9 sup2:b2 sup3:b3 thinsp:2009 times:d7 trade:2122 uacute:fa ucirc:fb '
  + 'ugrave:f9 uml:a8 uuml:fc yacute:fd yuml:ff yen:a5'
).split(' ').map((entry) => {
  const [name, hex] = entry.split(':');
  return [name, String.fromCodePoint(Number.parseInt(hex, 16))];
}));
const CHARACTER_REFERENCE = /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi;

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(CHARACTER_REFERENCE, (whole, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body) ?? NAMED_ENTITIES.get(body.toLowerCase()) ?? whole;
    const hex = body[1].toLowerCase() === 'x';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(code);
  });
}

/** Index of the `>` that ends a tag, searching from `from`; a quoted `>` does not count. */
function tagEnd(html, from) {
  let quote = '';
  for (let at = from; at < html.length; at += 1) {
    const char = html[at];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return at;
    }
  }
  return html.length - 1;
}

/** @param {string} source a start tag without its angle brackets */
function parseStartTag(source) {
  let at = 0;
  const skipSpace = () => {
    while (/\s/.test(source[at] ?? '')) at += 1;
  };
  skipSpace();
  TAG_NAME.lastIndex = at;
  const name = TAG_NAME.exec(source);
  if (!name) return null;
  at += name[0].length;
  const attributes = new Map();
  let selfClosing = false;
  while (at < source.length) {
    skipSpace();
    if (source[at] === '/') {
      selfClosing = true;
      break;
    }
    ATTRIBUTE_NAME.lastIndex = at;
    const attribute = ATTRIBUTE_NAME.exec(source);
    if (!attribute) break;
    at += attribute[0].length;
    skipSpace();
    let value = '';
    if (source[at] === '=') {
      at += 1;
      skipSpace();
      const quote = source[at];
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, at + 1);
        value = source.slice(at + 1, end < 0 ? source.length : end);
        at = end < 0 ? source.length : end + 1;
      } else {
        UNQUOTED_VALUE.lastIndex = at;
        value = UNQUOTED_VALUE.exec(source)?.[0] ?? '';
        at += value.length;
      }
    }
    // The first of two attributes with one name wins.
    const key = attribute[0].toLowerCase();
    if (!attributes.has(key)) attributes.set(key, decodeEntities(value));
  }
  return { name: name[0].toLowerCase(), attributes, selfClosing };
}

function readUntil(html, from, end) {
  end.lastIndex = from;
  const match = end.exec(html);
  return match ? [html.slice(from, match.index), end.lastIndex] : [html.slice(from), html.length];
}

/**
 * @typedef {{ name: string, attributes: Map<string, string>, parent: HtmlElement|null,
 *   children: (HtmlElement|string)[], svg: boolean }} HtmlElement  a string child is text
 * @returns {HtmlElement} the document
 */
function parseHtml(html) {
  const root = { name: '#document', attributes: new Map(), parent: null, children: [], svg: false };
  const open = [];
  let parent = root;
  let at = 0;
  while (at < html.length) {
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[at] !== '<') {
      const end = html.indexOf('<', at);
      const stop = end < 0 ? html.length : end;
      parent.children.push(decodeEntities(html.slice(at, stop)));
      at = stop;
      continue;
    }
    if (html.startsWith('<![CDATA[', at)) {
      const end = html.indexOf(']]>', at + 9);
      parent.children.push(html.slice(at + 9, end < 0 ? html.length : end));
      at = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[at + 1] === '/') {
      const end = tagEnd(html, at + 2);
      const name = html.slice(at + 2, end).trim().split(/\s/, 1)[0].toLowerCase();
      // An end tag closes the nearest open element of its name and everything inside it.
      const index = open.findLastIndex((element) => element.name === name);
      if (index >= 0) open.length = index;
      parent = open.at(-1) ?? root;
      at = end + 1;
      continue;
    }
    if (html[at + 1] === '!' || html[at + 1] === '?') {
      const end = html.indexOf('>', at + 2);
      at = end < 0 ? html.length : end + 1;
      continue;
    }
    const end = tagEnd(html, at + 1);
    const tag = parseStartTag(html.slice(at + 1, end));
    if (!tag) {
      parent.children.push('<');
      at += 1;
      continue;
    }
    const top = open.at(-1);
    if (top && ((top.name === 'p' && CLOSES_PARAGRAPH.has(tag.name)) || CLOSED_BY_OPENING.get(tag.name)?.includes(top.name))) {
      open.pop();
    }
    parent = open.at(-1) ?? root;
    const element = {
      name: tag.name,
      attributes: tag.attributes,
      parent,
      children: [],
      svg: tag.name === 'svg' || parent.svg,
    };
    parent.children.push(element);
    at = end + 1;
    if (RAW_TEXT_END.has(tag.name) && !tag.selfClosing) {
      const [text, next] = readUntil(html, at, RAW_TEXT_END.get(tag.name));
      element.children.push(text);
      at = next;
      continue;
    }
    if (!element.svg && DECODED_TEXT_END.has(tag.name) && !tag.selfClosing) {
      const [text, next] = readUntil(html, at, DECODED_TEXT_END.get(tag.name));
      if (text) element.children.push(decodeEntities(text));
      at = next;
      continue;
    }
    if (!VOID_ELEMENTS.has(tag.name) && !(element.svg && tag.selfClosing)) {
      open.push(element);
      parent = element;
    }
  }
  return root;
}

const isElement = (node) => typeof node !== 'string';
const isControl = (element) => element.name === 'input' || element.name === 'select' || element.name === 'textarea';

/** The elements below `element` that `matches` accepts, in document order. */
function descendants(element, matches, found = []) {
  for (const child of element.children) {
    if (!isElement(child)) continue;
    if (matches(child)) found.push(child);
    descendants(child, matches, found);
  }
  return found;
}

const named = (name) => (element) => element.name === name;
const controlsIn = (element) => descendants(element, isControl);

/** `element` or its nearest ancestor called `name`. */
function closest(element, name) {
  for (let at = element; at; at = at.parent) {
    if (at.name === name) return at;
  }
  return null;
}

function contains(ancestor, element) {
  for (let at = element; at; at = at.parent) {
    if (at === ancestor) return true;
  }
  return false;
}

function textContent(node) {
  return isElement(node) ? node.children.map(textContent).join('') : node;
}

// ---- The form: sections of text and fields, as OMP's `parseHtmlForm` builds them ----

const SKIPPED = new Set(['button', 'head', 'iframe', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figure', 'figcaption', 'footer',
  'header', 'li', 'main', 'nav', 'p', 'section',
]);
const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary']);
const STYLE_OF = new Map([
  ['b', 'strong'], ['code', 'code'], ['em', 'em'], ['i', 'em'], ['kbd', 'code'], ['samp', 'code'],
  ['strong', 'strong'], ['tt', 'code'],
]);
const IGNORED_INPUTS = new Set(['button', 'file', 'image', 'reset', 'submit']);

/** Append `text` to `spans`, merging into the previous span when the style matches. */
function appendSpan(spans, text, style) {
  if (!text) return;
  const last = spans.at(-1);
  if (last && last.style === style) last.text += text;
  else spans.push(style ? { text, style } : { text });
}

/** Collapse whitespace the way HTML layout does; `"\n"` is a hard line break (`<br>`). */
function normalizeSpans(spans) {
  const out = [];
  for (const span of spans) {
    appendSpan(out, span.text.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n'), span.style);
  }
  if (out.length > 0) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
  }
  return out.filter((span) => span.text !== '');
}

const spansText = (spans) => spans.map((span) => span.text).join('');
const flattenLine = (text) => text.replace(/\s+/g, ' ').trim();

function numberAttribute(element, name) {
  const raw = element.attributes.get(name);
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * @typedef {{ text: string, style?: 'code'|'strong'|'em' }} FormSpan
 * @typedef {{ value: string, label: FormSpan[], checked: boolean, disabled: boolean }} ChoiceOption
 * @typedef {{ kind: 'choice', name: string, multi: boolean, select: boolean, other: boolean, label: FormSpan[],
 *   options: ChoiceOption[], required: boolean }} ChoiceField
 *   a radio group, a checkbox group (`multi`) or a `<select>`; `other`: free text is an answer too
 * @typedef {{ kind: 'text', name: string, type: string, label: FormSpan[], value: string, required: boolean,
 *   min?: number, max?: number, pattern?: string, minLength?: number, maxLength?: number }} TextField
 *   an `<input>` of that `type`, or a `textarea`
 * @typedef {ChoiceField|TextField} FormField
 *
 * @param {string} html
 * @returns {{ sections: { title: FormSpan[], blocks: object[] }[], fields: FormField[] }}
 *   a section is a top-level `<fieldset>`, titled by its legend, or the content between two
 */
function parseHtmlForm(html) {
  const document = parseHtml(html);
  // Content outside the first `<form>` is ignored when there is one.
  const root = descendants(document, named('form'))[0] ?? document;
  const fields = [];
  // Radio and checkbox groups by type and name, with the section and the block of their first option.
  const groups = new Map();
  // `<label for>` elements by the id of the control they name.
  const labelFor = new Map();
  let section = { title: [], blocks: [] };
  const sections = [section];
  let inline = [];
  let fieldsetDepth = 0;

  /** Emit the inline content collected so far as a text block. */
  function flush(heading) {
    const spans = normalizeSpans(inline);
    inline = [];
    if (spans.length > 0) section.blocks.push({ kind: 'text', spans, heading });
  }

  function walkChildren(element, style) {
    for (const child of element.children) walk(child, style);
  }

  function walk(node, style) {
    if (!isElement(node)) {
      appendSpan(inline, node, style);
      return;
    }
    const tag = node.name;
    if (SKIPPED.has(tag)) return;
    switch (tag) {
      case 'br':
        appendSpan(inline, '\n', undefined);
        return;
      case 'hr':
        flush(false);
        return;
      case 'input':
      case 'select':
      case 'textarea':
        addControl(node, undefined);
        return;
      case 'label':
        addLabel(node, style);
        return;
      case 'fieldset':
        addFieldset(node);
        return;
      case 'legend':
        flush(false);
        walkChildren(node, style);
        flush(true);
        return;
      case 'ul':
      case 'ol':
        addList(node, tag === 'ol');
        return;
      case 'pre':
        flush(false);
        section.blocks.push({ kind: 'pre', text: textContent(node).replace(/^\n/, '').trimEnd() });
        return;
      case 'table':
        addTable(node);
        return;
      case 'img': {
        const src = node.attributes.get('src')?.trim();
        if (!src) return;
        flush(false);
        section.blocks.push({ kind: 'image', src, alt: (node.attributes.get('alt') ?? '').trim() });
        return;
      }
      case 'svg': {
        flush(false);
        const title = node.children.find((child) => isElement(child) && child.name === 'title');
        const alt = node.attributes.get('aria-label')?.trim() || flattenLine(title ? textContent(title) : '');
        section.blocks.push({ kind: 'svg', alt });
        return;
      }
      default:
    }
    if (HEADING.has(tag) || BLOCK.has(tag)) {
      flush(false);
      walkChildren(node, style);
      flush(HEADING.has(tag));
      return;
    }
    walkChildren(node, STYLE_OF.get(tag) ?? style);
  }

  /** Inline spans of `element` without its controls: their label is the text around them. */
  function spansOf(element) {
    const spans = [];
    const visit = (node, style) => {
      if (!isElement(node)) {
        appendSpan(spans, node, style);
        return;
      }
      const tag = node.name;
      if (SKIPPED.has(tag) || isControl(node) || tag === 'svg') return;
      if (tag === 'br') {
        appendSpan(spans, '\n', undefined);
        return;
      }
      // A label stays text: a picture inside one reads as its alt text.
      if (tag === 'img') {
        appendSpan(spans, node.attributes.get('alt') ?? '', style);
        return;
      }
      if (BLOCK.has(tag) || HEADING.has(tag)) appendSpan(spans, ' ', undefined);
      for (const child of node.children) visit(child, STYLE_OF.get(tag) ?? style);
    };
    for (const child of element.children) visit(child, undefined);
    return normalizeSpans(spans);
  }

  function addLabel(label, style) {
    const target = label.attributes.get('for');
    if (target && labelFor.get(target) === label) return;
    const controls = controlsIn(label);
    if (controls.length === 0) {
      walkChildren(label, style);
      return;
    }
    flush(false);
    const spans = spansOf(label);
    for (const control of controls) addControl(control, spans);
  }

  function startSection(title) {
    if (section.blocks.length === 0 && section.title.length === 0) {
      section.title = title;
      return;
    }
    section = { title, blocks: [] };
    sections.push(section);
  }

  function addFieldset(fieldset) {
    flush(false);
    const legend = fieldset.children.find((child) => isElement(child) && child.name === 'legend');
    if (fieldsetDepth > 0) {
      // A nested fieldset stays in the outer section; its legend becomes a heading.
      if (legend) walk(legend, undefined);
    } else {
      startSection(legend ? spansOf(legend) : []);
    }
    fieldsetDepth += 1;
    for (const child of fieldset.children) {
      if (child !== legend) walk(child, undefined);
    }
    flush(false);
    fieldsetDepth -= 1;
    if (fieldsetDepth === 0) startSection([]);
  }

  function addList(list, ordered) {
    flush(false);
    if (controlsIn(list).length > 0) {
      // A list of controls is layout, not content.
      walkChildren(list, undefined);
      flush(false);
      return;
    }
    const items = list.children
      .filter((child) => isElement(child) && child.name === 'li')
      .map((item) => spansOf(item))
      .filter((spans) => spans.length > 0);
    if (items.length > 0) section.blocks.push({ kind: 'list', items, ordered });
  }

  function addTable(table) {
    flush(false);
    const rows = descendants(table, named('tr')).filter((row) => closest(row, 'table') === table);
    const cellsOf = (row) => row.children.filter((cell) => isElement(cell) && (cell.name === 'td' || cell.name === 'th'));
    if (controlsIn(table).length === 0) {
      const cells = rows.map((row) => cellsOf(row).map((cell) => spansOf(cell)));
      let headerRows = 0;
      while (headerRows < rows.length
        && (closest(rows[headerRows], 'thead') !== null || cellsOf(rows[headerRows]).every(named('th')))) {
        headerRows += 1;
      }
      if (cells.some((row) => row.length > 0)) section.blocks.push({ kind: 'table', rows: cells, headerRows });
      return;
    }
    // A table of controls (a decision matrix): the text of each row becomes a line, and a
    // control without a label of its own borrows its column header.
    let header = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      if (cells.every(named('th')) && controlsIn(row).length === 0) {
        header = cells.map((cell) => spansOf(cell));
        continue;
      }
      const text = [];
      for (const cell of cells) {
        if (controlsIn(cell).length > 0) continue;
        const spans = spansOf(cell);
        if (spans.length === 0) continue;
        if (text.length > 0) appendSpan(text, ' · ', undefined);
        for (const span of spans) appendSpan(text, span.text, span.style);
      }
      if (text.length > 0) section.blocks.push({ kind: 'text', spans: text, heading: false });
      cells.forEach((cell, column) => {
        for (const control of controlsIn(cell)) {
          const own = closest(control, 'label');
          const spans = spansOf(own && contains(cell, own) ? own : cell);
          addControl(control, spans.length > 0 ? spans : header[column] ?? []);
        }
      });
    }
  }

  function addField(field) {
    const block = { kind: 'field', field };
    fields.push(field);
    section.blocks.push(block);
    return block;
  }

  /** @param {FormSpan[]|undefined} wrapping the text of the `<label>` (or table cell) the control sits in */
  function addControl(control, wrapping) {
    flush(false);
    let label = wrapping ?? [];
    if (label.length === 0) {
      // A control outside any label: `<label for>`, then `aria-label`, then `title`.
      const id = control.attributes.get('id');
      const detached = id ? labelFor.get(id) : undefined;
      const text = control.attributes.get('aria-label') ?? control.attributes.get('title');
      label = detached ? spansOf(detached) : text ? normalizeSpans([{ text }]) : [];
    }
    const name = control.attributes.get('name') ?? '';
    const required = control.attributes.has('required');
    // Last resort: the control name, `sentry_dsn` as `sentry dsn`.
    const nameLabel = name ? [{ text: name.replace(/[_-]+/g, ' ') }] : [];
    if (control.name === 'select') {
      const multi = control.attributes.has('multiple');
      const options = descendants(control, named('option')).map((option) => {
        const text = flattenLine(textContent(option));
        return {
          value: option.attributes.get('value') ?? text,
          label: [{ text }],
          checked: option.attributes.has('selected'),
          disabled: option.attributes.has('disabled'),
        };
      });
      // A single select always has a selection: its first enabled option unless one is marked.
      if (!multi && !options.some((option) => option.checked)) {
        const first = options.find((option) => !option.disabled);
        if (first) first.checked = true;
      }
      addField({ kind: 'choice', name, multi, select: true, other: false, label, options, required });
      return;
    }
    if (control.name === 'textarea') {
      addField({
        kind: 'text',
        name,
        type: 'textarea',
        label: label.length > 0 ? label : nameLabel,
        value: textContent(control).replace(/^\r?\n/, ''),
        required,
        minLength: numberAttribute(control, 'minlength'),
        maxLength: numberAttribute(control, 'maxlength'),
      });
      return;
    }
    const type = (control.attributes.get('type') ?? 'text').toLowerCase();
    // A hidden input keeps the form's own value; OMP adds it to the answer itself.
    if (IGNORED_INPUTS.has(type) || type === 'hidden') return;
    const value = control.attributes.get('value');
    if (type === 'radio' || type === 'checkbox') {
      const option = {
        value: value ?? 'on',
        label: label.length > 0 ? label : [{ text: value ?? name }],
        checked: control.attributes.has('checked'),
        disabled: control.attributes.has('disabled'),
      };
      const key = `${type}\0${name}`;
      const group = groups.get(key);
      if (group) {
        group.field.options.push(option);
        group.field.required ||= required;
        // Blocks between this option and the group's first one belong to the group.
        if (group.section === section && section.blocks.at(-1) !== group.block) {
          group.block.optionsEnd = section.blocks.length;
        }
        return;
      }
      const field = {
        kind: 'choice', name, multi: type === 'checkbox', select: false, other: false, label: [], options: [option], required,
      };
      groups.set(key, { field, section, block: addField(field) });
      return;
    }
    addField({
      kind: 'text',
      name,
      type,
      label: label.length > 0 ? label : nameLabel,
      value: value ?? '',
      required,
      min: numberAttribute(control, 'min'),
      max: numberAttribute(control, 'max'),
      pattern: control.attributes.get('pattern'),
      minLength: numberAttribute(control, 'minlength'),
      maxLength: numberAttribute(control, 'maxlength'),
    });
  }

  const controlIds = new Set(controlsIn(root).map((control) => control.attributes.get('id')).filter(Boolean));
  for (const label of descendants(root, named('label'))) {
    const target = label.attributes.get('for');
    if (target && controlIds.has(target) && !labelFor.has(target)) labelFor.set(target, label);
  }
  walkChildren(root, undefined);
  flush(false);
  for (const field of fields) {
    // The UI adds free text to a radio or checkbox group of two or more options that offers none itself.
    if (field.kind === 'choice' && !field.select && field.options.length >= 2) {
      field.other = !field.options.some((option) => /^\s*other\b/i.test(spansText(option.label)));
    }
  }
  return { sections: sections.filter((part) => part.blocks.length > 0 || part.title.length > 0), fields };
}

// ---- Values, as OMP's `data.ts` shapes and checks them ----

/** Whether a choice field reports an array (checkbox group, multi-select) rather than one value. */
const isArrayChoice = (field) => field.multi && field.options.length > 1;

/**
 * Why `value` is not an acceptable answer for `field`, or undefined when it is.
 *
 * @param {FormField} field
 * @param {string|number|string[]|undefined} value
 * @returns {string|undefined}
 */
export function fieldError(field, value) {
  if (field.kind === 'choice') {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return isArrayChoice(field) ? 'Select at least one' : 'Required';
  }
  const text = value === undefined ? '' : String(value);
  if (text.trim() === '') return field.required ? 'Required' : undefined;
  if (field.type === 'number' || field.type === 'range') {
    const number = Number(text);
    if (!Number.isFinite(number)) return 'Enter a number';
    if (field.min !== undefined && number < field.min) return `Must be at least ${field.min}`;
    if (field.max !== undefined && number > field.max) return `Must be at most ${field.max}`;
  }
  if (field.minLength !== undefined && text.length < field.minLength) return `Needs at least ${field.minLength} characters`;
  if (field.maxLength !== undefined && text.length > field.maxLength) return `At most ${field.maxLength} characters`;
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) return 'Enter an email address';
  if (field.type === 'url' && !URL.canParse(text)) return 'Enter a full URL';
  if (field.pattern) {
    let pattern;
    try {
      // Anchored, as HTML matches `pattern`. One that does not compile is ignored.
      pattern = new RegExp(`^(?:${field.pattern})$`, 'v');
    } catch {
      return undefined;
    }
    if (!pattern.test(text)) return `Must match ${field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern}`;
  }
  return undefined;
}

// ---- Questions for the dialog ----

/** Text as Markdown shows it literally: every ASCII punctuation mark becomes a character reference. */
const escapeMarkdown = (text) => text.replace(/[!-/:-@[-`{-~]/g, (char) => `&#${char.charCodeAt(0)};`);
/** A URL as a Markdown link destination: nothing in it may end the destination early. */
const markdownUrl = (url) => url
  .replace(/[\s<>\\`]/g, (char) => encodeURIComponent(char))
  .replaceAll('(', '%28')
  .replaceAll(')', '%29');

/** Spans as one Markdown paragraph. Code keeps its style; a `<br>` stays a line break. */
function inlineMarkdown(spans) {
  return spans.map(({ text, style }) => {
    if (style !== 'code' || /[`\n]/.test(text) || text.trim() === '') return escapeMarkdown(text);
    const [, before, code, after] = /^(\s*)(.*?)(\s*)$/.exec(text);
    return `${before}\`${code}\`${after}`;
  }).join('').replaceAll('\n', '  \n');
}

function tableMarkdown({ rows, headerRows }) {
  const width = Math.max(...rows.map((cells) => cells.length));
  // A cell is one line, and a `|` in its code would end it.
  const row = (cells) => `| ${Array.from({ length: width }, (_, column) => (
    inlineMarkdown(cells[column] ?? []).replace(/\s*\n/g, ' ').replaceAll('|', '\\|')
  )).join(' | ')} |`;
  // Markdown has no table without a header row.
  const [header, ...body] = headerRows > 0 ? rows : [[], ...rows];
  return [row(header), `|${' --- |'.repeat(width)}`, ...body.map(row)].join('\n');
}

/**
 * A block of form text for the question's detail, which the dialog renders as
 * Markdown; `text` is its plain text. Null for a block with nothing to show.
 */
function contextPart(block) {
  switch (block.kind) {
    case 'text': {
      const text = spansText(block.spans);
      return { text, markdown: block.heading ? `**${escapeMarkdown(flattenLine(text))}**` : inlineMarkdown(block.spans) };
    }
    case 'list':
      return {
        text: block.items.map(spansText).join('\n'),
        markdown: block.items
          .map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${inlineMarkdown(item)}`)
          .join('\n'),
      };
    case 'pre': {
      if (block.text.trim() === '') return null;
      const fence = '`'.repeat(Math.max(3, ...Array.from(block.text.matchAll(/`+/g), ([run]) => run.length + 1)));
      return { text: block.text, markdown: `${fence}\n${block.text}\n${fence}` };
    }
    case 'table':
      return { text: block.rows.map((cells) => cells.map(spansText).join(' | ')).join('\n'), markdown: tableMarkdown(block) };
    case 'image':
      // The webview loads pictures over https only; any other is named instead.
      return {
        text: '',
        markdown: /^https:\/\//i.test(block.src)
          ? `![${escapeMarkdown(block.alt)}](${markdownUrl(block.src)})`
          : escapeMarkdown(`[Picture: ${block.alt || block.src}]`),
      };
    case 'svg':
      return { text: '', markdown: escapeMarkdown(block.alt ? `[Picture: ${block.alt}]` : '[Picture]') };
    default:
      return null;
  }
}

/**
 * The question each field answers: its own label, else the text block right
 * before it (`<p>Which database?</p>` above a radio group), else its section
 * title, else the label of its only option (a single checkbox), else its name.
 */
function fieldQuestions(form) {
  const questions = new Map();
  for (const section of form.sections) {
    const title = spansText(section.title);
    let caption = '';
    for (const block of section.blocks) {
      if (block.kind !== 'field') {
        caption = block.kind === 'text' ? spansText(block.spans) : '';
        continue;
      }
      const { field } = block;
      const lone = field.kind === 'choice' && field.options.length === 1 ? spansText(field.options[0].label) : '';
      questions.set(field, flattenLine(spansText(field.label) || caption || title || lone || field.name));
      caption = '';
    }
  }
  return questions;
}

/**
 * The form text each of the `asked` fields is shown with: section titles and
 * text since the previous asked field, text between the field's own options
 * (unless another asked field sits among them) and, for the last field, the
 * text after it. Text that already is the field's question is left out.
 */
function fieldContexts(form, questions, asked) {
  const parts = new Map();
  let pending = [];
  let last;
  for (const section of form.sections) {
    const title = flattenLine(spansText(section.title));
    if (title) pending.push({ text: title, markdown: `**${escapeMarkdown(title)}**` });
    let owner;
    let ownerEnd = 0;
    for (const [index, block] of section.blocks.entries()) {
      if (block.kind === 'field') {
        if (!asked.has(block.field)) continue;
        const question = questions.get(block.field);
        owner = pending.filter((part) => flattenLine(part.text) !== question);
        parts.set(block.field, owner);
        pending = [];
        last = owner;
        const end = block.optionsEnd ?? 0;
        const interrupted = section.blocks
          .some((later, at) => at > index && at < end && later.kind === 'field' && asked.has(later.field));
        ownerEnd = interrupted ? 0 : end;
        continue;
      }
      const part = contextPart(block);
      if (!part) continue;
      if (owner && index < ownerEnd) owner.push(part);
      else pending.push(part);
    }
  }
  last?.push(...pending);
  return new Map(Array.from(parts, ([field, own]) => [field, own.map((part) => part.markdown).join('\n\n')]));
}

/**
 * The form's named fields, in form order, each ready to be asked.
 *
 * @param {string} html the `html` of a `form` request
 * @returns {{ field: FormField, question: string, context: string,
 *   choices: { label: string, index: number }[] }[]}
 *   `context` is Markdown; `choices` are the options that can be picked, by the label the dialog shows
 */
export function formEntries(html) {
  const form = parseHtmlForm(html);
  const questions = fieldQuestions(form);
  const entries = form.fields.flatMap((field) => {
    if (!field.name) return [];
    const entry = { field, question: questions.get(field) || field.name, context: '', choices: [] };
    if (field.kind === 'text') return [entry];
    // The dialog tells options apart by their label.
    const taken = new Set();
    field.options.forEach((option, index) => {
      if (option.disabled) return;
      const text = flattenLine(spansText(option.label)) || option.value || `Option ${index + 1}`;
      let label = text;
      for (let copy = 2; taken.has(label); copy += 1) label = `${text} (${copy})`;
      taken.add(label);
      entry.choices.push({ label, index });
    });
    // Nothing can be picked: OMP keeps the field as the form has it.
    return entry.choices.length > 0 ? [entry] : [];
  });
  // The text around a field that is not asked stays with the ones that are.
  const contexts = fieldContexts(form, questions, new Set(entries.map((entry) => entry.field)));
  for (const entry of entries) entry.context = contexts.get(entry.field) ?? '';
  return entries;
}

/**
 * One entry as a question of the plugin's dialog (everything but its `id`).
 *
 * @param {{ error: string, text: string }} [rejected] the answer given before and why it does not fit
 */
export function formQuestion({ field, question, context, choices }, rejected) {
  const detail = [rejected ? `**${escapeMarkdown(rejected.error)}**` : '', context].filter(Boolean).join('\n\n');
  const shared = { question, header: '', ...(detail ? { detail } : {}) };
  if (field.kind === 'text') {
    const text = rejected ? rejected.text : field.value;
    return {
      ...shared,
      options: [],
      multiSelect: false,
      required: field.required,
      ...(text ? { defaultText: text } : {}),
      ...(field.type === 'password' ? { isSecret: true } : {}),
    };
  }
  return {
    ...shared,
    options: choices.map(({ label, index }) => ({
      label,
      description: '',
      ...(field.options[index].checked ? { selected: true } : {}),
    })),
    multiSelect: field.multi,
    // A single `<select>` always holds one of its options.
    required: field.required || (field.select && !field.multi),
    ...(field.other ? {} : { choiceOnly: true }),
  };
}

/**
 * The value a field submits for the dialog's answer: one option value for a
 * radio group, a single `<select>` or a lone checkbox (undefined when nothing
 * is chosen), an array for a checkbox group or a multi-select, the text of a
 * text field, as a number for a `number` or `range` input.
 *
 * @param {string[]} answer the chosen labels and the typed text, without blanks
 * @returns {string|number|string[]|undefined}
 */
export function formValue({ field, choices }, answer) {
  if (field.kind === 'text') {
    const text = answer[0] ?? '';
    const number = (field.type === 'number' || field.type === 'range') && text.trim() !== '' ? Number(text) : NaN;
    return Number.isFinite(number) ? number : text;
  }
  const checked = new Set();
  let typed;
  for (const label of field.multi ? answer : answer.slice(0, 1)) {
    const choice = choices.find((candidate) => candidate.label === label);
    if (choice) checked.add(choice.index);
    else if (field.other) typed = label.trim();
  }
  // To OMP, text that spells an option's value is that option.
  const spelled = field.options.findIndex((option) => !option.disabled && option.value === typed);
  if (spelled >= 0) checked.add(spelled);
  if (field.options.some((option) => option.value === typed)) typed = undefined;
  // OMP takes each value once, also when two options share it.
  const values = [...new Set(field.options.flatMap((option, index) => (checked.has(index) ? [option.value] : [])))];
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}
