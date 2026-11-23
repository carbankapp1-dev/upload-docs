# Meus Arquivos

Site simples para upload e download de arquivos e pastas, com login por usuário e senha.
Os arquivos ficam no **Supabase Storage** e são apagados automaticamente após 2 dias.

## 1. Criar o projeto no Supabase (grátis, sem cartão)

1. Crie uma conta em https://supabase.com e clique em **New project**.
2. Depois que o projeto for criado, vá em **Project Settings → API** (ou **API Keys**) e copie:
   - **Project URL** (ex.: `https://abcdefgh.supabase.co`)
   - a chave **service_role** (ou **secret key**, começa com `sb_secret_`)

O bucket `arquivos` é criado sozinho quando o site inicia (privado).
⚠️ A chave service_role é secreta: coloque só no Render e nos Secrets do GitHub, nunca no código.

## 2. Configuração (variáveis de ambiente)

| Variável | Exemplo | Para quê |
|---|---|---|
| `SUPABASE_URL` | `https://abcdefgh.supabase.co` | Endereço do projeto |
| `SUPABASE_SERVICE_KEY` | `eyJ...` ou `sb_secret_...` | Chave service_role / secret |
| `SUPABASE_BUCKET` | `arquivos` | Nome do bucket (opcional, padrão `arquivos`) |
| `USERS` | `maria:senha1,joao:senha2` | Usuários e senhas que podem entrar |
| `SESSION_SECRET` | um texto longo aleatório | Mantém o login ativo mesmo se o servidor reiniciar |
| `CLEANUP_DAYS` | `2` | Apaga arquivos com mais de X dias (padrão 2; `0` desliga) |
| `MAX_FILE_MB` | `50` | Tamanho máximo por arquivo (plano grátis do Supabase: 50 MB) |

O login **não expira**: a pessoa só sai clicando em "Sair".
Trocar a senha de um usuário em `USERS` desloga ele de todos os aparelhos.

## 3. Hospedar na internet (Render, plano grátis)

1. Crie uma conta em https://render.com e entre com o GitHub.
2. **New → Web Service** → escolha este repositório.
3. Build command: `npm install` · Start command: `npm start`
4. Em **Environment**, adicione as variáveis da tabela acima.

## 4. Manter o Supabase sempre ativo (GitHub Actions)

O plano grátis do Supabase pausa projetos parados por 7 dias, e o Render grátis "dorme"
quando ninguém acessa. Por isso o arquivo `.github/workflows/manutencao.yml` roda
**a cada 6 horas no próprio GitHub**, de graça:
- acessa o Supabase (o projeto não pausa);
- apaga os arquivos com mais de 2 dias.

Para ativar, no repositório do GitHub vá em **Settings → Secrets and variables → Actions →
New repository secret** e crie:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Para testar na hora: aba **Actions → Manutenção → Run workflow**.

> Em repositórios **públicos**, o GitHub desliga agendamentos após 60 dias sem nenhum commit.
> Em repositório **privado** isso não acontece.

## Rodar no computador

```bash
npm install
npm start
```

(com as variáveis acima definidas) e abra http://localhost:3000

## Funcionalidades

- Enviar arquivos, enviar pasta inteira (mantém as subpastas) ou arrastar e soltar
- Navegar entre pastas, criar pasta, excluir
- Baixar arquivos, ou pastas inteiras como `.zip`
- Limpeza automática dos arquivos antigos
