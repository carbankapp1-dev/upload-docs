// Armazenamento no Supabase Storage + limpeza automática + "keep-alive".
const { createClient } = require('@supabase/supabase-js');

const PLACEHOLDER = '.emptyFolderPlaceholder'; // mesmo marcador que o painel do Supabase usa para pastas vazias
const PAGE = 1000;

// O Supabase não aceita acentos e vários símbolos no nome dos arquivos.
// Então codificamos: "café.txt" vira "caf@e9;.txt" lá dentro, e o site mostra o nome original.
const encodeSeg = s => [...s].map(c => (/[A-Za-z0-9_.()-]/.test(c) ? c : `@${c.codePointAt(0).toString(16)};`)).join('');
const decodeSeg = s => s.replace(/@([0-9a-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
const encodePath = p => p.split('/').filter(Boolean).map(encodeSeg).join('/');
const decodePath = p => p.split('/').map(decodeSeg).join('/');

// Normaliza um caminho relativo ("a/b/c.txt"), bloqueando "../"
function clean(rel = '') {
  return String(rel).replace(/\\/g, '/').split('/')
    .filter(p => p && p !== '.' && p !== '..').join('/');
}

function createStore({ url, key, bucket = 'arquivos', client } = {}) {
  const supabase = client || createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const b = () => supabase.storage.from(bucket);
  const must = ({ data, error }) => { if (error) throw error; return data; };

  // Cria o bucket (privado) se ainda não existir
  async function ensureBucket() {
    const { error } = await supabase.storage.getBucket(bucket);
    if (!error) return;
    const r = await supabase.storage.createBucket(bucket, { public: false });
    if (r.error && !/exist/i.test(r.error.message)) throw r.error;
  }

  // Conteúdo direto de uma pasta (key = caminho codificado)
  async function listRaw(key) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const data = must(await b().list(key, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } }));
      out.push(...data);
      if (data.length < PAGE) return out;
    }
  }

  // Lista para o site: [{ name, isDir, size, mtime }]
  async function list(dir) {
    const items = (await listRaw(encodePath(dir)))
      .filter(o => o.name !== PLACEHOLDER)
      .map(o => o.id == null
        ? { name: decodeSeg(o.name), isDir: true, size: 0, mtime: null }
        : { name: decodeSeg(o.name), isDir: false, size: o.metadata?.size ?? 0, mtime: Date.parse(o.created_at || o.updated_at) });
    return items.sort((a, c) => (c.isDir - a.isDir) || a.name.localeCompare(c.name, 'pt-BR'));
  }

  // Todos os arquivos dentro de uma pasta, recursivo: [{ key, rel, created }]
  async function listAll(key, rel = '') {
    const out = [];
    for (const o of await listRaw(key)) {
      const k = key ? key + '/' + o.name : o.name;
      const r = rel ? rel + '/' + decodeSeg(o.name) : decodeSeg(o.name);
      if (o.id == null) out.push(...await listAll(k, r));
      else out.push({ key: k, rel: r, created: Date.parse(o.created_at || o.updated_at), placeholder: o.name === PLACEHOLDER });
    }
    return out;
  }

  async function removeKeys(keys) {
    for (let i = 0; i < keys.length; i += PAGE) must(await b().remove(keys.slice(i, i + PAGE)));
  }

  // Salva sem sobrescrever: "foto.png" -> "foto (1).png". Retorna o caminho final.
  async function save(relPath, body, contentType) {
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '';
    const file = relPath.slice(dir.length);
    const dot = file.lastIndexOf('.');
    const [name, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
    for (let i = 0; i < 1000; i++) {
      const candidate = dir + (i ? `${name} (${i})${ext}` : file);
      const { error } = await b().upload(encodePath(candidate), body, { contentType, upsert: false });
      if (!error) return candidate;
      const dup = error.status === 409 || error.statusCode === '409' || /exist|duplicate/i.test(error.message);
      if (!dup) throw error;
    }
    throw new Error('Nomes repetidos demais');
  }

  async function isFile(path) {
    const { data } = await b().exists(encodePath(path)).catch(() => ({ data: false }));
    return !!data;
  }

  async function download(key) {
    const blob = must(await b().download(key));
    return Buffer.from(await blob.arrayBuffer());
  }
  async function downloadFile(path) {
    const blob = must(await b().download(encodePath(path)));
    return { body: Buffer.from(await blob.arrayBuffer()), type: blob.type };
  }

  async function remove(path) {
    const key = encodePath(path);
    const keys = (await listAll(key)).map(o => o.key);
    if (await isFile(path)) keys.push(key);
    await removeKeys(keys);
  }

  async function mkdir(path) {
    const { error } = await b().upload(encodePath(path) + '/' + PLACEHOLDER, Buffer.alloc(0), { upsert: true });
    if (error) throw error;
  }

  // Apaga arquivos com mais de `days` dias. Retorna quantos apagou.
  async function cleanup(days) {
    if (!(days > 0)) return 0;
    const limit = Date.now() - days * 864e5;
    const old = (await listAll('')).filter(o => o.created < limit).map(o => o.key);
    await removeKeys(old);
    return old.length;
  }

  // Faz uma consulta leve ao banco e ao Storage para o Supabase não pausar o projeto
  async function keepAlive() {
    await b().list('', { limit: 1 });
    if (url && key) {
      await fetch(url.replace(/\/$/, '') + '/rest/v1/', { headers: { apikey: key } }).catch(() => {});
    }
  }

  return { ensureBucket, list, listAll, save, isFile, download, downloadFile, remove, mkdir, cleanup, keepAlive };
}

function storeFromEnv() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BUCKET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Configure SUPABASE_URL e SUPABASE_SERVICE_KEY (veja o README).');
    process.exit(1);
  }
  return createStore({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY, bucket: SUPABASE_BUCKET || 'arquivos' });
}

module.exports = { createStore, storeFromEnv, clean, encodePath, decodePath };
