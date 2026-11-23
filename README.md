# Meus Arquivos

Site simples para upload e download de arquivos e pastas, com login por usuário e senha.
Os arquivos ficam guardados no **Cloudflare R2** e são apagados automaticamente após 2 dias.

## 1. Criar o armazenamento no Cloudflare R2

1. Crie uma conta em https://dash.cloudflare.com e abra **R2 Object Storage** (o plano grátis inclui 10 GB).
2. Clique em **Create bucket** e dê um nome, por exemplo `upload-docs`.
3. Volte em **R2** → **Manage API tokens** → **Create API token**:
   - Permissão: **Object Read & Write**
   - Escopo: só o bucket que você criou
4. Anote: **Access Key ID**, **Secret Access Key** e o **Account ID** (aparece na página do R2).

## 2. Configuração (variáveis de ambiente)

| Variável | Exemplo | Para quê |
|---|---|---|
| `R2_ACCOUNT_ID` | `a1b2c3...` | Account ID da Cloudflare |
| `R2_ACCESS_KEY_ID` | `...` | Access Key ID do token R2 |
| `R2_SECRET_ACCESS_KEY` | `...` | Secret Access Key do token R2 |
| `R2_BUCKET` | `upload-docs` | Nome do bucket |
| `USERS` | `maria:senha1,joao:senha2` | Usuários e senhas que podem entrar |
| `SESSION_SECRET` | um texto longo aleatório | Mantém o login ativo mesmo se o servidor reiniciar |
| `CLEANUP_DAYS` | `2` | Apaga arquivos com mais de X dias (padrão 2; `0` desliga) |

O login **não expira**: a pessoa só sai clicando em "Sair". Trocar a senha de um usuário
em `USERS` desloga ele de todos os aparelhos.

## 3. Rodar no computador

```bash
npm install
npm start
```

(defina as variáveis acima antes) e abra http://localhost:3000

## 4. Hospedar na internet (Render, plano grátis)

1. Crie uma conta em https://render.com e entre com o GitHub.
2. **New → Web Service** → escolha este repositório.
3. Build command: `npm install` · Start command: `npm start`
4. Em **Environment**, adicione todas as variáveis da tabela acima.

Como os arquivos ficam no R2, não precisa de disco pago no Render.

## Funcionalidades

- Enviar arquivos, enviar pasta inteira (mantém as subpastas) ou arrastar e soltar
- Navegar entre pastas, criar pasta, excluir
- Baixar arquivos, ou pastas inteiras como `.zip`
- Limpeza automática dos arquivos antigos (verificada a cada hora)
