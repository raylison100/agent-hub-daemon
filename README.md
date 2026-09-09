# agent-hub-daemon

Servico local que roda na maquina do usuario. Fonte da verdade das sessoes,
executor de ferramentas, servidor WebSocket para os clientes e, na fase 3,
cliente do relay.

Estado: fase 1, esqueleto funcional por CLI. Planejamento em `../docs/`.

## Requisitos

- Node 22 ou superior e pnpm.
- `../core` compilado (`pnpm build` la dentro), porque este pacote o consome
  por `link:../core`.
- Chaves de API no ambiente: `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`. O
  agente local usa Ollama em `http://127.0.0.1:11434` por padrao.

## Configuracao

`~/.agent-hub/config.toml` (ou `$AGENT_HUB_HOME/config.toml`):

```toml
agents_dir = "/home/usuario/Projects/agent-hub/agents"
host = "127.0.0.1"
port = 47311
workspaces = ["/home/usuario/Projects/meu-projeto"]
approval_timeout_ms = 600000
device_name = "pc-casa"
```

`agent-hub-daemon init` grava esse exemplo. Sessao so pode ser criada em
diretorio listado em `workspaces`. O token local fica em
`~/.agent-hub/token`, gerado no primeiro uso.

## Comandos

```bash
pnpm install
pnpm build
node dist/cli.js init
node dist/cli.js agents
node dist/cli.js chat --agent deepseek-dev --workspace /caminho/do/projeto
node dist/cli.js start
node dist/cli.js status
node dist/cli.js pair
node dist/cli.js cost --group agent --since today
```

Durante o desenvolvimento, `pnpm dev <comando>` roda direto do fonte.

## Protocolo

WebSocket em `ws://host:porta/ws`, quadros JSON definidos em
`@agent-hub/core` (`protocol/frames.ts`). O primeiro quadro precisa ser
`auth` com o token e `protocol_version`. Detalhes em
`../docs/02-arquitetura.md`.

Quadros atendidos na fase 1: `auth`, `agents.list`, `session.create`,
`session.list`, `session.get`, `sync`, `run.start`, `run.cancel`,
`approval.respond`, `cost.report`. `budget.override` entra na fase 2.

## Estrutura

```
src/
  config.ts     config.toml, token local
  db.ts         SQLite e migracoes (sessoes, mensagens, eventos, aprovacoes)
  store.ts      SessionStore com seq por sessao para catch-up
  approvals.ts  fila de aprovacao com expiracao
  runtime.ts    carrega agents/, monta runner, escala para fallback_agent
  server.ts     Fastify + WebSocket, broadcast de eventos
  cli.ts        init, start, status, pair, agents, cost, chat
```

## Pendente na fase 1

- Compactacao e poda de contexto.
- MCP por HTTP com OAuth, recursos e prompts. Hoje apenas stdio e tools.
- Redacao de segredos na saida de ferramentas (`policies/secrets.json`).
- Roteamento por regra (`routing.json` e lido mas nao aplicado).
