import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const PAGE_SIZE = 1000;
const MAX_PAGES = 1000;
const FETCH_TIMEOUT_MS = 15000;

function cloudflareToken() {
  const explicit = process.env.CLOUDFLARE_API_TOKEN;
  if (explicit) return explicit;
  const candidates = process.platform === 'darwin'
    ? [join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'), join(homedir(), '.wrangler/config/default.toml')]
    : [join(homedir(), '.wrangler/config/default.toml')];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      const match = text.match(/^oauth_token\s*=\s*"([^"]+)"\s*$/m);
      if (match?.[1]) return match[1];
    } catch { /* Try the next known Wrangler credential location. */ }
  }
  throw new Error('CLOUDFLARE_AUTH_UNAVAILABLE');
}

function safeAccountId(value = process.env.CLOUDFLARE_ACCOUNT_ID) {
  if (typeof value !== 'string' || !ACCOUNT_ID_PATTERN.test(value)) throw new Error('CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  return value;
}

function safeFailure() { throw new Error('CLOUDFLARE_METADATA_UNAVAILABLE'); }

function createClient({ accountId, token, fetchImpl = globalThis.fetch }) {
  const acct = safeAccountId(accountId);
  if (typeof token !== 'string' || token.length < 8 || typeof fetchImpl !== 'function') throw new Error('CLOUDFLARE_AUTH_UNAVAILABLE');

  async function request(method, path, { query = {}, body: requestBody } = {}) {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        method, headers: { authorization: `Bearer ${token}`, accept: 'application/json',
          ...(requestBody === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response?.ok) safeFailure();
      const body = await response.json();
      if (!body || body.success !== true) safeFailure();
      return body;
    } catch (error) {
      if (error?.message === 'CLOUDFLARE_METADATA_UNAVAILABLE') throw error;
      safeFailure();
    }
  }

  async function get(path, query = {}) {
    const body = await request('GET', path, { query });
    if (!Array.isArray(body.result)) safeFailure();
    return body;
  }

  async function listKVNamespaces() {
    const namespaces = [];
    const ids = new Set();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await get(`/accounts/${acct}/storage/kv/namespaces`, { page, per_page: 100 });
      for (const raw of body.result) {
        if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{32}$/i.test(raw.id)
          || typeof raw.title !== 'string' || raw.title.length > 512) safeFailure();
        if (ids.has(raw.id)) safeFailure();
        ids.add(raw.id);
        namespaces.push({ id: raw.id, title: raw.title });
      }
      const info = body.result_info || {};
      if (Number.isSafeInteger(info.total_count) && Number.isSafeInteger(info.per_page) && info.per_page > 0) {
        if (page * info.per_page >= info.total_count) return { namespaces };
      } else if (body.result.length < 100) return { namespaces };
    }
    safeFailure();
  }

  async function createKVNamespace({ title } = {}) {
    if (typeof title !== 'string' || title.length < 1 || title.length > 512) throw new Error('INVALID_KV_NAMESPACE_TITLE');
    const before = await listKVNamespaces();
    const existing = before.namespaces.filter(namespace => namespace.title === title);
    if (existing.length > 1) throw new Error('KV_NAMESPACE_TITLE_AMBIGUOUS');
    if (existing.length === 1) return { id: existing[0].id, title, created: false };
    const createdBody = await request('POST', `/accounts/${acct}/storage/kv/namespaces`, { body: { title } });
    const raw = createdBody.result;
    if (!raw || typeof raw.id !== 'string' || !/^[a-f0-9]{32}$/i.test(raw.id) || raw.title !== title) safeFailure();
    const after = await listKVNamespaces();
    const matches = after.namespaces.filter(namespace => namespace.title === title);
    if (matches.length !== 1 || matches[0].id !== raw.id) safeFailure();
    return { id: raw.id, title, created: true };
  }

  async function listPages(path, initialQuery, readPage) {
    const values = [];
    let cursor = null;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = { ...initialQuery, ...(cursor ? { cursor } : {}) };
      const body = await get(path, query);
      for (const raw of body.result) values.push(readPage(raw));
      const next = body.result_info?.cursor;
      if (!next) return values;
      if (typeof next !== 'string' || next.length > 2048 || seenCursors.has(next)) safeFailure();
      seenCursors.add(next);
      cursor = next;
    }
    safeFailure();
  }

  async function listDurableObjectNamespaces({ scriptName } = {}) {
    if (typeof scriptName !== 'string' || !/^[a-z0-9-]{1,64}$/.test(scriptName)) throw new Error('INVALID_SCRIPT_NAME');
    const namespaces = [];
    const namespaceIds = new Set();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await get(`/accounts/${acct}/workers/durable_objects/namespaces`, { per_page: 50, page });
      for (const raw of body.result) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.class !== 'string'
          || typeof raw.script !== 'string' || typeof raw.use_sqlite !== 'boolean') safeFailure();
        if (namespaceIds.has(raw.id)) safeFailure();
        namespaceIds.add(raw.id);
        namespaces.push({ namespaceId: raw.id, className: raw.class, scriptName: raw.script, useSqlite: raw.use_sqlite });
      }
      const totalPages = body.result_info?.total_pages;
      if (Number.isSafeInteger(totalPages) && totalPages >= 0) {
        if (page >= totalPages) break;
      } else if (body.result.length < 50) break;
      if (page === MAX_PAGES) safeFailure();
    }
    return { namespaces: namespaces.filter(item => item.scriptName === scriptName) };
  }

  async function listDurableObjects({ scriptName, className } = {}) {
    if (typeof className !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(className)) throw new Error('INVALID_CLASS_NAME');
    const { namespaces } = await listDurableObjectNamespaces({ scriptName });
    const selected = namespaces.filter(item => item.className === className);
    if (selected.length === 0) throw new Error('DO_NAMESPACE_NOT_CONFIGURED');
    if (selected.length !== 1) throw new Error('DO_NAMESPACE_AMBIGUOUS');
    if (!selected[0].useSqlite) throw new Error('DO_NAMESPACE_NOT_SQLITE');
    const objects = [];
    for (const namespace of selected) {
      const records = await listPages(`/accounts/${acct}/workers/durable_objects/namespaces/${encodeURIComponent(namespace.namespaceId)}/objects`, { limit: PAGE_SIZE }, raw => {
        if (!raw || typeof raw.id !== 'string' || typeof raw.hasStoredData !== 'boolean') safeFailure();
        return { id: raw.id, hasStoredData: raw.hasStoredData };
      });
      const ids = new Set();
      for (const record of records) {
        if (ids.has(record.id)) safeFailure();
        ids.add(record.id);
      }
      objects.push(...records.map(record => ({ ...record, namespaceId: namespace.namespaceId, className })));
    }
    return { objects };
  }

  async function listKVKeys({ namespaceId, prefix = '' } = {}) {
    if (typeof namespaceId !== 'string' || !/^[a-f0-9]{32}$/i.test(namespaceId)
      || typeof prefix !== 'string' || prefix.length > 512) throw new Error('INVALID_KV_LIST_REQUEST');
    const keys = await listPages(`/accounts/${acct}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/keys`,
      { limit: PAGE_SIZE, ...(prefix ? { prefix } : {}) }, raw => {
        if (!raw || typeof raw.name !== 'string' || raw.name.length > 512) safeFailure();
        let metadata = null;
        if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
          && Object.keys(raw.metadata).every(key => key === 'h' || key === 'b')
          && Object.values(raw.metadata).every(value => Number.isSafeInteger(value) && value >= 0)) {
          metadata = { ...(Number.isSafeInteger(raw.metadata.h) ? { h: raw.metadata.h } : {}),
            ...(Number.isSafeInteger(raw.metadata.b) ? { b: raw.metadata.b } : {}) };
        }
        return { name: raw.name, metadata };
      });
    const names = new Set();
    for (const key of keys) {
      if (names.has(key.name)) safeFailure();
      names.add(key.name);
    }
    return { keys };
  }

  return Object.freeze({ listDurableObjectNamespaces, listDurableObjects, listKVKeys, listKVNamespaces, createKVNamespace });
}

export function createCloudflareMetadataClient(options = {}) {
  return createClient({ accountId: options.accountId, token: options.token ?? cloudflareToken(), fetchImpl: options.fetchImpl });
}

export async function listDurableObjectNamespaces(args) {
  return createCloudflareMetadataClient().listDurableObjectNamespaces(args);
}

export async function listDurableObjects(args) {
  return createCloudflareMetadataClient().listDurableObjects(args);
}

export async function listKVKeys({ accountId, ...args } = {}) {
  return createCloudflareMetadataClient({ accountId }).listKVKeys(args);
}

export async function listKVNamespaces({ accountId } = {}) {
  return createCloudflareMetadataClient({ accountId }).listKVNamespaces();
}

export async function createKVNamespace({ accountId, ...args } = {}) {
  return createCloudflareMetadataClient({ accountId }).createKVNamespace(args);
}
