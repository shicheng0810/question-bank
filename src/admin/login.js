(() => {
  'use strict';

  const form = document.getElementById('login-form');
  const credentialInput = document.getElementById('credential');
  const loginButton = document.getElementById('login-button');
  const logoutButton = document.getElementById('logout-button');
  const refreshButton = document.getElementById('refresh-button');
  const adminShellLink = document.getElementById('admin-shell-link');
  const statusNode = document.getElementById('status');
  const expiryNode = document.getElementById('expiry');
  let csrfToken = null;
  let busy = false;
  let operation = 0;

  function setStatus(message, kind = '') {
    statusNode.textContent = message;
    statusNode.dataset.kind = kind;
  }

  function setBusy(value) {
    busy = value;
    loginButton.disabled = value;
    credentialInput.disabled = value;
    logoutButton.disabled = value;
    refreshButton.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
        credentials: 'same-origin',
        cache: 'no-store',
        mode: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
      if (options.onHeaders) options.onHeaders();
      const payload = await readJson(response);
      return { status: response.status, ok: response.ok, payload };
    } finally {
      window.clearTimeout(timer);
    }
  }

  function responseMessage(status) {
    if (status === 401) return '凭据无效或管理员会话已失效。';
    if (status === 429) return '尝试次数过多，请稍后再试。';
    if (status === 503) return '管理员服务暂不可用，请稍后再试。';
    return '请求未完成，请稍后重试。';
  }

  async function readJson(response) {
    const type = response.headers.get('content-type') || '';
    if (!type.toLowerCase().includes('application/json')) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function clearSessionView(clearCsrf = true) {
    if (clearCsrf) csrfToken = null;
    expiryNode.hidden = true;
    expiryNode.textContent = '';
    logoutButton.hidden = true;
    adminShellLink.hidden = true;
  }

  function validSession(value) {
    return value !== null
      && typeof value === 'object'
      && value.ok === true
      && isCsrf(value.csrf)
      && validExpiry(value.expiresAt);
  }

  function isCsrf(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
  }

  function validExpiry(value) {
    return Number.isSafeInteger(value)
      && value > Date.now()
      && value <= Date.now() + 8 * 60 * 60 * 1000
      && value <= 8640000000000000;
  }

  function formatExpiry(epochMs) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(epochMs));
    } catch {
      return '时间不可用';
    }
  }

  async function refreshSession(preserveCsrf = false, operationId = ++operation) {
    clearSessionView(!preserveCsrf);
    setStatus('正在检查管理员会话…');
    try {
      const response = await request('/api/admin/session');
      if (operationId !== operation) return false;
      const payload = response.payload;
      if (response.status === 401) {
        clearSessionView();
        setStatus('当前没有有效的管理员会话。');
        return false;
      }
      if (!response.ok) {
        clearSessionView();
        setStatus(responseMessage(response.status), 'error');
        return false;
      }
      if (!validSession(payload)) {
        clearSessionView();
        setStatus('服务器返回的会话状态无法验证。', 'error');
        return false;
      }
      csrfToken = payload.csrf;
      expiryNode.textContent = `会话到期时间：${formatExpiry(payload.expiresAt)}`;
      expiryNode.hidden = false;
      logoutButton.hidden = !csrfToken;
      adminShellLink.hidden = !csrfToken;
      setStatus(csrfToken
        ? '管理员会话有效。此页面尚未连接任何内容提取功能。'
        : '管理员会话有效；重新登录后可在此页面注销。', 'success');
      return true;
    } catch (error) {
      if (operationId !== operation) return false;
      clearSessionView();
      setStatus(error && error.name === 'AbortError'
        ? '检查会话超时，请重试。'
        : '无法连接管理员服务，请稍后重试。', 'error');
      return false;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    let credential = credentialInput.value;
    credentialInput.value = '';
    clearSessionView();
    if (!credential) {
      setStatus('请输入管理员凭据。', 'error');
      return;
    }

    setBusy(true);
    const operationId = ++operation;
    setStatus('正在登录…');
    try {
      const response = await request('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
        onHeaders: () => { credential = null; },
      });
      credential = null;
      if (operationId !== operation) return;
      if (!response.ok) {
        setStatus(responseMessage(response.status), 'error');
        return;
      }
      const payload = response.payload;
      if (!payload || payload.ok !== true
        || !isCsrf(payload.csrf) || !validExpiry(payload.expiresAt)) {
        setStatus('服务器未确认登录状态，请检查会话后重试。', 'error');
        return;
      }
      csrfToken = payload.csrf;
      await refreshSession(true, operationId);
    } catch (error) {
      if (operationId !== operation) return;
      setStatus(error && error.name === 'AbortError'
        ? '登录请求超时，请检查会话状态后重试。'
        : '无法连接管理员服务，请稍后重试。', 'error');
    } finally {
      credential = null;
      credentialInput.value = '';
      setBusy(false);
    }
  });

  logoutButton.addEventListener('click', async () => {
    if (busy || !csrfToken) return;
    const token = csrfToken;
    const operationId = ++operation;
    setBusy(true);
    setStatus('正在注销当前会话…');
    try {
      const response = await request('/api/admin/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-QB-Admin-CSRF': token },
        body: '{}',
      });
      if (operationId !== operation) return;
      if (!response.ok) {
        setStatus(`${responseMessage(response.status)} 可检查会话或重试注销。`, 'error');
        return;
      }
      if (!response.payload || response.payload.ok !== true) {
        setStatus('服务器未确认注销结果。可检查会话或重试注销。', 'error');
        return;
      }
      clearSessionView();
      setStatus('当前管理员会话已注销。', 'success');
    } catch (error) {
      if (operationId !== operation) return;
      setStatus(error && error.name === 'AbortError'
        ? '注销请求超时，结果未知。可检查会话或重试注销。'
        : '注销结果未知。请检查会话或重试注销。', 'error');
    } finally {
      setBusy(false);
    }
  });

  refreshButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await refreshSession(true);
    } finally {
      setBusy(false);
    }
  });

  const initialOperation = ++operation;
  setBusy(true);
  void refreshSession(false, initialOperation).finally(() => {
    if (initialOperation === operation) setBusy(false);
  });
})();
