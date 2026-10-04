export function slugifyBankId(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9一-龥]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return text || 'question-bank';
}
