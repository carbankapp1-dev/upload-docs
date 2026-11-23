// Rodado pelo GitHub Actions a cada 6 horas:
// apaga arquivos antigos e mantém o projeto do Supabase ativo (para não pausar).
const { storeFromEnv } = require('../storage');

(async () => {
  const store = storeFromEnv();
  const days = Number(process.env.CLEANUP_DAYS ?? 2);
  const n = await store.cleanup(days);
  console.log(`Limpeza: ${n} arquivo(s) com mais de ${days} dia(s) apagado(s).`);
  await store.keepAlive();
  console.log('Supabase acessado com sucesso (projeto continua ativo).');
})().catch(e => { console.error('Erro:', e.message); process.exit(1); });
