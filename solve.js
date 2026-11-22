// solve.js — a fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Written from scratch in this session from the competition brief, competition.yaml,
// RULES.txt and makefun-site's README.md. It implements makefun-site's own dialect
// (front matter, Markdown subset, template dialect, slug rule, report) byte for byte,
// as a single-pass, allocation-lean pipeline: templates are parsed once per case,
// Markdown is rendered in one scan per source, and strings are built in arrays and
// joined once.
//
// run(input) returns the output tree { path: text } for one case's input:
// { site: { title, base_url, per_page, recent }, templates: { name: source },
//   files: [{ path, content }] }.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESC[c]);
}

const MARK_RE = /\p{M}/gu;

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_BAD_RE = /["[\]]/;

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || TAG_BAD_RE.test(t)) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true }
        : raw === 'false' ? { value: false }
        : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64
        ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Parses front matter over a source's lines; returns { data, bodyStart } or { error }.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue; // '#'
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const a0 = line.charCodeAt(0);
  const b0 = line.charCodeAt(n - 1);
  if (a0 !== 32 && a0 !== 9 && b0 !== 32 && b0 !== 9) return line;
  let a = 0;
  let b = n;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

function isFenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
      || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: { depth, text } or null. Text is never empty.
function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n === 6 && line.charCodeAt(6) === 35) return null;
  if (n >= 6 && line.charCodeAt(n) === 35) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let b = line.length;
  while (b > n && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  let a = n;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  if (a >= b) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  if (line !== '---' && line !== '***' && !line.startsWith('---') && !line.startsWith('***')) return false;
  const head = line.startsWith('---') ? '---' : '***';
  if (!line.startsWith(head)) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return line.slice(0, 3) === head;
}

function endsParagraph(line) {
  // A blank line, a fence, a heading or a thematic break. All but blank start
  // at column 0, so the first character decides which test can even match.
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return isFenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const SPECIAL_TABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 91, 38, 60, 62, 34, 39]) SPECIAL_TABLE[c] = 1; // \ ` * [ & < > " '

// Renders inline Markdown of `s` into the `out` array; `link(target)` resolves a link href.
function inlineInto(s, link, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    // A run of plain characters, pushed as one slice. Non-ASCII code units
    // read undefined from the table, which is falsy, so they stay plain.
    let j = i;
    while (j < n && !SPECIAL_TABLE[s.charCodeAt(j)]) j++;
    if (j > i) { out.push(s.slice(i, j)); i = j; }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      const e = s[i + 1];
      out.push(e === '>' ? '&gt;' : e);
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>');
          inlineInto(s.slice(i + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out.push('<em>');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    out.push(ESC[c] ?? c);
    i++;
  }
}

// Renders the body lines[start..end) of a source. Returns { html, toc, excerpt, words }.
function renderMarkdown(lines, start, end, link, slugCache) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  // The body's words (runs of non-whitespace), counted over every body line.
  let words = 0;
  for (let l = start; l < end; l++) {
    const line = lines[l];
    let inWord = false;
    for (let p = 0; p < line.length; p++) {
      const c = line.charCodeAt(p);
      if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13
        || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A)
        || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F
        || c === 0x3000 || c === 0xFEFF) inWord = false;
      else if (!inWord) { words++; inWord = true; }
    }
  }
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = isFenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < end && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++; // the closing fence line (or past the end)
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      parts.push('<pre><code', cls, '>');
      if (body.length > 0) parts.push(escapeHtml(body.join('\n')), '\n');
      parts.push('</code></pre>', '\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      parts.push(`<h${heading.depth} id="${id}">`);
      const mark = parts.length;
      inlineInto(heading.text, link, parts);
      const headingHtml = parts.slice(mark).join('');
      parts.push(`</h${heading.depth}>`, '\n');
      if (heading.depth === 2 || heading.depth === 3) {
        toc.push({ level: heading.depth, id, html: headingHtml });
      }
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>', '\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < end && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') body.push(t);
      }
      if (body.length === 0) {
        parts.push('<blockquote>\n</blockquote>', '\n');
      } else {
        parts.push('<blockquote>\n<p>');
        inlineInto(body.length === 1 ? body[0] : body.join('\n'), link, parts);
        parts.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    const bullet = line.startsWith('- ') || line.startsWith('* ');
    let ordered = null;
    if (!bullet) {
      const m = /^(\d{1,9})\. (.*)$/.exec(line);
      if (m !== null) ordered = m;
    }
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < end) {
        const l = lines[i];
        let rest = null;
        if (isOrdered) {
          const m = /^(\d{1,9})\. (.*)$/.exec(l);
          if (m !== null) rest = m[2];
        } else if (l.startsWith('- ') || l.startsWith('* ')) {
          rest = l.slice(2);
        }
        if (rest !== null) {
          items.push([trimLine(rest)]);
          i++;
        } else if (/^ {2,}\S/.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      parts.push(open, '\n');
      for (const item of items) {
        parts.push('<li>');
        inlineInto(item.length === 1 ? item[0] : item.join('\n'), link, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>`, '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < end && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    parts.push('<p>');
    const mark = parts.length;
    inlineInto(body.length === 1 ? body[0] : body.join('\n'), link, parts);
    if (excerpt === null) excerpt = parts.slice(mark).join('');
    parts.push('</p>', '\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- slugs

function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do { out = `${slug}-${n++}`; } while (taken.has(out));
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include.
function parseTemplate(name, src) {
  const root = { k: -1, body: [] };
  const stack = [root];
  let body = root.body;
  // Tokenize: text, {{ }}, {{{ }}}, {% %}; a standalone {% %} tag takes its line.
  let text = '';
  let i = 0;
  const pushText = () => {
    if (text !== '') { body.push({ k: 0, text }); text = ''; }
  };
  const addNode = (node) => { body.push(node); };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      pushText();
      addNode({ k: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open))
      && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
      addNode(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
      addNode(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.k !== 3 || top.els !== null) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.k !== (tag === 'endfor' ? 4 : 3)) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === -1 ? parent.body : parent.k === 4 ? parent.body : parent.els ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      addNode({ k: 5, name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText();
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  }
  return root.body;
}

function lookup(frames, path) {
  // Frames and the objects they hold never carry an undefined-valued own
  // property, so !== undefined is the same test as hasOwn here, and cheaper.
  let s = null;
  for (let f = frames.length - 1; f >= 0; f--) {
    if (frames[f][path[0]] !== undefined) { s = frames[f]; break; }
  }
  if (s === null) return undefined;
  let v = s[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || v[path[k]] === undefined) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, frames, out, templates, depth) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.k) {
      case 0:
        out.push(node.text);
        break;
      case 1: {
        // {{ path }}: escaped. Strings escape directly; numbers and booleans
        // have no escapable characters; only arrays need textOf then escape.
        const v = lookup(frames, node.path);
        if (typeof v === 'string') out.push(escapeHtml(v));
        else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
        else if (Array.isArray(v)) out.push(escapeHtml(textOf(v)));
        else out.push('');
        break;
      }
      case 2: {
        const v = lookup(frames, node.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 3: {
        const v = truthy(lookup(frames, node.path));
        const branch = v !== node.not ? node.then : node.els;
        if (branch !== null) renderNodes(branch, frames, out, templates, depth);
        break;
      }
      case 4: {
        const xs = lookup(frames, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {
            [node.name]: xs[k],
            loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
          };
          frames.push(vars);
          renderNodes(node.body, frames, out, templates, depth);
          frames.pop();
        }
        break;
      }
      case 5: {
        renderIncluded(node.name, frames, out, templates, depth);
        break;
      }
    }
  }
}

// Renders an included template in the same scope, at most INCLUDE_DEPTH deep.
function renderIncluded(name, frames, out, templates, depth) {
  if (depth >= INCLUDE_DEPTH) return;
  const t = templates.get(name);
  if (t === undefined) return;
  if (t.fn !== null) {
    t.fn(lookup, textOf, truthy, escapeHtml, renderIncluded, frames, out, templates, depth + 1);
  } else {
    renderNodes(t.nodes, frames, out, templates, depth + 1);
  }
}

// --- Compiled templates -----------------------------------------------------
// A parsed template compiled to a plain function via `new Function`. The
// generated code mirrors renderNodes exactly (same lookups, same textOf, same
// truthiness, same include depth), only without the node dispatch: text is
// pushed literally, values are looked up and written inline, if/for become
// real if/for. When the platform refuses (or compilation fails), the template
// keeps fn null and the interpreter above runs it instead.

function genNodes(nodes, st) {
  let src = '';
  for (const node of nodes) {
    switch (node.k) {
      case 0:
        src += `out.push(${JSON.stringify(node.text)});`;
        break;
      case 1: {
        const v = `v${st.n++}`;
        src += `var ${v}=lookup(frames,${JSON.stringify(node.path)});`
          + `if(typeof ${v}==="string")out.push(escapeHtml(${v}));`
          + `else if(typeof ${v}==="number"||typeof ${v}==="boolean")out.push(String(${v}));`
          + `else if(Array.isArray(${v}))out.push(escapeHtml(textOf(${v})));`
          + `else out.push("");`;
        break;
      }
      case 2: {
        const v = `v${st.n++}`;
        src += `var ${v}=lookup(frames,${JSON.stringify(node.path)});`
          + `out.push(typeof ${v}==="string"?${v}:textOf(${v}));`;
        break;
      }
      case 3: {
        src += `if(truthy(lookup(frames,${JSON.stringify(node.path)}))!==${node.not}){${genNodes(node.then, st)}}`;
        if (node.els !== null) src += `else{${genNodes(node.els, st)}}`;
        break;
      }
      case 4: {
        const xs = `x${st.n++}`;
        const k = `k${st.n++}`;
        const f = `f${st.n++}`;
        src += `var ${xs}=lookup(frames,${JSON.stringify(node.path)});`
          + `if(Array.isArray(${xs})){for(var ${k}=0;${k}<${xs}.length;${k}++){`
          + `var ${f}={[${JSON.stringify(node.name)}]:${xs}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length}};`
          + `frames.push(${f});${genNodes(node.body, st)}frames.pop();}}`;
        break;
      }
      case 5:
        src += `renderIncluded(${JSON.stringify(node.name)},frames,out,templates,depth);`;
        break;
    }
  }
  return src;
}

function compileTemplate(nodes) {
  try {
    const src = genNodes(nodes, { n: 0 });
    return new Function('lookup', 'textOf', 'truthy', 'escapeHtml', 'renderIncluded',
      'frames', 'out', 'templates', 'depth', src);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One case's answer: the output tree { path: text }. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, { nodes, fn: compileTemplate(nodes) });
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }
  const staticPaths = new Set(statics.map((f) => f.path));

  // Front matter and the checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with link resolution.
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One top-level scope object per case, its page/posts/pager/tag slots
  // rewritten per render (rendering is synchronous, so reuse is safe; a slot
  // left undefined reads exactly as an absent key).
  const topVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const frames = [topVars];
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    topVars.page = vars.page;
    topVars.posts = vars.posts;
    topVars.pager = vars.pager;
    topVars.tag = vars.tag;
    const out = [];
    if (t.fn !== null) {
      t.fn(lookup, textOf, truthy, escapeHtml, renderIncluded, frames, out, templates, 0);
    } else {
      renderNodes(t.nodes, frames, out, templates, 0);
    }
    return out.join('');
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
