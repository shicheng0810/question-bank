// 提取器「发布到站点」的本地桥（仅 dev 模式，127.0.0.1）：
//   GET  /api/local/publish-bank        → 当前 public/banks/index.json（前端用来查重/提示覆盖）
//   POST /api/local/publish-bank        → {questions,id,title,description,tags,mode,password,target}
//       校验+写库+登记（publish-bank-core），target=all|cf|gh 时同步执行部署并回传日志尾部。
// 浏览器无法写文件/跑 wrangler，所以由 dev server 代办——与 OCR 代理同一模式。
import {
  publishBankToRepo, readBankManifest, runDeploy, SITE_URLS,
  removeBankFromRepo, archiveBankInRepo, convertBankInRepo, moveBankInRepo, readBankContent,
} from './publish-bank-core.js';
import { listUsers, deleteUser, deleteUsers, codeToSub, attachUserListAfterAction } from './users-admin-core.js';
import { listSpecialBanks, createSpecialBank, deleteSpecialBank } from './special-banks-core.js';

function readJsonBody(req, limitBytes = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function extractDeployError(e) {
  const raw = String((e && e.stderr) || (e && e.message) || e);
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = lines.find((l) => /^Error[:：]/.test(l)) || lines[lines.length - 1] || raw;
  return errLine.slice(0, 300);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function createLocalPublishVitePlugin({ getRoot } = {}) {
  return {
    name: 'local-publish-bank-proxy',
    configureServer(server) {
      server.middlewares.use('/api/local/publish-bank', async (req, res) => {
        const root = (getRoot && getRoot()) || process.cwd();
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, manifest: readBankManifest(root) });
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const body = await readJsonBody(req);
          const target = ['all', 'cf', 'gh', 'preview', 'none'].includes(body.target) ? body.target : 'none';
          const result = await publishBankToRepo({
            root,
            questions: body.questions,
            id: body.id,
            title: body.title,
            description: body.description,
            tags: body.tags,
            mode: body.mode === 'protected' ? 'protected' : 'public',
            password: body.password || '',
          });
          let deploy = { deployed: false, target: 'none' };
          let deployError = '';
          if (target !== 'none') {
            try {
              deploy = runDeploy(root, target, { capture: true });
              if (deploy.output) deploy.output = deploy.output.split('\n').slice(-8).join('\n');
            } catch (e) {
              deployError = extractDeployError(e);
            }
          }
          sendJson(res, 200, {
            ok: true,
            ...result,
            rejected: undefined, // 详单太大，不回传；数量在 rejectedCount
            deploy,
            deployError,
            urls: {
              // 只有部署到正式站（all/cf/gh）才回传对应的正式站链接；preview 走 preview 分支、
              // 没有稳定的正式链接，不回传（否则会误报成已上线正式站）。
              ...(deploy.deployed && (target === 'all' || target === 'cf') ? { cf: `${SITE_URLS.cf}/player.html?bank=${result.id}` } : {}),
              ...(deploy.deployed && (target === 'all' || target === 'gh') ? { gh: `${SITE_URLS.gh}/player.html?bank=${result.id}` } : {}),
            },
          });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
      });

      // 站点题库管理：下架/恢复/彻底删除/公开⇄加密转换/部署
      server.middlewares.use('/api/local/bank-admin', async (req, res) => {
        const root = (getRoot && getRoot()) || process.cwd();
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const body = await readJsonBody(req, 1024 * 1024);
          const action = String(body.action || '');
          let result = {};
          if (action === 'move') {
            result = moveBankInRepo({ root, id: String(body.id || ''), delta: Number(body.delta) || 0 });
          } else if (action === 'unlist' || action === 'restore' || action === 'delete') {
            result = removeBankFromRepo({ root, id: String(body.id || ''), mode: action });
          } else if (action === 'archive' || action === 'unarchive') {
            result = archiveBankInRepo({ root, id: String(body.id || ''), mode: action });
          } else if (action === 'convert') {
            result = await convertBankInRepo({
              root,
              id: String(body.id || ''),
              password: body.password || '',
              newPassword: body.newPassword || '',
            });
          } else if (action === 'read') {
            // 读回某库完整题目（站主编辑用）；加密库需 password 解密
            result = await readBankContent({ root, id: String(body.id || ''), password: body.password || '' });
          } else if (action === 'deploy') {
            const target = ['all', 'cf', 'gh', 'preview'].includes(body.target) ? body.target : 'all';
            const deploy = runDeploy(root, target, { capture: true, allowEmpty: !!body.allowEmpty });
            if (deploy.output) deploy.output = deploy.output.split('\n').slice(-6).join('\n');
            result = { deploy };
          } else {
            throw new Error(`未知 action: ${action}`);
          }
          sendJson(res, 200, { ok: true, ...result, manifest: readBankManifest(root) });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: extractDeployError(e), manifest: readBankManifest(root) });
        }
      });

      // 用户后台（站主本地专用）：只读Cloudflare元数据并通过受限MigrationOperator删除
      server.middlewares.use('/api/local/users', async (req, res) => {
        try {
          if (req.method === 'GET') {
            try {
              const includeLegacy = new URL(req.url || '/', 'http://localhost').searchParams.get('includeLegacy') === '1';
              sendJson(res, 200, { ok: true, users: await listUsers({ includeLegacy }) });
            } catch (e) {
              sendJson(res, 503, { ok: false, error: String((e && e.message) || 'CENSUS_UNAVAILABLE') });
            }
            return;
          }
          if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
          const body = await readJsonBody(req, 256 * 1024);
          const action = String(body.action || '');
          let result = {};
          if (action === 'delete') {
            result = await deleteUser(String(body.sub || ''));
          } else if (action === 'delete-by-code') {
            const code = String(body.code || '').trim();
            if (!code) throw new Error('缺少 code');
            result = await deleteUser(codeToSub(code));
          } else if (action === 'delete-many') {
            const subs = Array.isArray(body.subs) ? body.subs : [];
            if (!subs.length) throw new Error('没有选中用户');
            result = await deleteUsers(subs);
          } else {
            throw new Error(`未知 action: ${action}`);
          }
          // Deletion and the follow-up census are independent. Never disguise
          // a completed delete as failed just because refresh failed.
          const withRefresh = await attachUserListAfterAction(result);
          sendJson(res, 200, { ok: true, ...withRefresh });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
      });

      // 特殊题库（站主本地专用）：列出 / 新建（设分享码）/ 删除
      server.middlewares.use('/api/local/special-banks', async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, banks: listSpecialBanks() });
            return;
          }
          if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
          const body = await readJsonBody(req, 120 * 1024 * 1024); // 题库可能含图片
          const action = String(body.action || '');
          let result = {};
          if (action === 'create') {
            result = createSpecialBank({ title: body.title, questions: body.questions, shareCode: body.shareCode });
          } else if (action === 'delete') {
            result = deleteSpecialBank(String(body.id || ''));
          } else {
            throw new Error(`未知 action: ${action}`);
          }
          sendJson(res, 200, { ok: true, ...result, banks: listSpecialBanks() });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
      });
    },
  };
}
