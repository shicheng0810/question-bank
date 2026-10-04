import '../styles/site.css';
import '../styles/extractor.css';
import shellHtml from '../app/shell.html?raw';
import { init as initExtractorCore } from '../app/core.js';
import { init as initScreenshotOcr } from '../app/features/screenshot-ocr.js';

const app = document.getElementById('app');

if (!app) {
  throw new Error('Missing #app mount point');
}

app.innerHTML = shellHtml;

initExtractorCore();
initScreenshotOcr();
