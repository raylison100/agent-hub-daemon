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
node dist/cli.js schedules
```

## Agendamentos

Ficam na tabela `schedules` e podem vir de `agents/schedules/*.json` (fonte
`file`, recarregados a cada inicio) ou da interface (fonte `db`). Toda
automacao exige `budget.run_usd` e `budget.day_usd`; `mode: draft` nega
escrita e execucao. O interruptor geral (`automation.pause`) persiste entre
reinicios.

```json
{
  "id": "resumo-diario",
  "cron": "0 8 * * 1-5",
  "timezone": "America/Sao_Paulo",
  "agent": "local-leitor",
  "workspace": "/home/usuario/Projects/meu-projeto",
  "prompt": "Resuma o que mudou no git log de ontem.",
  "mode": "draft",
  "budget": { "run_usd": 0.2, "day_usd": 0.5 },
  "overlap": "skip",
  "missed": "skip",
  "enabled": true
}
```

Durante o desenvolvimento, `pnpm dev <comando>` roda direto do fonte.

## Protocolo

WebSocket em `ws://host:porta/ws`, quadros JSON definidos em
`@agent-hub/core` (`protocol/frames.ts`). O primeiro quadro precisa ser
`auth` com o token e `protocol_version`. Detalhes em
`../docs/02-arquitetura.md`.

Quadros atendidos: `auth`, `agents.list`, `session.create` (agente
opcional, roteado pelo texto), `session.list`, `session.get`, `sync`,
`run.start`, `run.cancel`, `approval.respond`, `budget.override`,
`cost.report`, `schedule.*`, `automation.*`.

## Estrutura

```
src/
  config.ts     config.toml, token local
  db.ts         SQLite e migracoes (sessoes, mensagens, eventos, aprovacoes)
  store.ts      SessionStore com seq por sessao para catch-up
  approvals.ts  fila de aprovacao com expiracao
  runtime.ts    carrega agents/, monta runner, roteia, resume para compactacao, escala para fallback_agent
  schedules.ts  agendamentos por cron, orcamento diario, modo rascunho, interruptor geral
  server.ts     Fastify + WebSocket, broadcast de eventos
  cli.ts        init, start, status, pair, agents, schedules, cost, chat
```

## Pendente

- MCP: OAuth para servidores HTTP, recursos e prompts. Hoje stdio e HTTP
  com cabecalhos fixos, apenas tools.
- Gatilhos externos e webhooks de saida (fase 3, dependem do relay).
