const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { storeFromEnv, clean, encodePath } = require('./storage');

const PORT = process.env.PORT || 3000;
const store = storeFromEnv();

// Limpeza automática: apaga arquivos com mais de CLEANUP_DAYS dias (0 desliga)
const CLEANUP_DAYS = Number(process.env.CLEANUP_DAYS ?? 2);
// Limite por arquivo. No plano grátis do Supabase o máximo é 50 MB.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 50);

// ---------- Login ----------
// Usuários no formato "usuario:senha,outro:senha2" (variável USERS)
// ou ADMIN_USER / ADMIN_PASSWORD para um único usuário.
const USERS = {};
(process.env.USERS || '').split(',').forEach(p => {
  const i = p.indexOf(':');
  if (i > 0) USERS[p.slice(0, i).trim()] = p.slice(i + 1);
});
if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) USERS[process.env.ADMIN_USER] = process.env.ADMIN_PASSWORD;
if (!Object.keys(USERS).length) {
  USERS.admin = 'admin123';
  console.warn('AVISO: nenhum usuário configurado. Usando admin / admin123 — defina USERS!');
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('AVISO: defina SESSION_SECRET para o login não cair quando o servidor reiniciar.');

const hasUser = u => Object.prototype.hasOwnProperty.call(USERS, u);
// A assinatura inclui a senha: trocar a senha de um usuário desloga ele.
const sign = u => crypto.createHmac('sha256', SECRET).update(u + '\0' + USERS[u]).digest('base64url');
const safeEq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(),
  crypto.createHash('sha256').update(String(b)).digest());

// O login não expira: só sai clicando em "Sair" (ou se a senha/SESSION_SECRET mudar)
const makeToken = user => Buffer.from(user).toString('base64url') + '.' + sign(user);
function readToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sess=([^;]+)/);
  if (!m) return null;
  const [u, sig] = m[1].split('.');
  if (!sig) return null;
  const user = Buffer.from(u, 'base64url').toString();
  return hasUser(user) && safeEq(sig, sign(user)) ? user : null;
}
const COOKIE_MAX_AGE = 10 * 365 * 864e5; // ~10 anos

// Limite simples de tentativas por IP (10 a cada 15 min)
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || now - a.t > 15 * 60e3) { attempts.set(ip, { n: 0, t: now }); return false; }
  return a.n >= 10;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { user = '', password = '' } = req.body || {};
  if (!hasUser(user) || !safeEq(password, USERS[user])) {
    attempts.get(ip).n++;
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
  attempts.delete(ip);
  res.cookie('sess', makeToken(user), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: COOKIE_MAX_AGE });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('sess'); res.json({ ok: true }); });

app.get('/login.html', (req, res) =>
  readToken(req) ? res.redirect('/') : res.sendFile(path.join(__dirname, 'public', 'login.html')));

// Tudo daqui pra baixo exige login
app.use((req, res, next) => {
  const user = readToken(req);
  if (user) { req.user = user; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login.html');
});
app.all('/api/me', (req, res) => res.json({ user: req.user, cleanupDays: CLEANUP_DAYS, maxFileMb: MAX_FILE_MB }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Arquivos ----------
// Cada usuário tem a sua própria área: os arquivos ficam em "<usuario>/..." no Supabase
const userRoot = req => clean(req.user.replace(/[\/\\]/g, '_'));
const inUser = (req, p) => (p ? userRoot(req) + '/' + p : userRoot(req));

// Acompanha downloads em andamento (para a janela "pode excluir?" saber quando terminou)
const downloads = new Map(); // token -> { user, state: 'pending' | 'done' | 'error', t }
function trackDownload(req, res) {
  const token = String(req.query.token || '').slice(0, 64);
  if (!token) return;
  const d = { user: req.user, state: 'pending', t: Date.now() };
  downloads.set(token, d);
  res.on('finish', () => { d.state = res.statusCode < 400 ? 'done' : 'error'; });
  res.on('close', () => { if (!res.writableFinished) d.state = 'error'; });
}
app.all('/api/download-status', (req, res) => {
  const token = String((req.body && req.body.token) || req.query.token || '');
  const d = downloads.get(token);
  res.json({ state: d && d.user === req.user ? d.state : 'unknown' });
});

const upload = multer({ dest: path.join(os.tmpdir(), 'uploads-tmp') });
const contentDisposition = name =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

// Upload: campo "files" + campo "paths" (caminho relativo de cada arquivo, para pastas)
app.post('/api/upload', upload.array('files'), async (req, res) => {
  const failed = [];
  try {
    const base = clean(req.query.dir);
    const paths = [].concat(req.body.paths || []);
    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];
      const rel = clean(paths[i] || f.originalname);
      if (!rel) continue;
      if (f.size > MAX_FILE_MB * 1024 * 1024) { failed.push(rel); continue; }
      try {
        const body = await fs.promises.readFile(f.path);
        await store.save(inUser(req, (base ? base + '/' : '') + rel), body, f.mimetype || 'application/octet-stream');
      } catch (e) {
        console.error('Falha ao enviar', rel, e.message);
        failed.push(rel);
      }
    }
    res.json({ ok: true, count: req.files.length - failed.length, failed });
  } finally {
    (req.files || []).forEach(f => fs.rm(f.path, { force: true }, () => {}));
  }
});

// Lista o conteúdo de uma pasta
// Aceita GET e POST: algumas redes corporativas atrapalham GETs feitos pela página
app.all('/api/list', async (req, res) => {
  try {
    const dir = clean((req.body && req.body.dir) ?? req.query.dir);
    res.json({ dir, items: await store.list(inUser(req, dir)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao listar' });
  }
});

// Download de arquivo, ou de pasta como .zip
app.get('/api/download', async (req, res) => {
  const p = clean(req.query.path);
  trackDownload(req, res);
  if (!p) return res.sendStatus(400);
  const full = inUser(req, p);
  try {
    if (await store.isFile(full)) {
      const { body, type } = await store.downloadFile(full);
      res.setHeader('Content-Type', type || 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(p.split('/').pop()));
      return res.send(body);
    }

    const files = (await store.listAll(encodePath(full))).filter(f => !f.placeholder);
    if (!files.length) return res.sendStatus(404);
    const folder = p.split('/').pop();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(folder + '.zip'));
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', e => { console.error(e); res.end(); });
    zip.pipe(res);
    for (const f of files) {
      zip.append(await store.download(f.key), { name: folder + '/' + f.rel, date: new Date(f.created) });
    }
    zip.finalize();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.sendStatus(500); else res.end();
  }
});

// Excluir arquivo ou pasta
app.all('/api/delete', async (req, res) => {
  const p = clean(req.query.path);
  if (!p) return res.sendStatus(400);
  try {
    await store.remove(inUser(req, p));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao excluir' });
  }
});

// Criar pasta
app.post('/api/mkdir', async (req, res) => {
  const p = clean(req.query.path);
  if (!p) return res.sendStatus(400);
  try {
    await store.mkdir(inUser(req, p));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar pasta' });
  }
});

// ---------- Manutenção (enquanto o servidor estiver acordado) ----------
// Quando o site fica parado, quem faz isso é o GitHub Actions (.github/workflows/manutencao.yml)
async function maintenance() {
  for (const [k, d] of downloads) if (Date.now() - d.t > 6 * 3600e3) downloads.delete(k);
  try {
    const n = await store.cleanup(CLEANUP_DAYS);
    if (n) console.log(`Limpeza: ${n} arquivo(s) com mais de ${CLEANUP_DAYS} dia(s) apagado(s).`);
    await store.keepAlive();
  } catch (e) {
    console.error('Erro na manutenção:', e.message);
  }
}

store.ensureBucket()
  .catch(e => console.error('Não consegui verificar/criar o bucket:', e.message))
  .finally(() => {
    maintenance();
    setInterval(maintenance, 60 * 60e3); // a cada hora
    app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
  });
