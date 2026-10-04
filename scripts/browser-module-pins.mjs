import { createHash } from 'node:crypto';
export function pinBrowserModuleReferences(html, modules) {
  return html.replace(/((?:\.\/)?browser\/([A-Za-z0-9_-]+\.js))(?:\?v=[0-9a-f]{64})?/g, (full, url, file) => {
    const bytes = modules.get(file);
    if (!bytes) throw new Error('MISSING_BROWSER_MODULE');
    return url + '?v=' + createHash('sha256').update(bytes).digest('hex');
  });
}
