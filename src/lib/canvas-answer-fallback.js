export function isCanvasCorrectQuestionBlockClass(clsAll) {
  const text = String(clsAll || '');
  return /\bcorrect\b/i.test(text) && !/\bincorrect\b/i.test(text);
}

export function shouldUseSelectedAnswersAsCorrectFallback({
  clsAll = '',
  explicitCorrectIndexes = [],
  selectedIndexes = [],
} = {}) {
  return (
    isCanvasCorrectQuestionBlockClass(clsAll)
    && Array.isArray(explicitCorrectIndexes)
    && explicitCorrectIndexes.length === 0
    && Array.isArray(selectedIndexes)
    && selectedIndexes.length > 0
  );
}
