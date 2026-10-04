export function nextUniqueGeneratedId(baseId, usedIds = new Set()) {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds || []);
  const normalized = String(baseId || 'generated-question')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'generated-question';
  let candidate = normalized;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${normalized}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}
