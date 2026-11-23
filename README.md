# Meus Arquivos

Site simples para upload e download de arquivos e pastas, com login por usuário e senha.

## Rodar no computador

```bash
npm install
USERS="seuusuario:suasenha" npm start
```

Abra http://localhost:3000

## Configuração (variáveis de ambiente)

| Variável | Exemplo | Para quê |
|---|---|---|
| `USERS` | `maria:senha1,joao:senha2` | Usuários e senhas que podem entrar (separados por vírgula) |
| `SESSION_SECRET` | um texto longo aleatório | Mantém o login ativo mesmo se o servidor reiniciar |
| `STORAGE_DIR` | `/data` | Onde os arquivos ficam salvos (padrão: `./uploads`) |
| `PORT` | `3000` | Porta do servidor |

Se `USERS` não for definido, o login padrão é **admin / admin123** — troque antes de publicar!

## Hospedar na internet (Render)

O GitHub guarda o código, mas o GitHub Pages não roda servidor. Para o site funcionar online:

1. Crie uma conta em https://render.com e entre com o GitHub.
2. **New → Web Service** → escolha este repositório.
3. Build command: `npm install` · Start command: `npm start`
4. Em **Environment**, adicione `USERS` e `SESSION_SECRET`.
5. Em **Disks**, adicione um disco montado em `/data` e defina `STORAGE_DIR=/data`
   (sem disco, os arquivos são apagados sempre que o servidor reinicia).

## Funcionalidades

- Enviar arquivos, enviar pasta inteira (mantém as subpastas) ou arrastar e soltar
- Navegar entre pastas, criar pasta, excluir
- Baixar arquivos, ou pastas inteiras como `.zip`
