// Fast drop-in for makefun-site 1.0.0: build(input) returns the exact same
// output tree (path -> text) as the reference generator, but every stage is a
// single hand-scanned pass: table-driven HTML escaping, char-code line checks
// instead of per-line regexes, run-batched inline rendering, cached slugs and
// dates, and templates compiled once to plain JS functions.
//
// Input:  { site: { title, base_url, per_page, recent },
//           templates: { name: source }, files: [{ path, content }] }
// Output: { "<output path>": "<file text>", ... } including build-report.txt.

// ---------------------------------------------------------------- text bits

const ESC_ONE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_TABLE = new Array(128).fill(null);
ESC_TABLE[38] = '&amp;';
ESC_TABLE[60] = '&lt;';
ESC_TABLE[62] = '&gt;';
ESC_TABLE[34] = '&quot;';
ESC_TABLE[39] = '&#39;';

const ESC_RE = /[&<>"']/g;

/** HTML-escape & < > " ': table scan for short strings, regex for long ones. */
function escHtml(s) {
  if (s.length >= 64) return s.replace(ESC_RE, (c) => ESC_ONE[c]);
  let parts = null;
  let from = 0;
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const e = c < 128 ? ESC_TABLE[c] : null;
    if (e !== null) {
      if (parts === null) parts = [];
      if (i > from) parts.push(s.slice(from, i));
      parts.push(e);
      from = i + 1;
    }
  }
  if (parts === null) return s;
  if (from < len) parts.push(s.slice(from));
  return parts.join('');
}

/** JavaScript's \s set as char codes. */
function isWsCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279
  );
}

function hasWs(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

const WS_TABLE = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_TABLE[c] = 1;

/** Word count: runs of non-whitespace characters. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? WS_TABLE[c] === 1 : isWsCode(c);
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

const slugCache = new Map();

/** Slug of a text: NFKD, marks dropped, A-Z lowered, gaps one '-', max 64. */
function slugOf(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** First free of slug, slug-2, slug-3 ... against `taken` (added to it). */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** "2026-11-09" -> "9 November 2026", from the string alone. */
function longDateOf(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = Number(date.slice(8, 10)) + ' ' + MONTH_NAMES[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
    dateCache.set(date, v);
  }
  return v;
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isDigitCode = (c) => c >= 48 && c <= 57;

function dirOfPath(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

/** Resolve `rel` against directory `dir`; null when it climbs above root. */
function resolveRel(dir, rel) {
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

/** Whether a link target opens with a scheme like "https:" or "mailto:". */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigitCode(c) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A title/summary value: quoted ("..." with \" and \\ only) or bare. */
function stringValue(key, raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'key "' + key + '": a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'key "' + key + '": a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') {
        return { error: 'key "' + key + '": a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'key "' + key + '": a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's checked value, or its refusal reason. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') return stringValue(key, raw);
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i !== 4 && i !== 7 && !isDigitCode(raw.charCodeAt(i))) { ok = false; break; }
      }
    }
    if (ok) {
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
    }
    return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      ok = (c >= 97 && c <= 122) || isDigitCode(c) || c === 45;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug: [a-z0-9]+ runs joined by single '-', at most 64 chars
  let ok = raw.length > 0 && raw.length <= 64;
  if (ok) {
    let prevDash = true; // start acts like after a dash: first char must be alnum
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if ((c >= 97 && c <= 122) || isDigitCode(c)) prevDash = false;
      else if (c === 45 && !prevDash) prevDash = true;
      else { ok = false; break; }
    }
    if (prevDash) ok = false;
  }
  return ok ? { value: raw } : { error: 'key "slug": not a slug' };
}

/** Split one front-matter line into {key, raw}; null when not "key: value". */
function fmLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0 || line.charCodeAt(i) !== 58) return null;
  let raw;
  if (i + 1 === line.length) raw = '';
  else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
  else return null;
  // a regex "." cannot cross U+2028/U+2029, so such a value refuses the line
  if (raw.includes('\u2028') || raw.includes('\u2029')) return null;
  let end = raw.length;
  while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
  if (end !== raw.length) raw = raw.slice(0, end);
  return { key: line.slice(0, i), raw };
}

function isBlankFm(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Parse front matter: { data, body } or { error } with the first reason. */
function parseFm(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // first find the closing line, as the reference does, then read the lines
  const fmLines = [];
  let bodyStart = -1;
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') { bodyStart = nl === -1 ? text.length : nl + 1; break; }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let idx = 0; idx < fmLines.length; idx++) {
    const line = fmLines[idx];
    if (isBlankFm(line) || line.charCodeAt(0) === 35) continue;
    const parsed = fmLine(line);
    if (parsed === null) return { error: 'line ' + (idx + 2) + ' is not "key: value"' };
    const key = parsed.key;
    if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (parsed.raw === '') return { error: 'key "' + key + '" has no value' };
    const v = fmValue(key, parsed.raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Fence opener: its language ("" for none), or null when not a fence. */
function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigitCode(c) || c === 95 || c === 43 || c === 45) i++;
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
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Heading line: { depth, text } or null. */
function headingParse(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6 || depth >= line.length) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let i = depth;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  const text = line.slice(i, end);
  if (text.includes('\u2028') || text.includes('\u2029')) return null;
  return { depth, text };
}

function isHrLine(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function bulletItem(line) {
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== 32) return null;
  const text = line.slice(2);
  if (text.includes('\u2028') || text.includes('\u2029')) return null;
  return text;
}

function orderedItem(line) {
  let i = 0;
  while (i < line.length && isDigitCode(line.charCodeAt(i))) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  const text = line.slice(i + 2);
  if (text.includes('\u2028') || text.includes('\u2029')) return null;
  return { num: Number(line.slice(0, i)), text };
}

/** A list continuation: two or more spaces then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function endsPara(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingParse(line) !== null;
  if (c0 === 45 || c0 === 42) return isHrLine(line);
  return isBlankLine(line);
}

// inline rendering -----------------------------------------------------------

const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE[ch.charCodeAt(0)] = 1;
}

function escapableAt(s, i) {
  const c = s.charCodeAt(i);
  return c < 128 && ESCAPABLE[c] === 1;
}

/** First index >= from of `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  const w0 = what.charCodeAt(0);
  const w1 = what.length > 1 ? what.charCodeAt(1) : -1;
  const limit = s.length - what.length;
  for (let j = from; j <= limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && escapableAt(s, j + 1)) { j++; continue; }
    if (c === w0 && (w1 === -1 || s.charCodeAt(j + 1) === w1)) return j;
  }
  return -1;
}

/** First single '*' (not part of '**') outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && escapableAt(s, j + 1)) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = new Uint8Array(128);
INLINE_SPECIAL[92] = 1; // backslash
INLINE_SPECIAL[96] = 1; // backtick
INLINE_SPECIAL[42] = 1; // star
INLINE_SPECIAL[91] = 1; // [

/** Inline HTML for `s`; plain runs are escaped in bulk between constructs. */
function inlineMd(s, linkFn) {
  let out = '';
  let i = 0;
  let runStart = 0;
  const len = s.length;
  const flush = (end) => { if (end > runStart) out += escHtml(s.slice(runStart, end)); };
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c >= 128 || INLINE_SPECIAL[c] === 0) { i++; continue; }
    if (c === 92 && i + 1 < len && escapableAt(s, i + 1)) {
      flush(i);
      const ch = s[i + 1];
      out += ESC_ONE[ch] ?? ch;
      i += 2;
      runStart = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += '<code>' + escHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnesc(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += '<strong>' + inlineMd(s.slice(i + 2, j), linkFn) + '</strong>';
          i = j + 2;
          runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out += '<em>' + inlineMd(s.slice(i + 1, j), linkFn) + '</em>';
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      const k = findUnesc(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWs(target)) {
        flush(i);
        out += '<a href="' + escHtml(linkFn(target)) + '">' + inlineMd(s.slice(i + 1, k), linkFn) + '</a>';
        i = m + 1;
        runStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(len);
  return out;
}

/** Render a body: { html, toc, excerpt } in one pass over its lines. */
function renderMd(src, linkFn) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if ((c0 === 32 || c0 === 9 || Number.isNaN(c0)) && isBlankLine(line)) { i++; continue; }
    const lang = c0 === 96 ? fenceLang(line) : null;
    if (lang !== null) {
      i++;
      let inner = '';
      while (i < n && !isFenceClose(lines[i])) { inner += escHtml(lines[i]) + '\n'; i++; }
      i++;
      const cls = lang === '' ? '' : ' class="language-' + escHtml(lang) + '"';
      blocks.push('<pre><code' + cls + '>' + inner + '</code></pre>');
      continue;
    }
    const h = c0 === 35 ? headingParse(line) : null;
    if (h !== null) {
      const id = uniqSlug(slugOf(h.text), ids);
      const html = inlineMd(h.text, linkFn);
      blocks.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>');
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHrLine(line)) { blocks.push('<hr>'); i++; continue; }
    if (c0 === 62) {
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') parts.push(l);
        i++;
      }
      blocks.push(parts.length === 0
        ? '<blockquote>\n</blockquote>'
        : '<blockquote>\n<p>' + inlineMd(parts.join('\n'), linkFn) + '</p>\n</blockquote>');
      continue;
    }
    const bText = c0 === 45 || c0 === 42 ? bulletItem(line) : null;
    const oItem = bText === null && isDigitCode(c0) ? orderedItem(line) : null;
    if (bText !== null || oItem !== null) {
      const ordered = oItem !== null;
      const start = ordered ? oItem.num : 1;
      const items = [];
      while (i < n) {
        const cur = lines[i];
        const it = ordered ? orderedItem(cur) : bulletItem(cur);
        if (it !== null) {
          items.push([trimLine(ordered ? it.text : it)]);
          i++;
        } else if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let inner = '';
      for (const parts of items) inner += '<li>' + inlineMd(parts.join('\n'), linkFn) + '</li>\n';
      blocks.push(open + '\n' + inner + '</' + tag + '>');
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) { parts.push(trimLine(lines[i])); i++; }
    const html = inlineMd(parts.join('\n'), linkFn);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

class TplError extends Error {}

function isIdentStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isIdentChar(c) {
  return isIdentStart(c) || isDigitCode(c);
}

/** Validate a dotted path; returns its segments or throws TplError. */
function parsePath(name, text) {
  let ok = text.length > 0 && isIdentStart(text.charCodeAt(0));
  if (ok) {
    let segStart = false; // first char already checked: we are inside segment 1
    for (let i = 1; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 46) {
        if (segStart) { ok = false; break; }
        segStart = true;
      } else if (segStart) {
        if (!isIdentStart(c)) { ok = false; break; }
        segStart = false;
      } else if (!isIdentChar(c)) { ok = false; break; }
    }
    if (segStart) ok = false;
  }
  if (!ok) throw new TplError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function isSpaceTab(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Tokens of a template: text / var / raw / tag, standalone {% %} lines eaten. */
function tokenizeTpl(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TplError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: parsePath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isSpaceTab(src.slice(lineStart, open)) && isSpaceTab(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** "for x in path" -> { name, pathText } or null. */
function matchFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (i >= tag.length || !isIdentStart(tag.charCodeAt(i))) return null;
  const start = i;
  while (i < tag.length && isIdentChar(tag.charCodeAt(i))) i++;
  const varName = tag.slice(start, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const pathText = tag.slice(i + 4);
  if (pathText === '' || hasWs(pathText)) return null;
  return { name: varName, pathText };
}

/** "if [not] path" -> { not, pathText } or null. */
function matchIf(tag) {
  if (!tag.startsWith('if ')) return null;
  const rest = tag.slice(3);
  if (rest.startsWith('not ')) {
    const pathText = rest.slice(4);
    if (pathText !== '' && !hasWs(pathText)) return { not: true, pathText };
    return null;
  }
  if (rest === '' || hasWs(rest)) return null;
  return { not: false, pathText: rest };
}

/** 'include "name"' -> name or null. */
function matchInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const name = tag.slice(9, -1);
  if (name === '') return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || isDigitCode(c) || c === 45)) return null;
  }
  return name;
}

/** Parse a template into its node tree (TplError when it does not parse). */
function parseTpl(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    const forM = matchFor(tag);
    if (forM !== null) {
      const node = { kind: 'for', name: forM.name, path: parsePath(name, forM.pathText), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
      continue;
    }
    const ifM = matchIf(tag);
    if (ifM !== null) {
      const node = { kind: 'if', not: ifM.not, path: parsePath(name, ifM.pathText), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TplError('template "' + name + '": an else outside an if');
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TplError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
      continue;
    }
    const inc = matchInclude(tag);
    if (inc !== null) { body.push({ kind: 'include', name: inc }); continue; }
    throw new TplError('template "' + name + '": {% ' + tag + ' %} is not a tag');
  }
  if (stack.length > 1) throw new TplError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** Value at `path`: first name from the nearest frame holding it, then own props. */
function lookupPath(frames, path) {
  const first = path[0];
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, first)) {
      let v = vars[first];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: string itself, number digits, true/false, array joined. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

function truthyVal(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const TPL_HELPERS = { L: lookupPath, X: escHtml, S: textOf, Y: truthyVal };

/** Generate JS source for a node list; `uid` mints collision-free locals. */
function genNodes(nodes, uid) {
  let code = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      code += 'O.push(' + JSON.stringify(node.text) + ');';
    } else if (node.kind === 'var') {
      code += 'O.push(H.X(H.S(H.L(F,' + JSON.stringify(node.path) + '))));';
    } else if (node.kind === 'raw') {
      code += 'O.push(H.S(H.L(F,' + JSON.stringify(node.path) + ')));';
    } else if (node.kind === 'if') {
      code += 'if(H.Y(H.L(F,' + JSON.stringify(node.path) + '))===' + (node.not ? 'false' : 'true') + '){' + genNodes(node.then, uid) + '}';
      if (node.else !== null) code += 'else{' + genNodes(node.else, uid) + '}';
    } else if (node.kind === 'for') {
      const id = uid.next++;
      code += '{const _a' + id + '=H.L(F,' + JSON.stringify(node.path) + ');' +
        'if(Array.isArray(_a' + id + ')){const _n' + id + '=_a' + id + '.length;' +
        'for(let _i' + id + '=0;_i' + id + '<_n' + id + ';_i' + id + '++){' +
        'F.push({' + JSON.stringify(node.name) + ':_a' + id + '[_i' + id + '],' +
        'loop:{index:_i' + id + '+1,first:_i' + id + '===0,last:_i' + id + '===_n' + id + '-1,length:_n' + id + '}});' +
        genNodes(node.body, uid) +
        'F.pop();}}}';
    } else if (node.kind === 'include') {
      const id = uid.next++;
      code += '{const _t' + id + '=T.get(' + JSON.stringify(node.name) + ');' +
        'if(_t' + id + '!==undefined&&D<8)_t' + id + '(F,O,D+1,T,H);}';
    }
  }
  return code;
}

/** Compile a template to a render function (F frames, O out, D depth, T templates, H helpers). */
function compileTpl(name, src) {
  const nodes = parseTpl(name, src);
  const uid = { next: 0 };
  return new Function('F', 'O', 'D', 'T', 'H', genNodes(nodes, uid));
}

function renderTpl(fn, vars, templates) {
  const out = [];
  fn([vars], out, 0, templates, TPL_HELPERS);
  return out.join('');
}

// ------------------------------------------------------------------- build

const RESERVED_DIRS = ['posts', 'tags', 'page'];

/** The output tree for one site input, exactly as the reference builds it. */
export function run(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(cmpStr)) {
    try {
      templates.set(name, compileTpl(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TplError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // 1. sources in path order; .md files are sources, the rest static
  const files = input.files.slice().sort((a, b) => cmpStr(a.path, b.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. front matter and the refusal checks, in the reference's order
  const kept = [];
  for (const s of sources) {
    const fm = parseFm(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks: slugs unique per directory, reserved names at the root
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOfPath(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    s.slug = uniqSlug(s.data.slug ?? slugOf(s.data.title), taken);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. markdown with link resolution
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOfPath(s.path);
    const linkFn = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null) {
        const hit = bySource.get(path);
        if (hit !== undefined) return hit.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMd(s.body, linkFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. posts newest first, slug breaking ties; neighbours linked
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags grouped by slug, named as first met in post order
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugOf(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));

  // cards and page views, each built once per source
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. layouts: pages, paginated index, tag pages, tags index, statics
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(cardOf);
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return renderTpl(fn, { site, tags: allTags, recent, ...vars }, templates);
  };
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(cardOf),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(cardOf) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. the report: sorted lines, then the built counts
  const lines = [...report, ...broken].sort(cmpStr);
  let pageTotal = 0;
  for (const s of sources) if (!s.post) pageTotal++;
  lines.push('built ' + pageTotal + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
