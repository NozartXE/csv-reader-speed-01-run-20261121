// Fast drop-in for csv-reader 1.0.0: identical {columns, rows, errors} output,
// reached by scanning each field exactly once for its next delimiter instead
// of stepping character by character. Single left-to-right pass over the
// input text; per plain field, native indexOf scans find the earlier of the
// next comma and the next LF and an amortised lookup finds the next CR (a
// field holding a CR beyond the CRLF partner takes a regex scan instead),
// per quoted field one scan finds the first of {quote, CR, LF} for
// normalisation, CRs are resolved inline by looking at the one character
// after them, and no per-field closures or result objects are allocated —
// field results travel through the fValue/fEnded/fAdded closure variables.
//
// Semantics (from the task spec, re-derived here, not copied from the
// reference): BOM dropped at the very start; a record ends at LF or CRLF;
// a line left with no characters is no record; a CR outside quotes not
// followed by LF is dropped (stray_cr); a field opening with a quote runs to
// the next non-doubled quote ("" inside is one quote, CR/LF inside read as
// LF); anything after the closing quote up to the next comma or line break is
// appended as-is (quote_junk when the field ends); a quote that never closes
// is literal and the text after it is re-read as unquoted
// (unterminated_quote); a quote inside an unquoted field is literal. Fields
// stay strings, never trimmed. columns is the first record when header is
// true, else null; rows are padded (short_row, fields: count) or cut
// (long_row, extra: cut fields) to the first record's width. Each error is
// {code, line, row} in the order met; line is the 1-based line the record
// starts on, counting every LF, CRLF and lone CR inside quotes; row is the
// record's index in rows, null for the header.
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  // Drop a leading U+FEFF.
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Line/record where the record currently being read started; errors made
  // while reading any of its fields are stamped with it.
  let recordLine = 1;
  let recordRow = null;
  const fail = (code) => errors.push({ code, line: recordLine, row: recordRow });

  // The field just read: its value, how it ended, and how many characters
  // were appended after a caller-supplied head (junk detection).
  let fValue = '';
  let fEnded = 'end';
  let fAdded = 0;

  const plainScan = /[,\n\r]/g;
  const quoteScan = /["\r\n]/g;

  // Memoised failed close-search. A close-search that reaches end of input
  // has proven every quote from its start onward sits in an adjacent doubled
  // pair under its own pairing; without a memo, a later quote-opening field
  // would rescan the same remainder. The memo records that search's start
  // and every quote position from it onward; a later search resolves
  // against the list alone (binary search + pair walk over positions),
  // never by rescanning the text. When the shifted pairing also fails, the
  // memo re-bases to the later start.
  let memoFrom = -1;
  let memoQuotes = null;
  let memoOff = 0;
  function findClose(from) {
    if (memoQuotes !== null && from >= memoFrom) {
      let lo = memoOff;
      let hi = memoQuotes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (memoQuotes[mid] < from) lo = mid + 1; else hi = mid;
      }
      const len = memoQuotes.length;
      for (let t = lo; t < len; t += 2) {
        if (t + 1 >= len || memoQuotes[t + 1] !== memoQuotes[t] + 1) return memoQuotes[t];
      }
      memoFrom = from;
      memoOff = lo;
      return -1;
    }
    // Text walk: indexOf('"') jumps from quote to quote, a doubled quote is
    // skipped by stepping past the pair. Visited openers are collected so a
    // failure can seed the memo.
    const visited = [];
    for (let q = from; ;) {
      const qq = text.indexOf('"', q);
      if (qq < 0) break;
      if (qq + 1 < n && text.charCodeAt(qq + 1) === 34) { visited.push(qq); q = qq + 2; continue; }
      return qq;
    }
    memoQuotes = [];
    for (const v of visited) memoQuotes.push(v, v + 1);
    memoFrom = from;
    memoOff = 0;
    return -1;
  }

  // First CR at or after p, amortised over the whole parse: CR positions
  // are visited once, in order (field starts never move backwards), and the
  // "no CR from here on" answer is sticky, so the sparse-CR lookup costs
  // one native scan per CR plus one final scan to end of input — never a
  // rescan per field.
  let crFrom = 0;
  let crNext = -1;
  let crInit = false;
  function firstCr(p) {
    if (!crInit || p < crFrom) {
      crFrom = p;
      crNext = text.indexOf('\r', p);
      crInit = true;
    }
    while (crNext !== -1 && crNext < p) {
      crFrom = crNext + 1;
      crNext = text.indexOf('\r', crFrom);
    }
    return crNext;
  }

  // Read one unquoted field starting at pos into fValue/fEnded/fAdded.
  // `head` is text already belonging to this field (the normalised quoted
  // part, when reading the junk after a closing quote, or '"' for the
  // unterminated re-read); fAdded counts characters appended after `head`.
  // Fast paths, cheapest first. Most fields are short (numbers, dates,
  // codes, single words), so a charCodeAt prefix scan of up to 24 chars
  // resolves them with no scan call at all: it stops at the first comma,
  // LF or CR — a comma or LF ends the field cleanly (the prefix holds no
  // CR, so there is nothing to drop), a CR ends it only as the CRLF
  // partner of the LF right after it, and any other CR takes the slow
  // path. A field running to end of input inside the prefix is resolved
  // there too. Longer fields take the indexOf path: two native scans find
  // the earlier of the next comma and the next LF; when no CR sits inside
  // the field — or the only one is the CRLF partner of the LF that ends
  // it — the value is a single slice. A CR anywhere else inside the field
  // is rare (stray_cr records) and takes the slow path, which is the
  // original regex scan, unchanged.
  function readPlain(head) {
    const start = pos;
    let i = start;
    const lim = start + 24 < n ? start + 24 : n;
    while (i < lim) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10 || c === 13) break;
      i += 1;
    }
    if (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10) {
        if (c === 10) line += 1;
        pos = i + 1;
        const tail = start < i ? text.slice(start, i) : '';
        fValue = head ? head + tail : tail;
        fEnded = c === 44 ? 'comma' : 'line break';
        fAdded = tail.length;
        return;
      }
      if (c === 13 && text.charCodeAt(i + 1) === 10) {
        line += 1;
        pos = i + 2;
        const tail = start < i ? text.slice(start, i) : '';
        fValue = head ? head + tail : tail;
        fEnded = 'line break';
        fAdded = tail.length;
        return;
      }
      if (c === 13) {
        readPlainSlow(head);
        return;
      }
      // i === lim < n and text[i] is an ordinary char: long field, the
      // indexOf path below picks up from here (the prefix held no
      // delimiter and no CR, so the scans may start at i).
    } else {
      // The prefix ran to end of input: no delimiter, no CR.
      pos = n;
      const tail = start < n ? text.slice(start, n) : '';
      fValue = head ? head + tail : tail;
      fEnded = 'end';
      fAdded = tail.length;
      return;
    }
    const ci = text.indexOf(',', i);
    const li = text.indexOf('\n', i);
    let end;
    let ended;
    let newPos;
    if (li !== -1 && (ci === -1 || li < ci)) {
      end = li;
      ended = 'line break';
      newPos = li + 1;
    } else if (ci !== -1) {
      end = ci;
      ended = 'comma';
      newPos = ci + 1;
    } else {
      end = n;
      ended = 'end';
      newPos = n;
    }
    let valueEnd = end;
    const cr = firstCr(start);
    if (cr !== -1 && cr < end) {
      if (ended === 'line break' && cr === end - 1) {
        valueEnd = end - 1;
      } else {
        readPlainSlow(head);
        return;
      }
    }
    if (ended === 'line break') line += 1;
    pos = newPos;
    const tail = start < valueEnd ? text.slice(start, valueEnd) : '';
    fValue = head ? head + tail : tail;
    fEnded = ended;
    fAdded = tail.length;
  }

  // The original scan, kept for fields holding a CR: one regex pass finds
  // each special in turn; a comma or LF ends the field, a CR is dropped
  // inline — a stray_cr, except a CR immediately before the LF that ends
  // the field, which is that LF's CRLF partner and is dropped silently.
  function readPlainSlow(head) {
    let parts = null;
    let added = 0;
    let start = pos;
    let end = n;
    let ended = 'end';
    let newPos = n;
    plainScan.lastIndex = pos;
    let m;
    while ((m = plainScan.exec(text)) !== null) {
      const i = m.index;
      const c = m[0];
      if (c === '\r') {
        if (text.charCodeAt(i + 1) === 10) {
          end = i;
          ended = 'line break';
          newPos = i + 2;
          line += 1;
          break;
        }
        fail('stray_cr');
        if (parts === null) parts = head ? [head] : [];
        if (i > start) {
          const frag = text.slice(start, i);
          parts.push(frag);
          added += frag.length;
        }
        start = i + 1;
        continue;
      }
      end = i;
      ended = c === ',' ? 'comma' : 'line break';
      newPos = i + 1;
      if (c === '\n') line += 1;
      break;
    }
    pos = newPos;
    const tail = start < end ? text.slice(start, end) : '';
    if (tail) added += tail.length;
    if (parts === null) {
      fValue = head ? head + tail : tail;
    } else {
      if (tail) parts.push(tail);
      fValue = parts.join('');
    }
    fEnded = ended;
    fAdded = added;
  }

  // Read one quoted field starting at pos (text[pos] === '"').
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const close = findClose(open + 1);
    if (close < 0) {
      // No closing quote: the quote is literal, re-read from just after it
      // as an unquoted field. The search never moved `line`, so restore the
      // line the field opened on.
      pos = open + 1;
      line = openLine;
      fail('unterminated_quote');
      readPlain('"');
      return;
    }
    let value;
    // Only pay for the normalisation pass when the field actually contains
    // something to normalise; most fields take the fast path. The first
    // special at or after open+1 decides: at/after close means none inside.
    quoteScan.lastIndex = open + 1;
    const first = quoteScan.exec(text);
    if (first === null || first.index >= close) {
      value = text.slice(open + 1, close);
    } else {
      // One manual pass jumping between specials: a quote here is always a
      // doubled pair (the close search paired them), CR/LF each become one
      // LF and count one line break.
      const parts = [];
      let start = open + 1;
      let breaks = 0;
      let i = first.index;
      for (;;) {
        const c = text.charCodeAt(i);
        if (start < i) parts.push(text.slice(start, i));
        if (c === 34) {
          parts.push('"');
          i += 2;
        } else if (c === 13) {
          breaks += 1;
          parts.push('\n');
          i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        } else {
          breaks += 1;
          parts.push('\n');
          i += 1;
        }
        start = i;
        if (i >= close) break;
        quoteScan.lastIndex = i;
        const nx = quoteScan.exec(text);
        if (nx === null || nx.index >= close) break;
        i = nx.index;
      }
      if (start < close) parts.push(text.slice(start, close));
      line += breaks;
      value = parts.join('');
    }
    pos = close + 1;
    if (pos >= n) { fValue = value; fEnded = 'end'; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fValue = value; fEnded = 'comma'; return; }
    if (c === 10) { pos += 1; line += 1; fValue = value; fEnded = 'line break'; return; }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = 'line break';
      return;
    }
    // Junk follows the closing quote: it is appended as-is up to the next
    // comma or line break, and counts as quote_junk when anything was added.
    readPlain(value);
    if (fAdded > 0) fail('quote_junk');
  }

  for (;;) {
    // Skip blank lines: a line left with no characters is no record.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    let fields;
    let extras = null;
    let count = 0;
    if (width >= 0) fields = new Array(width); else fields = [];
    let wasQuoted = false;
    for (;;) {
      wasQuoted = text.charCodeAt(pos) === 34;
      if (wasQuoted) readQuoted(); else readPlain('');
      if (width >= 0) {
        if (count < width) fields[count] = fValue;
        else {
          if (extras === null) extras = [];
          extras.push(fValue);
        }
      } else {
        fields.push(fValue);
      }
      count += 1;
      if (fEnded !== 'comma') break;
    }
    // One empty unquoted field is an empty line, not a record.
    if (count === 1 && fields[0] === '' && !wasQuoted) continue;
    if (width < 0) width = count;
    if (header && columns === null) { columns = fields; continue; }
    if (count < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: count });
      for (let i = count; i < width; i++) fields[i] = '';
    } else if (count > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: extras });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
