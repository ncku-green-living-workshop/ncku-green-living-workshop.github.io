'use strict';
/**
 * 文案編輯器的本機伺服器。零 npm 依賴，只用 Node 內建模組。
 *
 *   node scripts/editor.js        → http://127.0.0.1:4321
 *
 * 只綁 127.0.0.1，並檢查 Host／Origin／每次啟動的隨機 token（見 guard()），
 * 防止其他分頁的網頁跨站寫入或推送。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { parse, applyEdits, readIndex, writeIndex, ROOT } = require('./editor-parse');

const PORT = Number(process.env.PORT) || 4321;
const PENDING = path.join(ROOT, '.editor-pending.json');

const git = (args, opts = {}) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd: ROOT, maxBuffer: 8 << 20, ...opts },
    (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout));
});

const readPending = () => {
  try { return JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return []; }
};

// --- handlers --------------------------------------------------------------

function getContent() {
  const c = parse(readIndex());
  return { ...c, pending: readPending().length };
}

/**
 * 寫回編輯。body: { prose:{id:{zh,en}}, meta:{id:text}, alts:{id:{zh,en}}, mono:{id:text} }
 * 只送有改動的欄位。中文有變動的散文會進待翻清單。
 */
function save(body) {
  const src = readIndex();
  const c = parse(src);
  const edits = [];
  const newlyPending = [];

  for (const p of c.prose) {
    const v = body.prose?.[p.id];
    if (!v) continue;
    if (v.zh !== undefined && v.zh !== p.zh) {
      edits.push({ span: p.zhSpan, value: v.zh });
      newlyPending.push({
        id: p.id, section: p.section,
        zh_old: p.zh, zh_new: v.zh, en_current: p.en,
      });
    }
    if (v.en !== undefined && v.en !== p.en) edits.push({ span: p.enSpan, value: v.en });
  }

  for (const m of c.meta) {
    const v = body.meta?.[m.id];
    // META 值住在 JS 單引號字串裡，跳脫後才寫回
    if (v !== undefined && v !== m.text) {
      edits.push({ span: m.span, value: String(v)
        .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        .replace(/\r?\n/g, '\\n').replace(/</g, '\\x3C') }); // \x3C: no literal </script>
    }
  }

  for (const a of c.alts) {
    const v = body.alts?.[a.id];
    if (!v) continue;
    // alt 值住在雙引號屬性裡，不能出現裸的 " 或 <
    const clean = s => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    if (v.zh !== undefined && v.zh !== a.zh) edits.push({ span: a.zhSpan, value: clean(v.zh) });
    if (v.en !== undefined && v.en !== a.en) edits.push({ span: a.enSpan, value: clean(v.en) });
  }

  for (const m of c.mono) {
    const v = body.mono?.[m.id];
    if (v !== undefined && v !== m.text) edits.push({ span: m.span, value: v });
  }

  if (!edits.length) return { ok: true, changed: 0, pending: readPending().length };

  const out = applyEdits(src, edits);

  // 寫回後立刻重新解析：結構被改壞的話現在就要知道，而不是等到 push
  try {
    parse(out);
  } catch (e) {
    throw new Error(`寫回後結構檢查失敗，已中止未存檔：${e.message}`);
  }
  writeIndex(out);

  // 待翻清單以 id 去重，保留最早的 zh_old（那才是上次翻譯過的版本）
  const pending = readPending();
  for (const item of newlyPending) {
    const i = pending.findIndex(p => p.id === item.id);
    if (i === -1) pending.push(item);
    else pending[i] = { ...pending[i], zh_new: item.zh_new };
  }
  fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2) + '\n');

  return { ok: true, changed: edits.length, pending: pending.length };
}

/** push 前的預檢：解析自檢 + 回傳 diff 摘要給前端確認 */
async function preflight() {
  parse(readIndex()); // 結構壞掉就在這裡拋錯
  const stat = await git(['diff', '--stat']);
  const status = await git(['status', '--porcelain']);
  return {
    ok: true,
    clean: !status.trim(),
    stat: stat.trim() || '（無變動）',
    files: status.trim().split('\n').filter(Boolean),
    pending: readPending().length,
  };
}

async function push(message) {
  parse(readIndex());
  const status = await git(['status', '--porcelain']);
  if (!status.trim()) return { ok: false, error: '沒有任何變動可以推送' };

  const msg = (message || '').trim() || 'Edit site copy via editor';
  // Only the page itself — never sweep stray files into the public repo.
  await git(['add', '--', 'index.html']);
  if (!(await git(['diff', '--cached', '--name-only'])).trim())
    return { ok: false, error: 'index.html 沒有變動可以推送' };
  await git(['commit', '-m', msg]);
  await git(['push']);
  const sha = (await git(['rev-parse', '--short', 'HEAD'])).trim();
  return { ok: true, sha, message: msg };
}

// --- server ----------------------------------------------------------------

const json = (res, code, data) => {
  const b = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length });
  res.end(b);
};

const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', d => {
    s += d;
    if (s.length > 4 << 20) { reject(new Error('body too large')); req.destroy(); }
  });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

// Browsers on this machine can reach 127.0.0.1, so any open web page could
// otherwise POST here (CSRF) or read via DNS rebinding. Three gates:
// Host allowlist, Origin allowlist, and a per-run token only our page knows.
const TOKEN = crypto.randomBytes(24).toString('hex');
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map(h => `http://${h}`));

const tokenOk = t => typeof t === 'string' && t.length === TOKEN.length &&
  crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

function guard(req, url) {
  if (!HOSTS.has(req.headers.host)) return 'bad host';
  const origin = req.headers.origin;
  if (origin && !ORIGINS.has(origin)) return 'bad origin';
  if (url.pathname.startsWith('/api/')) {
    if (!tokenOk(req.headers['x-editor-token'])) return 'bad token';
    if (req.method === 'POST' &&
        !(req.headers['content-type'] || '').startsWith('application/json')) return 'bad content-type';
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const denied = guard(req, url);
  if (denied) return json(res, 403, { ok: false, error: denied });
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'editor.html'), 'utf8')
        .replace('__EDITOR_TOKEN__', TOKEN);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
      });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/content') return json(res, 200, getContent());
    if (req.method === 'GET' && url.pathname === '/api/preflight') return json(res, 200, await preflight());
    if (req.method === 'POST' && url.pathname === '/api/save') return json(res, 200, save(await readBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/push') {
      const b = await readBody(req);
      return json(res, 200, await push(b.message));
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const c = parse(readIndex());
  console.log(`\n  文案編輯器  http://127.0.0.1:${PORT}\n`);
  console.log(`  散文 ${c.prose.length} 組 · META ${c.meta.length} · alt ${c.alts.length} 組 · 單語欄位 ${c.mono.length} 筆`);
  const n = readPending().length;
  if (n) console.log(`  待翻 ${n} 筆——在 Claude Code 說「翻譯待翻項目」`);
  console.log('\n  Ctrl+C 結束\n');
});
