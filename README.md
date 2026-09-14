# agent-hub-daemon

Servico local do Agent Hub. Roda na sua maquina e e a fonte da verdade: guarda
conversas, mensagens e custos no SQLite, escolhe o agente de cada pedido, chama
os provedores, executa ferramentas com politica e aprovacao, roda agendamentos,
gatilhos e workflows, conecta os servidores MCP e serve a interface web e a API
WebSocket para os clientes. As chaves de API ficam so aqui, num cofre cifrado.

A logica de agente vem do [core](https://github.com/raylison100/agent-hub-core);
perfis, precos e regras vem do [agents](https://github.com/raylison100/agent-hub-agents).

## Requisitos

- Linux ou WSL, Node 22 ou superior e pnpm.
- `../core` compilado, porque este pacote o consome por `link:../core`.
- Para o modelo local, Ollama respondendo em `OLLAMA_BASE_URL` (o `make dev` da
  raiz sobe um container com GPU).

As chaves de API sao cadastradas pela tela Configuracoes, Chaves, e ficam
cifradas no SQLite. Tambem sao aceitas pelo ambiente ou por
`~/.agent-hub/.env`; `agent-hub-daemon env` mostra quais foram encontradas sem
revelar valores.

## Pacote

`make pacote`, na raiz, gera `dist-pacote/agent-hub-VERSAO.tgz` com `scripts/pacote.sh`:
este daemon compilado, o `core` como dependencia empacotada, o `dist` da
interface e o modelo de agentes. `make pacote-testar` instala num container
limpo e confere tudo; `scripts/testar-pacote-servico.sh` confere o caminho do
systemd com um `systemctl` falso. A entrada `dist/bin.js` confere os modulos
nativos antes de carregar o resto, para o erro dizer o que instalar.

## Configuracao

`~/.agent-hub/config.toml` (ou `$AGENT_HUB_HOME/config.toml`):

```toml
agents_dir = "/home/usuario/Projects/agent-hub/agents"
host = "127.0.0.1"
port = 47311
workspaces = ["/home/usuario/Projects"]
approval_timeout_ms = 600000
device_name = "pc-casa"
# relay_url = "wss://relay.exemplo.com"
# otel_endpoint = "http://127.0.0.1:4318"
```

`agent-hub-daemon init` grava esse modelo. Sessao so pode ser criada dentro de
uma pasta listada em `workspaces`. Sem `agents_dir`, o daemon procura em
`~/.agent-hub/agents`. O `mcp.json` com seus conectores fica nessa pasta e nao
deve ser versionado.

## Rodar

```bash
pnpm install
pnpm build
node dist/cli.js init
node dist/cli.js start
```

A interface fica em `http://127.0.0.1:47311`. Na propria maquina a conexao e
automatica. Para subir com o sistema e voltar sozinho depois de reiniciar pela
interface, instale o servico do systemd com `make servico` na raiz.

## Comandos

| Comando | O que faz |
|---|---|
| `instalar` | prepara a maquina: config, agentes iniciais, servico do systemd e teste de saude |
| `servico` | regrava o servico apontando para esta instalacao e reinicia |
| `atualizar [pacote]` | instala a versao nova do pacote e regrava o servico |
| `init` | cria `config.toml` e `.env` de modelo em `~/.agent-hub` |
| `start` | sobe o servidor WebSocket e a interface |
| `status` | confere se o daemon responde |
| `env` | mostra quais chaves foram encontradas, sem os valores |
| `pair` | dados, link e QR para conectar outro dispositivo, local ou pelo relay |
| `senha` | define a senha do acesso remoto, lida da entrada padrao |
| `agents` | perfis e papeis carregados, com erros |
| `route <texto>` | mostra a decisao do roteador e o ranking, sem gastar tokens |
| `feedback` | votos bom e ruim por agente e intencao, com o ajuste aprendido |
| `cost` | relatorio do ledger por agente, modelo, sessao ou dia |
| `schedules`, `triggers` | agendamentos e gatilhos cadastrados |
| `workflows [nome]` | lista workflows com custo maximo, ou roda um |
| `plugins [sync]` | lista plugins, ou clona e atualiza os declarados por git |
| `mcp` | expoe o daemon como servidor MCP por stdio |
| `chat` | conversa pelo terminal, aprovando ferramentas ali mesmo |

## Agendamentos

Ficam na tabela `schedules` e podem vir de `agents/schedules/*.json`
(recarregados a cada inicio) ou da interface. Toda automacao exige
`budget.run_usd` e `budget.day_usd`; `mode: draft` nega escrita e execucao. O
interruptor geral persiste entre reinicios.

```json
{
  "id": "resumo-diario",
  "cron": "0 8 * * 1-5",
  "timezone": "America/Sao_Paulo",
  "agent": "qwen3",
  "workspace": "/home/usuario/Projects/meu-projeto",
  "prompt": "Resuma o que mudou no git log de ontem.",
  "mode": "draft",
  "budget": { "run_usd": 0.2, "day_usd": 0.5 },
  "overlap": "skip",
  "missed": "skip",
  "enabled": true
}
```

## Protocolo

WebSocket em `ws://host:porta/ws`, quadros JSON definidos em
`@agent-hub/core` (`protocol/frames.ts`). O primeiro quadro autentica: token do
daemon, credencial de dispositivo ou, na propria maquina, a credencial entregue
por `GET /pair/local`, que so responde para loopback e para a propria interface.
Cada evento de run leva `seq` por sessao, para o cliente retomar do ponto onde
parou depois de cair.

## Estrutura

```
src/
  cli.ts          comandos acima
  server.ts       Fastify e WebSocket, interface estatica, pareamento local, A2A, callbacks de OAuth
  hub.ts          quadros do protocolo para sockets locais e canais do relay
  runtime.ts      roteamento, runs, cascata, fallback, delegacao, retomada, classificador e melhorador
  store.ts, db.ts SQLite: sessoes, mensagens, eventos, ledger, midia por hash e migracoes
  approvals.ts    fila de aprovacao com expiracao
  auth.ts         senha com scrypt e credencial por dispositivo
  secrets.ts      cofre cifrado das chaves
  connectors.ts   leitura e gravacao do mcp.json, importacao do Claude Code
  mcp-oauth.ts    fluxo OAuth dos servidores MCP remotos
  automation.ts   execucao comum de agendamentos e gatilhos
  schedules.ts    agendamentos por cron
  triggers.ts     gatilhos com assinatura por fonte, filtro e deduplicacao
  webhooks.ts     webhooks de saida no formato Standard Webhooks
  workflows.ts    motor de workflows com checkpoint
  worktrees.ts    worktree git isolada para subagente
  terminals.ts    terminais reais por sessao
  relay.ts        conexao de saida com o relay
  a2a.ts          cartao do agente e JSON-RPC do protocolo A2A
  mcp-server.ts   servidor MCP por stdio
  otel.ts, push.ts OpenTelemetry e notificacoes push
```

## Servidor MCP para outros clientes

`agent-hub-daemon mcp` expoe o daemon por stdio com as ferramentas
`list_agents`, `list_sessions`, `run_agent` e `cost_report`. Assim o Claude
Code ou o Claude Desktop disparam seus agentes nesta maquina:

```json
{
  "mcpServers": {
    "agent-hub": {
      "command": "node",
      "args": ["/caminho/agent-hub/daemon/dist/cli.js", "mcp"]
    }
  }
}
```

`run_agent` roda em modo `draft` por padrao (sem escrita nem execucao).
`normal` segue a politica do perfil e aprovacoes pendentes expiram em
`approval_timeout_ms`; `auto_approve` libera tudo, exceto padroes destrutivos,
que continuam pedindo aprovacao.

## Fases por perfil

Um perfil com `phases` expoe ao modelo apenas as ferramentas da fase atual e
avanca quando a ferramenta de sinal (`plan`, `done`) e chamada ou quando
`max_steps` da fase termina.

## Workflows

`agents/workflows/*.yaml` descrevem sequencias fixas: etapas `tool` rodam sem
modelo, etapas `agent` chamam um perfil com ferramentas restritas e podem exigir
`output_schema`, etapas `gate` param para o usuario decidir quando a confianca
fica abaixo do limiar. O custo maximo e calculado antes de rodar, e um workflow
interrompido continua do ultimo checkpoint com `--continuar`.

## Sandbox por container

Perfil com `sandbox: { image: "node:22", network: false }` executa
`run_command` dentro de `docker run --rm` com o workspace montado em
`/workspace`. Execucao `allow` em perfil sem sandbox e rebaixada para `ask`.

## Delegacao

Um perfil com `delegates: [outro]` ganha `delegate`, `spawn` e `collect`. O run
filho roda com o outro perfil, sem o historico da sessao, opcionalmente numa
worktree git isolada. O custo do filho entra no run pai.

## Observabilidade e notificacoes

- `otel_endpoint` no config (ou `OTEL_EXPORTER_OTLP_ENDPOINT`) liga um span por
  chamada ao modelo e por ferramenta, em OTLP/HTTP com atributos `gen_ai.*`.
- Push do PWA: chaves VAPID em `~/.agent-hub/vapid.json`, envio em aprovacao
  pendente, fim de run e automacao concluida.

## Acesso remoto

Com `relay_url` no config, o daemon abre conexao de saida para o relay e passa a
receber clientes e webhooks por la. Gatilhos ficam em `agents/triggers/*.json`
ou pela interface; o relay os recebe em `POST /hooks/<device_id>/<trigger_id>`.

## Parte do Agent Hub

Este repositorio e uma das partes do [Agent Hub](https://github.com/raylison100/agent-hub),
um gerenciador de modelos de IA que roda na sua maquina. A documentacao geral
esta na [wiki](https://github.com/raylison100/agent-hub/wiki).

| Repositorio | Papel |
|---|---|
| [agent-hub](https://github.com/raylison100/agent-hub) | ponto de partida, Makefile, scripts e wiki |
| [agent-hub-core](https://github.com/raylison100/agent-hub-core) | biblioteca TypeScript: adaptadores, laco do agente, custo, roteamento, ferramentas, protocolo |
| [agent-hub-daemon](https://github.com/raylison100/agent-hub-daemon) | servico local: sessoes, runs, aprovacoes, automacao, conectores, API WebSocket |
| [agent-hub-web](https://github.com/raylison100/agent-hub-web) | interface Vue 3 como PWA, a mesma no navegador, no celular e no desktop |
| [agent-hub-agents](https://github.com/raylison100/agent-hub-agents) | perfis, papeis, skills, workflows, precos, roteamento e politicas, em texto |
| [agent-hub-desktop](https://github.com/raylison100/agent-hub-desktop) | app Tauri 2 para Windows e Linux |
| [agent-hub-relay](https://github.com/raylison100/agent-hub-relay) | retransmissor sem estado para acesso remoto |
| [agent-hub-channels](https://github.com/raylison100/agent-hub-channels) | clientes em plataformas de mensagem, hoje Telegram |
| [agent-hub-docs](https://github.com/raylison100/agent-hub-docs) | planejamento, arquitetura, ADRs e a fonte das paginas da wiki |

## Licenca

[PolyForm Noncommercial 1.0.0](LICENSE). Pode ler, estudar, modificar e usar
para fins pessoais, de pesquisa, ensino ou em organizacao sem fins lucrativos.
Uso comercial nao e permitido sem autorizacao do autor.

Required Notice: Copyright (c) 2026 Raylison Nunes (https://github.com/raylison100)
