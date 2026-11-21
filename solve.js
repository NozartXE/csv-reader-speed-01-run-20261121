// Fast drop-in for csv-reader 1.0.0: identical {columns, rows, errors} output,
// reached by jumping between delimiters with indexOf instead of stepping
// character by character. Single left-to-right pass over the input text.
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

  // Line/record where the field currently being read started; errors made
  // while reading a field are stamped with it.
  let fieldLine = 1;
  let fieldRow = null;
  const fail = (code) => errors.push({ code, line: fieldLine, row: fieldRow });

  // Read one unquoted field starting at pos. `head` is text already
  // belonging to this field (the quoted part, when we are reading the junk
  // that follows a closing quote); `added` counts how many characters this
  // call appended after `head`, so the caller can tell junk from nothing.
  // Ends at a comma, a line break, or end of input. CRs inside the scanned
  // stretch are dropped: each one is a stray_cr, except a CR sitting right
  // before the LF that ended the stretch, which is that LF's CRLF partner.
  function readPlain(head) {
    const parts = head ? [head] : [];
    let added = 0;
    const stripCRs = (seg, lastCRisCRLF) => {
      let k = seg.indexOf('\r');
      if (k < 0) return seg;
      let out = '';
      let from = 0;
      while (k >= 0) {
        if (!(lastCRisCRLF && k === seg.length - 1)) fail('stray_cr');
        out += seg.slice(from, k);
        from = k + 1;
        k = seg.indexOf('\r', from);
      }
      return out + seg.slice(from);
    };
    const comma = text.indexOf(',', pos);
    const lf = text.indexOf('\n', pos);
    // The nearer delimiter wins; no delimiter means the rest of the text.
    if (comma < 0 && lf < 0) {
      if (pos < n) {
        const kept = stripCRs(text.slice(pos, n), false);
        if (kept) { parts.push(kept); added += kept.length; }
        pos = n;
      }
      return { value: parts.length === 1 ? parts[0] : parts.join(''), ended: 'end', added };
    }
    const atComma = comma >= 0 && (lf < 0 || comma < lf);
    const cut = atComma ? comma : lf;
    const kept = stripCRs(text.slice(pos, cut), !atComma);
    if (kept) { parts.push(kept); added += kept.length; }
    if (atComma) {
      pos = cut + 1;
      return { value: parts.length === 1 ? parts[0] : parts.join(''), ended: 'comma', added };
    }
    pos = cut + 1;
    line += 1;
    return { value: parts.length === 1 ? parts[0] : parts.join(''), ended: 'line break', added };
  }

  // Read one quoted field starting at pos (text[pos] === '"').
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    // Find the closing quote: indexOf('"') jumps from quote to quote, and a
    // doubled quote is skipped by stepping past the pair.
    let close = -1;
    for (let q = pos; ;) {
      const qq = text.indexOf('"', q);
      if (qq < 0) break;
      if (qq + 1 < n && text.charCodeAt(qq + 1) === 34) { q = qq + 2; continue; }
      close = qq;
      break;
    }
    if (close < 0) {
      // No closing quote: the quote is literal, re-read from just after it
      // as an unquoted field. The scan above never moved `line`, so restore
      // the line the field opened on.
      pos = open + 1;
      line = openLine;
      fail('unterminated_quote');
      return readPlain('"');
    }
    let raw = text.slice(open + 1, close);
    // Only pay for the normalisation pass when the field actually contains
    // something to normalise; most fields take the fast path.
    if (raw.indexOf('"') >= 0 || raw.indexOf('\r') >= 0 || raw.indexOf('\n') >= 0) {
      let breaks = 0;
      raw = raw.replace(/""|\r\n?|\n/g, (m) => {
        if (m === '""') return '"';
        breaks += 1;
        return '\n';
      });
      line += breaks;
    }
    pos = close + 1;
    if (pos >= n) return { value: raw, ended: 'end' };
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; return { value: raw, ended: 'comma' }; }
    if (c === 10) { pos += 1; line += 1; return { value: raw, ended: 'line break' }; }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value: raw, ended: 'line break' };
    }
    // Junk follows the closing quote: it is appended as-is up to the next
    // comma or line break, and counts as quote_junk when anything was added.
    const junk = readPlain(raw);
    if (junk.added > 0) fail('quote_junk');
    return junk;
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
    fieldLine = line;
    fieldRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let wasQuoted;
    do {
      wasQuoted = text.charCodeAt(pos) === 34;
      field = wasQuoted ? readQuoted() : readPlain('');
      fields.push(field.value);
    } while (field.ended === 'comma');
    // One empty unquoted field is an empty line, not a record.
    if (fields.length === 1 && fields[0] === '' && !wasQuoted) continue;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: fieldLine, row: fieldRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: fieldLine, row: fieldRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
