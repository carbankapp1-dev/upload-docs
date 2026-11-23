const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const STORAGE = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'uploads'));
const TMP = path.join(STORAGE, '.tmp');
fs.mkdirSync(TMP, { recursive: true });

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
  console.warn('AVISO: nenhum usuário configurado. Usando admin / admin123 — defina USERS ou ADMIN_USER/ADMIN_PASSWORD!');
}
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DAYS = 7;

const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function makeToken(user) {
  const v = Buffer.from(user).toString('base64url') + '.' + (Date.now() + SESSION_DAYS * 864e5);
  return v + '.' + sign(v);
}
function readToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sess=([^;]+)/);
  if (!m) return null;
  const [u, exp, sig] = m[1].split('.');
  if (!sig || !safeEq(sig, sign(u + '.' + exp)) || Date.now() > +exp) return null;
  const user = Buffer.from(u, 'base64url').toString();
  return Object.prototype.hasOwnProperty.call(USERS, user) ? user : null;
}

// Limite simples de tentativas por IP (10 a cada 15 min)
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || now - a.t > 15 * 60e3) { attempts.set(ip, { n: 0, t: now }); return false; }
  return a.n >= 10;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { user = '', password = '' } = req.body || {};
  const ok = Object.prototype.hasOwnProperty.call(USERS, user) && safeEq(password, USERS[user]);
  if (!ok) { attempts.get(ip).n++; return res.status(401).json({ error: 'Usuário ou senha incorretos' }); }
  attempts.delete(ip);
  res.cookie('sess', makeToken(user), {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5
  });
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
app.get('/api/me', (req, res) => res.json({ user: req.user }));
app.use(express.static(path.join(__dirname, 'public')));

// Resolve um caminho relativo dentro de STORAGE, bloqueando "../"
function safePath(rel = '') {
  const clean = String(rel).replace(/\\/g, '/').split('/')
    .filter(p => p && p !== '.' && p !== '..' && p !== '.tmp').join('/');
  const full = path.resolve(STORAGE, clean);
  if (full !== STORAGE && !full.startsWith(STORAGE + path.sep)) throw new Error('Caminho inválido');
  return { full, clean };
}

// Evita sobrescrever: "foto.png" -> "foto (1).png"
function uniqueName(full) {
  if (!fs.existsSync(full)) return full;
  const { dir, name, ext } = path.parse(full);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${name} (${i})${ext}`))) i++;
  return path.join(dir, `${name} (${i})${ext}`);
}

const upload = multer({ dest: TMP, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

// Upload: campo "files" + campo "paths" (caminho relativo de cada arquivo, para pastas)
app.post('/api/upload', upload.array('files'), (req, res) => {
  try {
    const base = safePath(req.query.dir).full;
    const paths = [].concat(req.body.paths || []);
    req.files.forEach((f, i) => {
      const rel = paths[i] || Buffer.from(f.originalname, 'latin1').toString('utf8');
      const dest = uniqueName(path.join(base, safePath(rel).clean));
      if (!dest.startsWith(STORAGE + path.sep)) throw new Error('Caminho inválido');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(f.path, dest);
    });
    res.json({ ok: true, count: req.files.length });
  } catch (e) {
    (req.files || []).forEach(f => fs.rm(f.path, { force: true }, () => {}));
    res.status(400).json({ error: e.message });
  }
});

// Lista o conteúdo de uma pasta
app.get('/api/list', (req, res) => {
  try {
    const { full, clean } = safePath(req.query.dir);
    const items = fs.readdirSync(full, { withFileTypes: true })
      .filter(d => d.name !== '.tmp')
      .map(d => {
        const st = fs.statSync(path.join(full, d.name));
        return { name: d.name, isDir: d.isDirectory(), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'pt-BR'));
    res.json({ dir: clean, items });
  } catch (e) {
    res.status(404).json({ error: 'Pasta não encontrada' });
  }
});

// Download de arquivo, ou de pasta como .zip
app.get('/api/download', (req, res) => {
  let target;
  try { target = safePath(req.query.path); } catch { return res.sendStatus(400); }
  if (!target.clean || !fs.existsSync(target.full)) return res.sendStatus(404);

  if (fs.statSync(target.full).isDirectory()) {
    const name = path.basename(target.full) + '.zip';
    res.attachment(name);
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', () => res.end());
    zip.pipe(res);
    zip.directory(target.full, path.basename(target.full));
    zip.finalize();
  } else {
    res.download(target.full);
  }
});

// Excluir arquivo ou pasta
app.delete('/api/delete', (req, res) => {
  try {
    const { full, clean } = safePath(req.query.path);
    if (!clean) return res.sendStatus(400);
    fs.rmSync(full, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Criar pasta
app.post('/api/mkdir', (req, res) => {
  try {
    const { full, clean } = safePath(req.query.path);
    if (!clean) return res.sendStatus(400);
    fs.mkdirSync(full, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
