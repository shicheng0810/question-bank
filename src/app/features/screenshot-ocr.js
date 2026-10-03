import { appContext } from '../core.js';
import {
  applyDeepSeekOcrRepair,
  buildRapidOcrDebugMeta,
  buildDeepSeekOcrRepairPayload,
  findUnlabeledChoiceRowSplit,
  ocrBinaryPixelValue,
  parseDeepSeekOcrRepairResponse,
  repairOcrChoiceText,
  repairOcrQuestionText,
} from './screenshot-ocr-logic.js';
import {
  DEFAULT_OPENAI_VISION_DETAIL,
  DEFAULT_OPENAI_VISION_FALLBACK_MODEL,
  DEFAULT_OPENAI_VISION_MODEL,
  DEFAULT_OPENAI_VISION_REASONING,
  openAiVisionExtractionToParsedQuestion,
  shouldUseOpenAiVisionFallback,
} from './openai-vision-ocr-logic.js';

export function init() {
  const refs = {
    imgFile: document.getElementById('imgFile'),
    ocrImagesBtn: document.getElementById('ocrImagesBtn'),
    ocrActiveBtn: document.getElementById('ocrActiveBtn'),
    imgStatus: document.getElementById('imgStatus'),
    imgDropZone: document.getElementById('imgDropZone'),
    ocrLang: document.getElementById('ocrLang'),
    ocrPreferColor: document.getElementById('ocrPreferColor'),
    ocrDebug: document.getElementById('ocrDebug'),
    ocrAiRepair: document.getElementById('ocrAiRepair'),
    ocrAiApiKey: document.getElementById('ocrAiApiKey'),
    ocrAiBaseUrl: document.getElementById('ocrAiBaseUrl'),
    ocrAiModel: document.getElementById('ocrAiModel'),
    ocrRapidOcr: document.getElementById('ocrRapidOcr'),
    ocrOpenAiVision: document.getElementById('ocrOpenAiVision'),
    ocrOpenAiFallbackOnly: document.getElementById('ocrOpenAiFallbackOnly'),
    ocrOpenAiModel: document.getElementById('ocrOpenAiModel'),
    ocrOpenAiFallbackModel: document.getElementById('ocrOpenAiFallbackModel'),
    ocrOpenAiDetail: document.getElementById('ocrOpenAiDetail')
  };

  const SETTINGS_KEY = 'question_bank_image_ocr_settings_v2';
  const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';
  const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
  const OCR_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  const state = {
    libPromise: null,
    worker: null,
    workerLang: '',
    parsing: false,
    lastLog: ''
  };

  const _origDatasetKey = appContext.datasetKey;
  appContext.datasetKey = function(d){
    if (d && d.__uid) return `${(d.origin)||'mhtml'}::${d.__uid}`;
    return _origDatasetKey(d);
  };

  const _origParseOne = appContext.parseOne;
  appContext.parseOne = async function(i){
    const d = appContext.datasets[i];
    if (d && d.origin === 'image') return await ScreenshotOCR.parseDatasetIndex(i, { force: true });
    return _origParseOne(i);
  };

  const _origRenderQuestions = appContext.renderQuestions;
  appContext.renderQuestions = function(d){
    _origRenderQuestions(d);
    ScreenshotOCR.decorateQuestionCards(d);
  };

  const _origUpdateActiveUI = appContext.updateActiveUI;
  appContext.updateActiveUI = function(){
    _origUpdateActiveUI();
    ScreenshotOCR.updateButtons();
  };

  const _origRenderFileTable = appContext.renderFileTable;
  appContext.renderFileTable = function(){
    _origRenderFileTable();
    ScreenshotOCR.decorateFileTable();
  };

  const ScreenshotOCR = {
    init(){
      this.loadSettings();
      this.bindEvents();
      this.updateButtons();
      this.setStatus('');
    },

    bindEvents(){
      if (refs.imgFile){
        refs.imgFile.addEventListener('change', () => {
          const files = Array.from(refs.imgFile.files || []);
          if (files.length) this.appendFiles(files, 'picker');
          refs.imgFile.value = '';
        });
      }

      if (refs.ocrImagesBtn){
        refs.ocrImagesBtn.addEventListener('click', async () => {
          await this.parseAllImages({ onlyPending: true });
        });
      }

      if (refs.ocrActiveBtn){
        refs.ocrActiveBtn.addEventListener('click', async () => {
          const d = appContext.datasets[appContext.activeIdx];
          if (!d || d.origin !== 'image') return;
          await this.parseDatasetIndex(appContext.activeIdx, { force: true });
          appContext.renderFileTable();
          appContext.updateActiveUI();
        });
      }

      if (refs.imgDropZone){
        const prevent = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };
        ['dragenter','dragover'].forEach(type => {
          refs.imgDropZone.addEventListener(type, (e) => {
            prevent(e);
            refs.imgDropZone.classList.add('dragover');
          });
        });
        ['dragleave','dragend','drop'].forEach(type => {
          refs.imgDropZone.addEventListener(type, (e) => {
            prevent(e);
            refs.imgDropZone.classList.remove('dragover');
          });
        });
        refs.imgDropZone.addEventListener('drop', (e) => {
          const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => this.isImageFile(f));
          if (files.length) this.appendFiles(files, 'drop');
        });
      }

      document.addEventListener('paste', (e) => {
        const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
        const files = [];
        items.forEach((item, idx) => {
          if (!item || item.kind !== 'file') return;
          const file = item.getAsFile && item.getAsFile();
          if (!file || !this.isImageFile(file)) return;
          const named = new File([file], file.name && file.name !== 'image.png' ? file.name : this.makeClipboardName(idx, file.type), { type: file.type || 'image/png', lastModified: Date.now() });
          files.push(named);
        });
        if (files.length){
          this.appendFiles(files, 'paste');
          this.setStatus(`已从剪贴板加入 ${files.length} 张截图`, false);
        }
      });

      [
        refs.ocrLang,
        refs.ocrPreferColor,
        refs.ocrDebug,
        refs.ocrAiRepair,
        refs.ocrAiBaseUrl,
        refs.ocrAiModel,
        refs.ocrRapidOcr,
        refs.ocrOpenAiVision,
        refs.ocrOpenAiFallbackOnly,
        refs.ocrOpenAiModel,
        refs.ocrOpenAiFallbackModel,
        refs.ocrOpenAiDetail
      ].forEach(el => {
        if (!el) return;
        el.addEventListener('change', () => {
          this.saveSettings();
        });
      });
      [refs.ocrAiBaseUrl, refs.ocrAiModel, refs.ocrOpenAiModel, refs.ocrOpenAiFallbackModel].forEach(el => {
        if (!el) return;
        el.addEventListener('input', () => {
          this.saveSettings();
        });
      });
    },

    loadSettings(){
      try{
        let raw = {};
        const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.getPrototypeOf(parsed) === Object.prototype){
          raw = parsed;
        }
        if (refs.ocrLang && raw.lang) refs.ocrLang.value = String(raw.lang);
        if (refs.ocrPreferColor) refs.ocrPreferColor.checked = raw.preferColor !== false;
        if (refs.ocrDebug) refs.ocrDebug.checked = !!raw.debug;
        if (refs.ocrAiRepair) refs.ocrAiRepair.checked = !!raw.aiRepair;
        if (refs.ocrAiBaseUrl) refs.ocrAiBaseUrl.value = raw.aiBaseUrl || DEFAULT_DEEPSEEK_BASE_URL;
        if (refs.ocrAiModel) refs.ocrAiModel.value = raw.aiModel || DEFAULT_DEEPSEEK_MODEL;
        if (refs.ocrRapidOcr) refs.ocrRapidOcr.checked = !!raw.rapidOcr;
        if (refs.ocrOpenAiVision) refs.ocrOpenAiVision.checked = !!raw.openAiVision;
        if (refs.ocrOpenAiFallbackOnly) refs.ocrOpenAiFallbackOnly.checked = raw.openAiFallbackOnly !== false;
        if (refs.ocrOpenAiModel) refs.ocrOpenAiModel.value = raw.openAiModel || DEFAULT_OPENAI_VISION_MODEL;
        if (refs.ocrOpenAiFallbackModel) refs.ocrOpenAiFallbackModel.value = raw.openAiFallbackModel || DEFAULT_OPENAI_VISION_FALLBACK_MODEL;
        if (refs.ocrOpenAiDetail) refs.ocrOpenAiDetail.value = raw.openAiDetail || DEFAULT_OPENAI_VISION_DETAIL;
      }catch(_e){}
    },

    saveSettings(){
      try{
        const settings = this.getSettings();
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          lang: settings.lang,
          preferColor: settings.preferColor,
          debug: settings.debug,
          aiRepair: settings.aiRepair,
          aiBaseUrl: settings.aiBaseUrl,
          aiModel: settings.aiModel,
          rapidOcr: settings.rapidOcr,
          openAiVision: settings.openAiVision,
          openAiFallbackOnly: settings.openAiFallbackOnly,
          openAiModel: settings.openAiModel,
          openAiFallbackModel: settings.openAiFallbackModel,
          openAiDetail: settings.openAiDetail
        }));
      }catch(_e){}
    },

    getSettings(){
      return {
        lang: (refs.ocrLang && refs.ocrLang.value ? refs.ocrLang.value.trim() : '') || 'eng',
        preferColor: !!(refs.ocrPreferColor && refs.ocrPreferColor.checked),
        debug: !!(refs.ocrDebug && refs.ocrDebug.checked),
        aiRepair: !!(refs.ocrAiRepair && refs.ocrAiRepair.checked),
        aiApiKey: (refs.ocrAiApiKey && refs.ocrAiApiKey.value ? refs.ocrAiApiKey.value.trim() : ''),
        aiBaseUrl: (refs.ocrAiBaseUrl && refs.ocrAiBaseUrl.value ? refs.ocrAiBaseUrl.value.trim() : '') || DEFAULT_DEEPSEEK_BASE_URL,
        aiModel: (refs.ocrAiModel && refs.ocrAiModel.value ? refs.ocrAiModel.value.trim() : '') || DEFAULT_DEEPSEEK_MODEL,
        rapidOcr: !!(refs.ocrRapidOcr && refs.ocrRapidOcr.checked),
        openAiVision: !!(refs.ocrOpenAiVision && refs.ocrOpenAiVision.checked),
        openAiFallbackOnly: !!(refs.ocrOpenAiFallbackOnly && refs.ocrOpenAiFallbackOnly.checked),
        openAiModel: (refs.ocrOpenAiModel && refs.ocrOpenAiModel.value ? refs.ocrOpenAiModel.value.trim() : '') || DEFAULT_OPENAI_VISION_MODEL,
        openAiFallbackModel: (refs.ocrOpenAiFallbackModel && refs.ocrOpenAiFallbackModel.value ? refs.ocrOpenAiFallbackModel.value.trim() : '') || DEFAULT_OPENAI_VISION_FALLBACK_MODEL,
        openAiDetail: (refs.ocrOpenAiDetail && refs.ocrOpenAiDetail.value ? refs.ocrOpenAiDetail.value.trim() : '') || DEFAULT_OPENAI_VISION_DETAIL,
        openAiReasoningEffort: DEFAULT_OPENAI_VISION_REASONING
      };
    },

    updateButtons(){
      const hasImage = appContext.datasets.some(d => d && d.origin === 'image');
      const active = appContext.datasets[appContext.activeIdx];
      if (refs.ocrImagesBtn) refs.ocrImagesBtn.disabled = !hasImage || state.parsing;
      if (refs.ocrActiveBtn) refs.ocrActiveBtn.disabled = !(active && active.origin === 'image') || state.parsing;
      const pending = appContext.datasets.filter(d => d && d.origin === 'image' && (!d.parsedReady || d.err)).length;
      if (hasImage && !state.parsing && refs.imgStatus && !refs.imgStatus.textContent){
        refs.imgStatus.textContent = pending ? `待识别截图 ${pending} 个` : '截图已全部识别';
      }
    },

    setStatus(msg, warn){
      if (!refs.imgStatus) return;
      refs.imgStatus.textContent = msg || '';
      refs.imgStatus.style.color = warn ? '#b91c1c' : '';
    },

    decorateFileTable(){
      const d = appContext.datasets[appContext.activeIdx];
      void d;
    },

    decorateQuestionCards(d){
      if (!d || d.origin !== 'image' || !d.parsedReady) return;
      const cards = Array.from(appContext.list.querySelectorAll('.card'));
      d.parsed.forEach((q, idx) => {
        const card = cards[idx];
        if (!card || !q || !q.ocrMeta) return;
        if (card.querySelector('.ocr-debug')) return;
        const details = document.createElement('details');
        details.className = 'ocr-debug';
        const scores = Array.isArray(q.ocrMeta.greenScores)
          ? q.ocrMeta.greenScores.map((v, i) => `${String.fromCharCode(65 + i)}=${this.round(v)}`).join('，')
          : '';
        const redScores = Array.isArray(q.ocrMeta.redScores)
          ? q.ocrMeta.redScores.map((v, i) => `${String.fromCharCode(65 + i)}=${this.round(v)}`).join('，')
          : '';
        const debugLines = [];
        if (q.ocrMeta.questionKind) debugLines.push(`kind: ${q.ocrMeta.questionKind}`);
        if (scores) debugLines.push(`greenScores: ${scores}`);
        if (redScores) debugLines.push(`redScores: ${redScores}`);
        if (Number.isFinite(q.ocrMeta.greenThreshold)) debugLines.push(`greenThreshold: ${this.round(q.ocrMeta.greenThreshold)}`);
        if (Number.isFinite(q.ocrMeta.splitX)) debugLines.push(`splitX: ${Math.round(q.ocrMeta.splitX)}`);
        if (q.ocrMeta.localRepairApplied) {
          debugLines.push(`localRepair:\n${JSON.stringify({ before: q.ocrMeta.localRepairBefore, after: q.ocrMeta.localRepairAfter }, null, 2)}`);
        }
        if (q.ocrMeta.aiRepairUsed) debugLines.push(`aiRepair: used${q.ocrMeta.aiRepairModel ? ` (${q.ocrMeta.aiRepairModel})` : ''}`);
        if (q.ocrMeta.aiRepairError) debugLines.push(`aiRepairError: ${q.ocrMeta.aiRepairError}`);
        if (q.ocrMeta.rapidOcrUsed) debugLines.push(`rapidOcr: used${q.ocrMeta.rapidOcrModel ? ` (${q.ocrMeta.rapidOcrModel})` : ''}`);
        if (Number.isFinite(q.ocrMeta.rapidOcrLineCount) || Number.isFinite(q.ocrMeta.rapidOcrWordCount)) {
          debugLines.push(`rapidOcrCounts: lines=${Number.isFinite(q.ocrMeta.rapidOcrLineCount) ? q.ocrMeta.rapidOcrLineCount : '?'} words=${Number.isFinite(q.ocrMeta.rapidOcrWordCount) ? q.ocrMeta.rapidOcrWordCount : '?'}`);
        }
        if (Array.isArray(q.ocrMeta.rapidOcrLineText) && q.ocrMeta.rapidOcrLineText.length) {
          debugLines.push(`rapidOcrLineText:\n${q.ocrMeta.rapidOcrLineText.join('\n')}`);
        }
        if (Array.isArray(q.ocrMeta.rapidOcrWordText) && q.ocrMeta.rapidOcrWordText.length) {
          debugLines.push(`rapidOcrWordText:\n${q.ocrMeta.rapidOcrWordText.join(' | ')}`);
        }
        if (q.ocrMeta.rapidOcrError) debugLines.push(`rapidOcrError: ${q.ocrMeta.rapidOcrError}`);
        if (q.ocrMeta.aiVisionUsed) debugLines.push(`openAiVision: used (${q.ocrMeta.aiVisionModel || 'model unknown'}) confidence=${this.round(q.ocrMeta.aiVisionConfidence)}`);
        if (q.ocrMeta.aiVisionError) debugLines.push(`openAiVisionError: ${q.ocrMeta.aiVisionError}`);
        if (Array.isArray(q.ocrMeta.aiVisionReviewReasons) && q.ocrMeta.aiVisionReviewReasons.length) {
          debugLines.push(`openAiVisionReview: ${q.ocrMeta.aiVisionReviewReasons.join('；')}`);
        }
        if (q.ocrMeta.rawText) debugLines.push(`rawText:\n${q.ocrMeta.rawText}`);
        details.innerHTML = `<summary>OCR 调试信息</summary><pre>${appContext.escapeHTML(debugLines.join('\n\n'))}</pre>`;
        card.appendChild(details);
      });
    },

    isImageFile(file){
      if (!file) return false;
      return /^image\//i.test(String(file.type || '')) || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(String(file.name || ''));
    },

    sanitizeSimpleName(name){
      return String(name || '')
        .replace(/\.[^.]+$/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    },

    makeClipboardName(idx, type){
      const ext = /jpe?g/i.test(type || '') ? 'jpg' : /webp/i.test(type || '') ? 'webp' : 'png';
      return `clipboard_${new Date().toISOString().replace(/[:.]/g, '-')}_${idx + 1}.${ext}`;
    },

    makeUid(){
      return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    },

    guessMeta(fileName){
      const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
      const fallback = { prefix: 'screenshot', sourcePrefix: 'Screenshot' };
      if (!base) return fallback;
      if (/^[0-9a-f-]{16,}$/i.test(base) || /^clipboard[_-]/i.test(base)) return fallback;
      const guessed = appContext.guessMetaFromFilename(fileName || '');
      const simple = this.sanitizeSimpleName(base);
      const prefix = guessed && guessed.prefix && !/^[0-9a-f-]{16,}$/i.test(guessed.prefix) ? guessed.prefix : (simple || fallback.prefix);
      const sourcePrefix = guessed && guessed.sourcePrefix ? guessed.sourcePrefix : `Screenshot_${simple || 'image'}`;
      return { prefix, sourcePrefix };
    },

    makeDataset(file, source){
      const meta = this.guessMeta(file && file.name);
      return {
        __uid: this.makeUid(),
        origin: 'image',
        file,
        name: `[截图] ${file && file.name ? file.name : 'clipboard.png'}`,
        prefix: meta.prefix,
        sourcePrefix: meta.sourcePrefix,
        parsed: [],
        parsedReady: false,
        parsing: false,
        err: '',
        imageSource: source || 'picker'
      };
    },

    appendFiles(files, source){
      const clean = Array.from(files || []).filter(f => this.isImageFile(f));
      if (!clean.length) return;
      const items = clean.map(file => this.makeDataset(file, source));
      appContext.upsertDatasets(items, { keepActive: false });
      appContext.renderFileTable();
      appContext.updateActiveUI();
      document.getElementById('parseAllBtn').disabled = appContext.datasets.length === 0;
      document.getElementById('parseActiveBtn').disabled = appContext.datasets.length === 0;
      this.updateButtons();
      this.setStatus(`已加入 ${clean.length} 张截图，等待识别`, false);
    },

    async parseAllImages(opts){
      const onlyPending = !!(opts && opts.onlyPending);
      const targets = appContext.datasets
        .map((d, idx) => ({ d, idx }))
        .filter(({ d }) => d && d.origin === 'image')
        .filter(({ d }) => !onlyPending || !d.parsedReady || !!d.err);

      if (!targets.length){
        this.setStatus('没有需要识别的截图', false);
        return;
      }

      state.parsing = true;
      this.updateButtons();
      let done = 0;
      let failed = 0;
      try{
        for (const item of targets){
          await this.parseDatasetIndex(item.idx, { force: true, progressPrefix: `截图 ${done + 1}/${targets.length}` });
          if (appContext.datasets[item.idx] && appContext.datasets[item.idx].err) failed += 1;
          done += 1;
        }
      } finally {
        state.parsing = false;
        this.updateButtons();
      }

      appContext.renderFileTable();
      appContext.updateActiveUI();
      const ok = done - failed;
      this.setStatus(`截图识别完成：${ok}/${done} 成功`, failed > 0);
      appContext.setTopStatus(`截图识别完成：${ok}/${done} 成功`, failed > 0);
    },

    async parseDatasetIndex(i, opts){
      const d = appContext.datasets[i];
      if (!d || d.origin !== 'image') return;
      if (d.parsing) return;
      if (d.parsedReady && !(opts && opts.force)) return;

      d.parsing = true;
      d.err = '';
      appContext.renderFileTable();

      try{
        const settings = this.getSettings();
        const dataUrl = await this.fileToDataURL(d.file);

        if (settings.openAiVision && !settings.openAiFallbackOnly) {
          try {
            d.parsed = await this.recognizeWithOpenAiVision(dataUrl, settings, { fallback: false });
            d.parsedReady = true;
            return d;
          } catch (visionError) {
            this.setStatus(`OpenAI Vision 失败，回退本地 OCR：${String(visionError && visionError.message ? visionError.message : visionError).slice(0, 120)}`, true);
          }
        }

        const imageInfo = await this.loadImageAndCanvas(dataUrl);
        let parsed = null;
        let rapidOcrError = null;
        if (settings.rapidOcr) {
          try {
            const rapidRecognition = await this.recognizeWithRapidOcr(dataUrl);
            parsed = await this.parseRecognizedScreenshot(rapidRecognition && rapidRecognition.data ? rapidRecognition.data : {}, imageInfo, dataUrl, settings, d, rapidRecognition);
          } catch (error) {
            rapidOcrError = error;
            this.setStatus(`RapidOCR 失败，回退浏览器 OCR：${String(error && error.message ? error.message : error).slice(0, 120)}`, true);
          }
        }
        if (!parsed) {
          const worker = await this.ensureWorker(settings);
          const recognition = await this.recognizeBest(worker, imageInfo, settings);
          parsed = await this.parseRecognizedScreenshot(recognition && recognition.data ? recognition.data : {}, imageInfo, dataUrl, settings, d, recognition);
          if (rapidOcrError) parsed = this.annotateRapidOcrError(parsed, rapidOcrError);
        }
        if (settings.openAiVision && settings.openAiFallbackOnly && shouldUseOpenAiVisionFallback(parsed)) {
          try {
            parsed = await this.recognizeWithOpenAiVision(dataUrl, settings, { fallback: true });
          } catch (visionError) {
            parsed = this.annotateOpenAiVisionError(parsed, visionError);
          }
        }
        d.parsed = parsed;
        d.parsedReady = true;
      } catch (e){
        d.err = String(e && e.message ? e.message : e);
        d.parsedReady = false;
      } finally {
        d.parsing = false;
      }

      appContext.renderFileTable();
      if (i === appContext.activeIdx) appContext.updateActiveUI();
      return d;
    },

    async recognizeWithRapidOcr(dataUrl){
      this.setStatus('RapidOCR PP-OCRv5 正在本地识别截图…', false);
      const res = await fetch('/api/local/rapidocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: dataUrl })
      });
      if (!res.ok){
        const text = await res.text().catch(() => '');
        throw new Error(`RapidOCR proxy error ${res.status}: ${text.slice(0, 220)}`);
      }
      const body = await res.json();
      if (!body || !body.data) throw new Error('RapidOCR proxy returned no OCR data');
      return {
        data: body.data,
        rapidOcr: true,
        engine: body.engine || 'rapidocr',
        model: body.model || '',
        variant: body.model || 'rapidocr-ppocrv5'
      };
    },

    async recognizeWithOpenAiVision(dataUrl, settings, opts){
      const fallback = !!(opts && opts.fallback);
      const model = fallback
        ? (settings.openAiFallbackModel || DEFAULT_OPENAI_VISION_FALLBACK_MODEL)
        : (settings.openAiModel || DEFAULT_OPENAI_VISION_MODEL);
      this.setStatus(`OpenAI Vision 正在识别截图（${model}）…`, false);
      const res = await fetch('/api/openai/vision-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageDataUrl: dataUrl,
          model,
          detail: settings.openAiDetail || DEFAULT_OPENAI_VISION_DETAIL,
          reasoningEffort: settings.openAiReasoningEffort || DEFAULT_OPENAI_VISION_REASONING
        })
      });
      if (!res.ok){
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI Vision proxy error ${res.status}: ${text.slice(0, 220)}`);
      }
      const body = await res.json();
      if (!body || !body.extraction) throw new Error('OpenAI Vision proxy returned no extraction');
      const parsed = openAiVisionExtractionToParsedQuestion(body.extraction, {
        dataUrl,
        debug: settings.debug,
        model: body.model || model
      });
      return [parsed];
    },

    annotateOpenAiVisionError(parsed, error){
      const message = String(error && error.message ? error.message : error).slice(0, 300);
      return (Array.isArray(parsed) ? parsed : []).map(q => ({
        ...q,
        ocrMeta: {
          ...(q && q.ocrMeta || {}),
          aiVisionUsed: false,
          aiVisionError: message
        }
      }));
    },

    annotateRapidOcrError(parsed, error){
      const message = String(error && error.message ? error.message : error).slice(0, 300);
      return (Array.isArray(parsed) ? parsed : []).map(q => ({
        ...q,
        ocrMeta: {
          ...(q && q.ocrMeta || {}),
          rapidOcrUsed: false,
          rapidOcrError: message
        }
      }));
    },

    async ensureLib(){
      if (window.Tesseract) return window.Tesseract;
      if (state.libPromise) return state.libPromise;
      state.libPromise = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = OCR_SCRIPT_SRC;
        el.async = true;
        el.onload = () => resolve(window.Tesseract);
        el.onerror = () => reject(new Error('无法加载 Tesseract.js'));
        document.head.appendChild(el);
      });
      return state.libPromise;
    },

    async ensureWorker(settings){
      await this.ensureLib();
      const lang = (settings && settings.lang) || 'eng';
      if (state.worker && state.workerLang === lang) return state.worker;
      if (state.worker){
        try{ await state.worker.terminate(); }catch(_e){}
        state.worker = null;
        state.workerLang = '';
      }
      this.setStatus('正在初始化 OCR 引擎…', false);
      state.worker = await window.Tesseract.createWorker(lang, 1, {
        logger: (msg) => {
          if (!msg || !msg.status) return;
          const pct = typeof msg.progress === 'number' ? ` ${Math.round(msg.progress * 100)}%` : '';
          state.lastLog = `${msg.status}${pct}`;
          this.setStatus(`OCR：${state.lastLog}`, false);
        }
      });
      state.workerLang = lang;
      try{
        if (state.worker && state.worker.setParameters){
          await state.worker.setParameters({
            preserve_interword_spaces: '1',
            tessedit_pageseg_mode: '6'
          });
        }
      }catch(_e){}
      return state.worker;
    },

    async fileToDataURL(file){
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取截图失败'));
        reader.readAsDataURL(file);
      });
    },

    async loadImageAndCanvas(dataUrl){
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('无法载入截图'));
        image.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width || 1;
      canvas.height = img.naturalHeight || img.height || 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return {
        img,
        canvas,
        ctx,
        width: canvas.width,
        height: canvas.height
      };
    },

    buildBinaryOcrCanvas(canvas){
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const img = ctx.getImageData(0, 0, out.width, out.height);
      const data = img.data;
      for (let i = 0; i < data.length; i += 4){
        const v = ocrBinaryPixelValue(data[i], data[i + 1], data[i + 2]);
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return out;
    },

    buildOcrVariants(imageInfo){
      const variants = [{ label: 'color', canvas: imageInfo.canvas }];
      try{
        variants.push({ label: 'binary', canvas: this.buildBinaryOcrCanvas(imageInfo.canvas) });
      }catch(_e){}
      return variants;
    },

    async runRecognizePass(worker, canvas, psm){
      if (worker && worker.setParameters){
        try{
          await worker.setParameters({
            preserve_interword_spaces: '1',
            tessedit_pageseg_mode: String(psm || 6)
          });
        }catch(_e){}
      }
      const result = await worker.recognize(canvas);
      return result && result.data ? result.data : {};
    },

    scoreRecognitionData(data){
      const words = this.normalizeWords(data);
      const lines = this.normalizeLines(data, words);
      const rawText = this.normalizeMultiline((data && data.text) || '');
      const tokenCount = rawText ? rawText.split(/\s+/).filter(Boolean).length : 0;
      const choiceLike = lines.filter(line => /^(?:[A-H]|[1-9][0-9]?)\s*[\)\.、:：-]\s*/i.test(String(line.text || '').trim()) || /^[0-9][0-9,\.]+\s*$/.test(String(line.text || '').trim())).length;
      const longLines = lines.filter(line => String(line.text || '').trim().length >= 3).length;
      return longLines * 12 + tokenCount + choiceLike * 8;
    },

    async recognizeBest(worker, imageInfo, settings){
      const variants = this.buildOcrVariants(imageInfo);
      const psms = [6, 11, 4];
      let best = null;
      for (const variant of variants){
        for (const psm of psms){
          let data = null;
          try{
            data = await this.runRecognizePass(worker, variant.canvas, psm);
          }catch(_e){
            continue;
          }
          const score = this.scoreRecognitionData(data);
          if (!best || score > best.score){
            best = { data, score, psm, variant: variant.label };
          }
        }
      }
      return best || { data: {} };
    },

    async parseRecognizedScreenshot(data, imageInfo, dataUrl, settings, dataset, recognition){
      const words = this.normalizeWords(data);
      const lines = this.normalizeLines(data, words);
      const blocks = this.groupLines(lines);
      const rows = this.groupRowsFromWords(words);
      const rawText = this.normalizeMultiline((data && data.text) || blocks.map(b => b.text).join('\n'));
      const questionTextFallback = blocks.length ? this.normalizeMultiline(blocks[0].text) : rawText;

      let parsed = this.tryParseMatching(blocks, rows, imageInfo, settings);
      if (!parsed) parsed = this.tryParseChoice(blocks, rows, imageInfo, settings);
      if ((!parsed || parsed.kind !== 'choice' || (parsed.choices || []).length < 3) && rawText){
        const rawLines = rawText.split(/\n+/).map(line => this.normalizeText(line)).filter(Boolean);
        const optionLines = rawLines.filter((line, idx) => idx > 0 && this.looksLikeChoiceLine(line));
        if (optionLines.length >= 2){
          let questionText = this.normalizeMultiline(rawLines.slice(0, Math.max(1, rawLines.length - optionLines.length)).join('\n')) || questionTextFallback || rawText;
          const normalizedOptions = optionLines.map(line => this.stripChoicePrefix(line) || line).filter(Boolean);
          const tail = this.extractTrailingOptionFromQuestion(questionText, normalizedOptions);
          const finalOptions = tail ? [tail.optionText].concat(normalizedOptions) : normalizedOptions;
          if (tail) questionText = tail.questionText;
          parsed = {
            kind: 'choice',
            qtext: questionText || questionTextFallback || rawText,
            isMulti: false,
            choices: finalOptions.map(line => ({ text: line, isCorrect: false })),
            ocrMeta: { questionKind: 'choice-rawtext', rawText, blockCount: blocks.length, recoveredLeadingOption: !!tail }
          };
        }
      }
      if (!parsed) parsed = this.tryParseFill(blocks, questionTextFallback);
      if (!parsed){
        const fallbackChoices = blocks.slice(1).map(b => ({
          text: this.stripChoicePrefix(this.normalizeMultiline(b.text)) || this.normalizeMultiline(b.text),
          isCorrect: false
        })).filter(c => c.text);
        if (fallbackChoices.length >= 2){
          parsed = {
            kind: 'choice',
            qtext: questionTextFallback || rawText || '(OCR 未提取出题干)',
            isMulti: false,
            choices: fallbackChoices,
            ocrMeta: { questionKind: 'choice-fallback', rawText, blockCount: blocks.length }
          };
        } else {
          const blankCount = Math.max(1, this.inferBlankCount(questionTextFallback || rawText));
          parsed = {
            kind: 'fill',
            qtext: questionTextFallback || rawText || '(OCR 未提取出题干)',
            blanks: Array.from({ length: blankCount }, () => []),
            qhtml: this.buildFillQuestionHTML(questionTextFallback || rawText, blankCount),
            ocrMeta: { questionKind: 'fill-fallback', rawText, blockCount: blocks.length }
          };
        }
      }
      parsed = this.applyLocalOcrTextRepair(parsed, rawText);
      parsed = await this.maybeRepairWithDeepSeek(parsed, settings);

      const common = {
        num: 1,
        idSuffix: '1',
        sourceNum: '1',
        // 原截图通常带有正确答案高亮，不应进入预览题面或导出题库。
        // 仅保留为内部 OCR 调试来源，不参与 getQuestionImages()/导出 image 字段。
        ocrSourceImage: dataUrl,
        images: [],
        uploadedImages: [],
        expectedImageCount: 0,
        missingImageCount: 0,
        missingImageSources: [],
        importedId: '',
        importedSource: '',
        preserveOriginalMeta: false,
        ocrText: rawText
      };

      const metaBase = Object.assign({}, parsed.ocrMeta || {}, settings && settings.debug ? {
        rawText,
        lineCount: lines.length,
        blockCount: blocks.length,
        psm: recognition && recognition.psm,
        variant: recognition && recognition.variant
      } : {}, buildRapidOcrDebugMeta(recognition));

      if (parsed.kind === 'choice'){
        return [{
          ...common,
          kind: 'choice',
          isMulti: !!parsed.isMulti,
          qtext: parsed.qtext || questionTextFallback || rawText || '(OCR 未提取出题干)',
          choices: parsed.choices || [],
          scoreInfo: null,
          answerDerivedFromScore: false,
          ocrMeta: metaBase
        }];
      }

      if (parsed.kind === 'matching'){
        return [{
          ...common,
          kind: 'matching',
          qtext: parsed.qtext || questionTextFallback || rawText || '(OCR 未提取出题干)',
          pairs: parsed.pairs || [],
          choicePool: parsed.choicePool || [],
          scoreInfo: null,
          ocrMeta: metaBase
        }];
      }

      return [{
        ...common,
        kind: 'fill',
        qtext: parsed.qtext || questionTextFallback || rawText || '(OCR 未提取出题干)',
        blanks: parsed.blanks || [[]],
        qhtml: parsed.qhtml || this.buildFillQuestionHTML(parsed.qtext || questionTextFallback || rawText, (parsed.blanks || [[]]).length),
        scoreInfo: null,
        answerDerivedFromScore: false,
        ocrMeta: metaBase
      }];
    },

    normalizeWords(data){
      const src = Array.isArray(data && data.words) ? data.words : [];
      return src.map(word => {
        const bbox = this.readBBox(word && (word.bbox || word));
        const text = this.normalizeText(word && (word.text || word.symbol || ''));
        const confRaw = Number(word && (word.confidence != null ? word.confidence : word.conf));
        if (!bbox || !text) return null;
        return {
          text,
          bbox,
          conf: Number.isFinite(confRaw) ? confRaw : 0,
          forceSpaceBefore: !!(word && word.forceSpaceBefore)
        };
      }).filter(Boolean);
    },

    normalizeLines(data, words){
      const src = Array.isArray(data && data.lines) ? data.lines : [];
      const lines = src.map(line => {
        const bbox = this.readBBox(line && (line.bbox || line));
        const text = this.normalizeMultiline(line && line.text || '');
        const confRaw = Number(line && (line.confidence != null ? line.confidence : line.conf));
        if (!bbox || !text) return null;
        return {
          text,
          bbox,
          conf: Number.isFinite(confRaw) ? confRaw : 0
        };
      }).filter(Boolean);
      if (lines.length) return lines.sort((a, b) => a.bbox.y0 === b.bbox.y0 ? a.bbox.x0 - b.bbox.x0 : a.bbox.y0 - b.bbox.y0);

      const fromWords = this.groupRowsFromWords(words).map(row => ({
        text: row.text,
        bbox: row.bbox,
        conf: row.conf
      }));
      if (fromWords.length) return fromWords;

      const fromHocr = this.parseHocrLines(data && data.hocr);
      if (fromHocr.length) return fromHocr;

      return [];
    },

    parseHocrLines(hocr){
      if (!hocr) return [];
      try{
        const doc = new DOMParser().parseFromString(String(hocr), 'text/html');
        const nodes = Array.from(doc.querySelectorAll('.ocr_line, .ocrx_line'));
        return nodes.map(node => {
          const bbox = this.readHocrBBox(node.getAttribute('title') || '');
          const text = this.normalizeMultiline(node.textContent || '');
          if (!bbox || !text) return null;
          return { text, bbox, conf: 0 };
        }).filter(Boolean).sort((a, b) => a.bbox.y0 === b.bbox.y0 ? a.bbox.x0 - b.bbox.x0 : a.bbox.y0 - b.bbox.y0);
      }catch(_e){
        return [];
      }
    },

    readHocrBBox(title){
      const m = String(title || '').match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i);
      if (!m) return null;
      return this.readBBox({ x0: Number(m[1]), y0: Number(m[2]), x1: Number(m[3]), y1: Number(m[4]) });
    },

    groupRowsFromWords(words){
      const clean = Array.from(words || []);
      if (!clean.length) return [];
      const sorted = clean.slice().sort((a, b) => a.bbox.cy === b.bbox.cy ? a.bbox.x0 - b.bbox.x0 : a.bbox.cy - b.bbox.cy);
      const heights = sorted.map(w => w.bbox.h).filter(Boolean).sort((a, b) => a - b);
      const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 16;
      const threshold = Math.max(8, medianH * 0.65);
      const rows = [];

      sorted.forEach(word => {
        let row = rows[rows.length - 1];
        if (!row || Math.abs(word.bbox.cy - row.cy) > threshold){
          rows.push({
            words: [word],
            y0: word.bbox.y0,
            y1: word.bbox.y1,
            cy: word.bbox.cy
          });
          return;
        }
        row.words.push(word);
        row.y0 = Math.min(row.y0, word.bbox.y0);
        row.y1 = Math.max(row.y1, word.bbox.y1);
        row.cy = (row.y0 + row.y1) / 2;
      });

      return rows.map(row => {
        const ws = row.words.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
        const bbox = this.unionBBoxes(ws.map(w => w.bbox));
        const confs = ws.map(w => w.conf).filter(v => Number.isFinite(v));
        let text = '';
        let prev = null;
        ws.forEach(w => {
          if (prev){
            const gap = w.bbox.x0 - prev.x1;
            text += w.forceSpaceBefore || gap > Math.max(6, prev.h * 0.35) ? ' ' : '';
          }
          text += w.text;
          prev = w.bbox;
        });
        return {
          words: ws,
          bbox,
          text: this.normalizeText(text),
          conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0
        };
      }).filter(row => row.text);
    },

    groupLines(lines){
      const clean = Array.from(lines || []);
      if (!clean.length) return [];
      const sorted = clean.slice().sort((a, b) => a.bbox.y0 === b.bbox.y0 ? a.bbox.x0 - b.bbox.x0 : a.bbox.y0 - b.bbox.y0);
      const heights = sorted.map(line => line.bbox.h).filter(Boolean).sort((a, b) => a - b);
      const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 18;
      const gapThreshold = Math.max(12, medianH * 0.85);
      const blocks = [];

      sorted.forEach(line => {
        const last = blocks[blocks.length - 1];
        const prevLine = last && last.lines[last.lines.length - 1];
        const gap = prevLine ? (line.bbox.y0 - prevLine.bbox.y1) : Infinity;
        if (!last || gap > gapThreshold){
          blocks.push({ lines: [line] });
          return;
        }
        last.lines.push(line);
      });

      return blocks.map((block, idx) => {
        const bbox = this.unionBBoxes(block.lines.map(line => line.bbox));
        return {
          index: idx,
          bbox,
          text: this.normalizeMultiline(block.lines.map(line => line.text).join('\n')),
          lines: block.lines
        };
      }).filter(block => block.text);
    },

    tryParseChoice(blocks, rows, imageInfo, settings){
      if (!Array.isArray(blocks) || !blocks.length) return null;
      const labelRe = /^\s*(?:[A-H]|[1-9][0-9]?)\s*[\)\.、\:：-]\s*/i;
      const cleanRows = Array.isArray(rows) ? rows.filter(row => this.normalizeText(row && row.text)) : [];
      let questionBlocks = [blocks[0]];
      let optionBlocks = blocks.slice(1).filter(block => this.normalizeText(block.text));
      let questionText = this.normalizeMultiline(questionBlocks.map(block => block.text).join('\n'));

      const labeledStart = blocks.findIndex((block, idx) => idx > 0 && labelRe.test(this.normalizeText(block.text)));
      if (labeledStart > 0){
        questionBlocks = blocks.slice(0, labeledStart);
        optionBlocks = blocks.slice(labeledStart).filter(block => this.normalizeText(block.text));
        questionText = this.normalizeMultiline(questionBlocks.map(block => block.text).join('\n'));
      } else {
        const trailing = this.findTrailingChoiceRows(cleanRows, imageInfo);
        if (trailing && trailing.optionRows.length >= 2){
          questionText = this.normalizeMultiline(trailing.questionRows.map(row => row.text).join('\n')) || questionText;
          optionBlocks = trailing.optionRows.map(row => ({
            text: row.text,
            bbox: row.bbox,
            lines: [row],
            fromRows: true
          }));
        }
      }

      optionBlocks = optionBlocks.filter(block => this.normalizeText(block.text));
      if (optionBlocks.length < 2) return null;

      let optionEntries = optionBlocks.map(block => ({
        text: this.stripChoicePrefix(this.normalizeMultiline(block.text)) || this.normalizeMultiline(block.text),
        bbox: block.bbox,
        rawText: this.normalizeMultiline(block.text)
      })).filter(entry => entry.text);

      const recovered = this.extractTrailingOptionFromQuestion(questionText, optionEntries.map(entry => entry.text));
      if (recovered){
        questionText = recovered.questionText;
        const sourceBBox = questionBlocks.length ? questionBlocks[questionBlocks.length - 1].bbox : (optionEntries[0] && optionEntries[0].bbox);
        optionEntries.unshift({
          text: recovered.optionText,
          bbox: sourceBBox,
          rawText: recovered.optionText,
          recovered: true
        });
      }

      if (optionEntries.length < 2) return null;

      const colorInfo = settings && settings.preferColor
        ? this.detectChoiceAnswersByColor(optionEntries.map(entry => ({ text: entry.rawText || entry.text, bbox: entry.bbox })), imageInfo)
        : { greenScores: [], redScores: [], greenThreshold: 0, answers: [] };

      const choices = optionEntries.map((entry, idx) => ({
        text: entry.text,
        isCorrect: Array.isArray(colorInfo.answers) ? colorInfo.answers.includes(idx) : false
      }));

      return {
        kind: 'choice',
        qtext: questionText || this.normalizeMultiline(blocks[0].text),
        isMulti: Array.isArray(colorInfo.answers) && colorInfo.answers.length > 1,
        choices,
        ocrMeta: {
          questionKind: 'choice',
          greenScores: colorInfo.greenScores || [],
          redScores: colorInfo.redScores || [],
          greenThreshold: colorInfo.greenThreshold,
          recoveredLeadingOption: !!recovered,
          blocks: settings && settings.debug ? optionEntries.map(entry => ({
            text: entry.rawText || entry.text,
            bbox: this.serializeBBox(entry.bbox),
            recovered: !!entry.recovered
          })) : undefined
        }
      };
    },

    applyLocalOcrTextRepair(parsed, rawText){
      if (!parsed) return parsed;
      const before = {
        question: this.normalizeText(parsed.qtext || ''),
        choices: Array.isArray(parsed.choices) ? parsed.choices.map(choice => this.normalizeText(choice && choice.text)) : []
      };
      let next = parsed;
      if (parsed.kind === 'choice'){
        next = {
          ...parsed,
          qtext: repairOcrQuestionText(parsed.qtext) || parsed.qtext,
          choices: (parsed.choices || []).map(choice => ({
            ...choice,
            text: repairOcrChoiceText(choice && choice.text) || (choice && choice.text) || ''
          }))
        };
      } else if (parsed.kind === 'matching'){
        next = {
          ...parsed,
          qtext: repairOcrQuestionText(parsed.qtext) || parsed.qtext
        };
      }

      const after = {
        question: this.normalizeText(next.qtext || ''),
        choices: Array.isArray(next.choices) ? next.choices.map(choice => this.normalizeText(choice && choice.text)) : []
      };
      const changed = before.question !== after.question || before.choices.join('\u0001') !== after.choices.join('\u0001');
      return {
        ...next,
        ocrMeta: {
          ...(next.ocrMeta || {}),
          rawTextForRepair: this.normalizeMultiline(rawText || ''),
          localRepairApplied: changed,
          localRepairBefore: changed ? before : undefined,
          localRepairAfter: changed ? after : undefined
        }
      };
    },

    async maybeRepairWithDeepSeek(parsed, settings){
      if (!parsed || parsed.kind !== 'choice' || !(settings && settings.aiRepair)) return parsed;
      if (!settings.aiApiKey){
        return {
          ...parsed,
          ocrMeta: {
            ...(parsed.ocrMeta || {}),
            aiRepairUsed: false,
            aiRepairError: 'missing-api-key'
          }
        };
      }
      try{
        this.setStatus('DeepSeek 正在二次修复 OCR 文本…', false);
        const payload = buildDeepSeekOcrRepairPayload(parsed, { model: settings.aiModel || DEFAULT_DEEPSEEK_MODEL });
        const respJson = await this.callDeepSeekOcrRepair(settings.aiBaseUrl || DEFAULT_DEEPSEEK_BASE_URL, settings.aiApiKey, payload);
        const repair = parseDeepSeekOcrRepairResponse(respJson, (parsed.choices || []).length);
        const repaired = applyDeepSeekOcrRepair(parsed, repair);
        return {
          ...repaired,
          ocrMeta: {
            ...(repaired.ocrMeta || {}),
            aiRepairUsed: true,
            aiRepairModel: settings.aiModel || DEFAULT_DEEPSEEK_MODEL
          }
        };
      } catch (e){
        return {
          ...parsed,
          ocrMeta: {
            ...(parsed.ocrMeta || {}),
            aiRepairUsed: false,
            aiRepairError: String(e && e.message ? e.message : e).slice(0, 300)
          }
        };
      }
    },

    async callDeepSeekOcrRepair(baseUrl, apiKey, payload){
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      const res = await fetch(baseUrl || DEFAULT_DEEPSEEK_BASE_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      if (!res.ok){
        const text = await res.text().catch(() => '');
        throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    },

    tryParseFill(blocks, questionText){
      const qtext = this.normalizeMultiline(questionText || (blocks && blocks[0] ? blocks[0].text : ''));
      if (!qtext) return null;
      const blankCount = this.inferBlankCount(qtext);
      if (!blankCount) return null;
      return {
        kind: 'fill',
        qtext,
        blanks: Array.from({ length: blankCount }, () => []),
        qhtml: this.buildFillQuestionHTML(qtext, blankCount),
        ocrMeta: {
          questionKind: 'fill'
        }
      };
    },

    tryParseMatching(blocks, rows, imageInfo, settings){
      const allRows = Array.isArray(rows) ? rows : [];
      const allBlocks = Array.isArray(blocks) ? blocks : [];
      if (!allRows.length || !allBlocks.length) return null;
      const questionBlock = allBlocks[0];
      const questionText = this.normalizeMultiline(questionBlock.text);
      const dataRows = allRows.filter(row => row.bbox.y0 >= questionBlock.bbox.y1 - 2);
      if (dataRows.length < 2) return null;

      const splitX = this.detectColumnSplit(dataRows, imageInfo.width);
      if (!Number.isFinite(splitX)) return null;

      const pairs = [];
      dataRows.forEach(row => {
        const leftWords = row.words.filter(word => word.bbox.cx < splitX);
        const rightWords = row.words.filter(word => word.bbox.cx >= splitX);
        const left = this.joinWords(leftWords);
        const right = this.joinWords(rightWords);
        if (left && right) pairs.push({ left, right });
      });

      const hint = /(match|matching|配对|对应)/i.test(questionText);
      if (pairs.length < 2) return null;
      if (!hint && pairs.length < 3) return null;

      return {
        kind: 'matching',
        qtext: questionText,
        pairs,
        choicePool: uniqueNonEmptyStrings(pairs.map(pair => pair.right)),
        ocrMeta: {
          questionKind: 'matching',
          splitX
        }
      };
    },

    detectColumnSplit(rows, imageWidth){
      const splits = [];
      rows.forEach(row => {
        const ws = (row.words || []).slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
        if (ws.length < 2) return;
        let bestGap = 0;
        let bestMid = NaN;
        for (let i = 0; i < ws.length - 1; i++){
          const gap = ws[i + 1].bbox.x0 - ws[i].bbox.x1;
          if (gap > bestGap){
            bestGap = gap;
            bestMid = ws[i].bbox.x1 + gap / 2;
          }
        }
        if (bestGap > Math.max(40, imageWidth * 0.12) && Number.isFinite(bestMid)){
          splits.push(bestMid);
        }
      });
      if (!splits.length) return NaN;
      const sorted = splits.sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },

    detectChoiceAnswersByColor(optionBlocks, imageInfo){
      const greenScores = [];
      const redScores = [];
      optionBlocks.forEach(block => {
        const rect = this.expandRectToFullWidth(block.bbox, imageInfo.width, imageInfo.height);
        const scores = this.measureHighlight(imageInfo.ctx, rect);
        greenScores.push(scores.green);
        redScores.push(scores.red);
      });

      const maxGreen = greenScores.length ? Math.max.apply(null, greenScores) : 0;
      const threshold = Math.max(0.012, maxGreen * 0.45);
      const answers = greenScores
        .map((score, idx) => ({ score, idx }))
        .filter(item => item.score >= threshold && item.score > 0)
        .map(item => item.idx);

      return {
        greenScores,
        redScores,
        greenThreshold: threshold,
        answers
      };
    },

    expandRectToFullWidth(bbox, imageWidth, imageHeight){
      const padY = Math.max(8, bbox.h * 0.45);
      const y = Math.max(0, Math.floor(bbox.y0 - padY));
      const y1 = Math.min(imageHeight, Math.ceil(bbox.y1 + padY));
      return {
        x: 0,
        y,
        w: imageWidth,
        h: Math.max(1, y1 - y)
      };
    },

    measureHighlight(ctx, rect){
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      const w = Math.max(1, Math.floor(rect.w));
      const h = Math.max(1, Math.floor(rect.h));
      const data = ctx.getImageData(x, y, w, h).data;
      let total = 0;
      let green = 0;
      let red = 0;
      const step = 4;

      for (let yy = 0; yy < h; yy += step){
        for (let xx = 0; xx < w; xx += step){
          const idx = (yy * w + xx) * 4;
          const a = data[idx + 3];
          if (a < 200) continue;
          const rgb = [data[idx], data[idx + 1], data[idx + 2]];
          const hsv = this.rgbToHsv(rgb[0], rgb[1], rgb[2]);
          total += 1;
          if (hsv[0] >= 80 && hsv[0] <= 170 && hsv[1] >= 0.10 && hsv[2] >= 0.55) green += 1;
          if ((hsv[0] <= 20 || hsv[0] >= 340) && hsv[1] >= 0.10 && hsv[2] >= 0.45) red += 1;
        }
      }

      return {
        green: total ? green / total : 0,
        red: total ? red / total : 0
      };
    },

    rgbToHsv(r, g, b){
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      let h = 0;
      if (d !== 0){
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      const s = max === 0 ? 0 : d / max;
      const v = max;
      return [h, s, v];
    },

    inferBlankCount(text){
      const s = String(text || '');
      const underlineCount = (s.match(/_{3,}/g) || []).length;
      const bracketCount = (s.match(/[\(\（]\s*[\)\）]/g) || []).length;
      return underlineCount + bracketCount;
    },

    buildFillQuestionHTML(text, blankCount){
      const total = Math.max(1, Number(blankCount || 1));
      let idx = 0;
      const inputFor = () => {
        idx += 1;
        return `<input class="qb-blank" data-blank="${idx}" disabled placeholder="Type…">`;
      };

      let html = appContext.escapeHTML(String(text || '').trim());
      html = html.replace(/_{3,}/g, () => inputFor());
      html = html.replace(/[\(\（]\s*[\)\）]/g, () => inputFor());
      while (idx < total){
        html += ` ${inputFor()}`;
      }
      return html;
    },

    stripChoicePrefix(text){
      let s = String(text || '').trim();
      s = s.replace(/^\s*[\(（]?([A-H])[\)）\.、\:：-]\s*/i, '');
      s = s.replace(/^\s*[\(（]?([1-9][0-9]?)\s*[\)）、\:：-]\s*/, '');
      s = s.replace(/^\s*([1-9][0-9]?)\.(?=\s)/, '');
      return s.trim();
    },

    looksLikeChoiceLine(text){
      const s = this.normalizeText(text);
      if (!s) return false;
      if (/^\s*[A-H][\)\.、\:：-]\s+/i.test(s)) return true;
      if (/^\s*[1-9][0-9]?\s*[\)）、\:：-]\s+/.test(s)) return true;
      if (/^\s*[1-9][0-9]?\.(?=\s)/.test(s)) return true;
      if (/^\s*(?:\d+[\d,]*\.\d+|\d+[\d,]*|\d+\/\d+)\s+\S+/.test(s)) return true;
      return false;
    },

    extractTrailingOptionFromQuestion(text, existingOptionTexts){
      const normalized = this.normalizeMultiline(text);
      if (!normalized) return null;
      const parts = normalized.split(/(?<=[\.\!\?。])\s+/).map(part => this.normalizeText(part)).filter(Boolean);
      if (parts.length < 2) return null;
      const optionText = parts[parts.length - 1];
      const questionText = this.normalizeMultiline(parts.slice(0, -1).join(' '));
      if (!questionText || !optionText || optionText.length > 90) return null;
      if (!this.looksLikeChoiceLine(optionText)){
        const tails = (existingOptionTexts || []).map(line => this.normalizeText(line).split(/\s+/).slice(-1)[0]).filter(Boolean);
        const myTail = this.normalizeText(optionText).split(/\s+/).slice(-1)[0];
        if (!myTail || !tails.length || !tails.some(t => t === myTail)) return null;
      }
      return { questionText, optionText };
    },

    findTrailingChoiceRows(rows, imageInfo){
      return findUnlabeledChoiceRowSplit(rows, {
        imageWidth: imageInfo && imageInfo.width
      });
    },

    joinWords(words){
      const ws = Array.from(words || []).sort((a, b) => a.bbox.x0 - b.bbox.x0);
      let out = '';
      let prev = null;
      ws.forEach(word => {
        if (prev){
          const gap = word.bbox.x0 - prev.x1;
          out += word.forceSpaceBefore || gap > Math.max(6, prev.h * 0.35) ? ' ' : '';
        }
        out += word.text;
        prev = word.bbox;
      });
      return this.normalizeText(out);
    },

    readBBox(raw){
      if (!raw) return null;
      let x0 = Number(raw.x0 != null ? raw.x0 : (raw.left != null ? raw.left : raw.x));
      let y0 = Number(raw.y0 != null ? raw.y0 : (raw.top != null ? raw.top : raw.y));
      let x1 = Number(raw.x1 != null ? raw.x1 : (raw.right != null ? raw.right : (raw.x != null && raw.width != null ? Number(raw.x) + Number(raw.width) : NaN)));
      let y1 = Number(raw.y1 != null ? raw.y1 : (raw.bottom != null ? raw.bottom : (raw.y != null && raw.height != null ? Number(raw.y) + Number(raw.height) : NaN)));
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
      if (x1 < x0){ const t = x0; x0 = x1; x1 = t; }
      if (y1 < y0){ const t = y0; y0 = y1; y1 = t; }
      return {
        x0, y0, x1, y1,
        w: Math.max(0, x1 - x0),
        h: Math.max(0, y1 - y0),
        cx: (x0 + x1) / 2,
        cy: (y0 + y1) / 2
      };
    },

    unionBBoxes(boxes){
      const clean = Array.from(boxes || []).filter(Boolean);
      if (!clean.length) return this.readBBox({ x0: 0, y0: 0, x1: 0, y1: 0 });
      const x0 = Math.min.apply(null, clean.map(b => b.x0));
      const y0 = Math.min.apply(null, clean.map(b => b.y0));
      const x1 = Math.max.apply(null, clean.map(b => b.x1));
      const y1 = Math.max.apply(null, clean.map(b => b.y1));
      return this.readBBox({ x0, y0, x1, y1 });
    },

    serializeBBox(bbox){
      if (!bbox) return null;
      return {
        x0: Math.round(bbox.x0),
        y0: Math.round(bbox.y0),
        x1: Math.round(bbox.x1),
        y1: Math.round(bbox.y1)
      };
    },

    normalizeText(value){
      return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    },

    normalizeMultiline(value){
      return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    round(num){
      return Math.round(Number(num || 0) * 1000) / 1000;
    }
  };

  window.ScreenshotOCRApp = ScreenshotOCR;
ScreenshotOCR.init();
appContext.renderFileTable();
appContext.updateActiveUI();
}
