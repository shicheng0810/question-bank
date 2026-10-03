import { slugifyBankId } from './site-package.js';

export function parseManifestText(raw) {
  if (!String(raw || '').trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

export function guessPublishDefaults(questions, options = {}) {
  const first = Array.isArray(questions) ? questions.find(Boolean) : null;
  const activePrefix = String(options.activePrefix || '').trim();
  const activeSourcePrefix = String(options.activeSourcePrefix || '').trim();
  const source = Array.isArray(first && first.source) ? first.source[0] : first && first.source;
  const sourceText = String(activeSourcePrefix || source || 'Question Bank').trim();
  const bankId = slugifyBankId(activePrefix || (first && String(first.id || '').split('-')[0]) || sourceText || 'question-bank');
  return {
    bankId,
    title: sourceText || bankId,
  };
}

export function buildPublishMeta(input = {}, questions = [], options = {}) {
  const defaults = guessPublishDefaults(questions, options);
  const tags = Array.isArray(input.tags)
    ? input.tags
    : String(input.tags || '').split(',');
  const mode = input.mode === 'protected' ? 'protected' : 'public';
  return {
    id: slugifyBankId(input.bankId || defaults.bankId),
    title: String(input.title || defaults.title || defaults.bankId).trim(),
    mode,
    description: String(input.description || '').trim(),
    tags: Array.from(new Set(tags.map((tag) => String(tag || '').trim()).filter(Boolean))),
    cover: String(input.cover || '').trim(),
    passwordHint: String(input.passwordHint || '').trim(),
    password: String(input.password || ''),
  };
}

export function canGenerateQuestionBank({ parsedCount = 0, outValue = '' } = {}) {
  if (Number(parsedCount) > 0) return true;
  try {
    const parsed = JSON.parse(String(outValue || '').trim());
    return Array.isArray(parsed) ? parsed.length > 0 : !!parsed;
  } catch (_error) {
    return false;
  }
}

export function getPublishButtonState({ parsedCount = 0, outValue = '', publishMode = 'public', publishPassword = '', apiBaseUrl = '', apiKey = '' } = {}) {
  const canPublish = canGenerateQuestionBank({ parsedCount, outValue });
  const needsPassword = publishMode === 'protected' && !String(publishPassword || '').trim();
  const hasApiTarget = String(apiBaseUrl || '').trim() || String(apiKey || '').trim();
  return {
    disableSiteZip: !canPublish || needsPassword,
    disableLegacyHtml: !canPublish || needsPassword,
    disableAiDryRun: !canPublish,
    disableAiRun: !canPublish || !hasApiTarget,
  };
}
