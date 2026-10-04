export function rapidOcrResultToTesseractData(result = {}) {
  const fragments = normalizeRapidOcrLines(result)
    .map((line) => ({
      text: cleanText(line.text || line.rec_txt || line.recText),
      confidence: normalizeConfidence(line.confidence != null ? line.confidence : (line.score != null ? line.score : line.rec_score)),
      bbox: boxToBBox(line.box || line.bbox || line.dt_boxes || line.dtBoxes),
    }))
    .filter((line) => line.text && line.bbox)
    .sort((a, b) => a.bbox.y0 === b.bbox.y0 ? a.bbox.x0 - b.bbox.x0 : a.bbox.y0 - b.bbox.y0);

  const lines = buildRows(fragments);
  const words = buildWords(fragments);

  return {
    text: lines.map((line) => line.text).join('\n'),
    lines,
    words: words.map((word) => ({
      text: word.text,
      confidence: word.confidence,
      bbox: word.bbox,
      forceSpaceBefore: !!word.forceSpaceBefore,
    })),
    rapidOcrMeta: {
      engine: cleanText(result.engine) || 'rapidocr',
      model: cleanText(result.model),
      lineCount: lines.length,
      fragmentCount: fragments.length,
      wordCount: words.length,
    },
  };
}

function buildWords(fragments) {
  const tokens = Array.from(fragments || []).flatMap(splitFragmentIntoWords);
  return groupRows(tokens).flatMap((row) => {
    const items = dropDuplicateLetterTokens(row.items);
    return items.map((word, index) => ({
      ...word,
      forceSpaceBefore: index > 0,
    }));
  });
}

function splitFragmentIntoWords(fragment) {
  if (!(fragment && fragment.bbox && fragment.text)) return [];
  const text = cleanText(fragment.text);
  const matches = Array.from(text.matchAll(/\S+/g));
  if (matches.length <= 1) {
    return [{
      text,
      confidence: fragment.confidence,
      bbox: fragment.bbox,
      forceSpaceBefore: false,
    }];
  }

  const totalChars = Math.max(1, text.length);
  return matches.map((match, index) => {
    const token = match[0];
    const start = Number(match.index) || 0;
    const end = start + token.length;
    return {
      text: token,
      confidence: fragment.confidence,
      bbox: makeBBox(
        fragment.bbox.x0 + (start / totalChars) * fragment.bbox.w,
        fragment.bbox.y0,
        fragment.bbox.x0 + (end / totalChars) * fragment.bbox.w,
        fragment.bbox.y1,
      ),
      forceSpaceBefore: index > 0,
    };
  });
}

function dropDuplicateLetterTokens(items) {
  const words = Array.from(items || []);
  return words.filter((word, index) => {
    const bare = wordTextLetters(word && word.text);
    if (bare.length !== 1) return true;
    if (bare === 'a' || bare === 'i') return true;

    const prev = wordTextLetters(words[index - 1] && words[index - 1].text);
    const next = wordTextLetters(words[index + 1] && words[index + 1].text);
    const repeatsPrevTail = prev && (prev.endsWith(bare) || prev.startsWith(bare));
    const repeatsNextHead = next && next.startsWith(bare);
    return !(repeatsPrevTail || repeatsNextHead);
  });
}

function wordTextLetters(value) {
  return String(value || '').replace(/[^A-Za-z]/g, '').toLowerCase();
}

function buildRows(lines) {
  return groupRows(lines).map((row) => {
    const items = row.items;
    const bbox = unionBBoxes(items.map((item) => item.bbox));
    const confidence = items.length
      ? Math.round(items.reduce((sum, item) => sum + item.confidence, 0) / items.length)
      : 0;
    return {
      text: items.map((item) => item.text).join(' '),
      confidence,
      bbox,
    };
  });
}

function groupRows(lines) {
  const sorted = Array.from(lines || [])
    .filter((line) => line && line.bbox && line.text)
    .sort((a, b) => a.bbox.cy === b.bbox.cy ? a.bbox.x0 - b.bbox.x0 : a.bbox.cy - b.bbox.cy);
  if (!sorted.length) return [];
  const heights = sorted.map((line) => line.bbox.h).filter(Boolean).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 18;
  const threshold = Math.max(8, medianH * 0.72);
  const rows = [];
  sorted.forEach((line) => {
    let row = rows[rows.length - 1];
    if (!row || Math.abs(line.bbox.cy - row.cy) > threshold) {
      rows.push({ items: [line], y0: line.bbox.y0, y1: line.bbox.y1, cy: line.bbox.cy });
      return;
    }
    row.items.push(line);
    row.y0 = Math.min(row.y0, line.bbox.y0);
    row.y1 = Math.max(row.y1, line.bbox.y1);
    row.cy = (row.y0 + row.y1) / 2;
  });
  return rows.map((row) => ({
    ...row,
    items: row.items.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0),
  }));
}

function normalizeRapidOcrLines(result) {
  if (Array.isArray(result && result.lines)) return result.lines;
  if (Array.isArray(result && result.results)) return result.results;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    return Object.keys(result)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => result[key])
      .filter((entry) => entry && typeof entry === 'object');
  }
  return [];
}

function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1) return Math.round(n * 100);
  return Math.round(Math.max(0, Math.min(100, n)));
}

function boxToBBox(value) {
  if (!value) return null;
  if (value.x0 != null || value.left != null) {
    const x0 = Number(value.x0 != null ? value.x0 : value.left);
    const y0 = Number(value.y0 != null ? value.y0 : value.top);
    const x1 = Number(value.x1 != null ? value.x1 : value.right);
    const y1 = Number(value.y1 != null ? value.y1 : value.bottom);
    return makeBBox(x0, y0, x1, y1);
  }
  const points = Array.isArray(value) ? value : [];
  const flatPoints = points
    .map((point) => Array.isArray(point) ? point : [point && point.x, point && point.y])
    .filter((point) => point.length >= 2);
  if (!flatPoints.length) return null;
  const xs = flatPoints.map((point) => Number(point[0])).filter(Number.isFinite);
  const ys = flatPoints.map((point) => Number(point[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  return makeBBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function makeBBox(x0, y0, x1, y1) {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const right = Math.max(x0, x1);
  const bottom = Math.max(y0, y1);
  return {
    x0: left,
    y0: top,
    x1: right,
    y1: bottom,
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
  };
}

function unionBBoxes(boxes) {
  const clean = Array.from(boxes || []).filter(Boolean);
  if (!clean.length) return null;
  return makeBBox(
    Math.min(...clean.map((box) => box.x0)),
    Math.min(...clean.map((box) => box.y0)),
    Math.max(...clean.map((box) => box.x1)),
    Math.max(...clean.map((box) => box.y1)),
  );
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
