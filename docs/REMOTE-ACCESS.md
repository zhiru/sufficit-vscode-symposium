# Acesso remoto ao Symposium (bridge + Tailscale)

Dirigir uma sessão de agente do celular, sem abrir porta no notebook. O
transporte é o **Tailscale** (WireGuard, direto, TLS no notebook); o bridge da
extensão continua em `127.0.0.1`.

> ⚠ **O bridge é execução remota de código.** `POST /sessions` sobe um CLI de
> agente. Só exponha atrás de um tailnet privado (ou de um túnel autenticado) e
> **com os limites de política abaixo configurados**. Um token vazado = shell na
> máquina.

## Política de segurança (configure ANTES de expor)

Estes controles ficam em `settings.json` (`symposium.bridge.*`). Um token válido
prova "um cliente conhecido chamou", não "a chamada é segura" — por isso os
endpoints perigosos têm limite próprio:

| Setting | Default | O que faz |
|---|---|---|
| `enabled` | `false` | liga o bridge |
| `token` | `""` (efêmero) | bearer exigido; defina um forte e estável |
| `allowedRoots` | `[]` → workspace | diretórios que uma sessão remota pode usar como `cwd`. Vazio = pastas do workspace aberto; sem workspace = criação remota recusada |
| `sessionPermission` | `acceptEdits` | modo de permissão forçado nas sessões remotas. `bypassPermissions`/`never` não são oferecidos |
| `allowedLmTools` | `[]` | ferramentas LM do VS Code invocáveis remotamente. Vazio = nenhuma (podem incluir terminal) |
| `allowExecutableOverride` | `false` | permitir reescrever o binário de spawn (é RCE limpo) |
| `allowVaultResolve` | `false` | permitir ler segredos do vault via `/vault/resolve` |
| `allowedHosts` | `[]` | Hosts HTTP aceitos (anti DNS-rebinding). Loopback sempre passa; defina o hostname do tailnet quando tiver |

Exemplo mínimo seguro (troque os placeholders):

```jsonc
{
  "symposium.bridge.enabled": true,
  "symposium.bridge.token": "<TOKEN-FORTE-ALEATORIO>",
  "symposium.bridge.allowedRoots": ["<CAMINHO-ABSOLUTO-DO-PROJETO>"],
  "symposium.bridge.sessionPermission": "acceptEdits",
  "symposium.bridge.allowedHosts": ["<SEU-NODE>.<TAILNET>.ts.net"]
}
```

Gere um token forte:

```bash
node -e "console.log(require('crypto').randomUUID())"
```

## Fase 0 — provar que o celular alcança (sem escrever cliente)

1. **Ligar o bridge.** Aplique o `settings.json` acima e recarregue a janela do
   VS Code. No canal de saída "Symposium" deve aparecer `[bridge] listening on
   http://127.0.0.1:47600`.

2. **Expor pelo Tailscale** (o notebook disca pra fora; nenhuma porta inbound):

   ```bash
   tailscale serve --bg 47600
   # publica https://<SEU-NODE>.<TAILNET>.ts.net → 127.0.0.1:47600, TLS no notebook
   ```

   Veja o status e a URL:

   ```bash
   tailscale serve status
   ```

3. **Testar do celular** (com o app Tailscale ligado, no mesmo tailnet):

   ```
   GET https://<SEU-NODE>.<TAILNET>.ts.net/health
   Authorization: Bearer <TOKEN-FORTE>
   → { "ok": true, "version": "..." }
   ```

   Seguir o stream de uma sessão viva (SSE):

   ```
   GET https://<SEU-NODE>.<TAILNET>.ts.net/sessions/<id>/follow?token=<TOKEN>
   ```

   Listar sessões: `GET /sessions` (com header `Authorization: Bearer`).

Na Fase 0 use só leitura (`/health`, `/sessions`, `/follow`). Criar sessão
(`POST /sessions`) já respeita `allowedRoots` + `sessionPermission`, mas deixe pra
validar junto com o cliente na Fase 1.

## Verificação rápida dos limites

Com o bridge ligado, estas chamadas autenticadas devem ser **recusadas** pela
política padrão:

```
POST /sessions            {cwd: "/etc"}          → 403 cwd not allowed
POST /vscode/lmtool       {name: "runInTerminal"}→ 403 lm tool not allowed
POST /backends/x/executable                       → 403 executable override disabled
GET  /vault/resolve?reference=...                 → 403 vault resolve disabled
```

## Próximas fases

- **Fase 1** — PWA (o chat de fora). Precisa de um shim de transporte que
  traduz as mensagens `WebviewToHost` do cliente em chamadas REST do bridge, e o
  bridge servindo os estáticos same-origin. Verificação exige Extension Host (F5).
- **Fase 2** — login Sufficit (client PKCE novo + validação de JWT no bridge),
  registro de máquinas no hub, Web Push no `turn-end`.

Ver o brief de arquitetura para o desenho completo e o plano por-arquivo.
