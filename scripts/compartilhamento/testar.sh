#!/usr/bin/env bash
# Teste de ponta a ponta do compartilhamento de modelos: relay local, daemon anfitriao e daemon convidado temporarios,
# fluxo completo e os testes de seguranca. Precisa do Ollama em 127.0.0.1:11434 com o modelo de MODELO.
set -euo pipefail
export ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
export MODELO="${MODELO:-qwen3:8b}"
AQUI="$ROOT/daemon/scripts/compartilhamento"

R="$ROOT"
pkill -f "[r]elay/dist/index.js" || true
pkill -f "[d]aemon/dist/bin.js start" || true
sleep 1
rm -rf /tmp/ah-anfitriao /tmp/ah-convidado /tmp/ah-ws-anfitriao /tmp/ah-ws-convidado
(cd $R/daemon && pnpm run build >/dev/null) && (cd $R/relay && pnpm run build >/dev/null)

mkdir -p /tmp/ah-ws-anfitriao /tmp/ah-ws-convidado
echo "A palavra combinada do teste e jabuticaba-azul-47." > /tmp/ah-ws-convidado/nota.txt

for papel in anfitriao convidado; do
  H=/tmp/ah-$papel
  mkdir -p $H
  cp -r $R/agents $H/agents
  rm -rf $H/agents/.git $H/agents/schedules
  porta=$([ $papel = anfitriao ] && echo 47411 || echo 47412)
  {
    echo "agents_dir = \"$H/agents\""
    echo 'host = "127.0.0.1"'
    echo "port = $porta"
    echo "workspaces = [\"/tmp/ah-ws-$papel\"]"
    echo "device_name = \"$papel-teste\""
    [ $papel = anfitriao ] && echo 'relay_url = "ws://127.0.0.1:8787"'
  } > $H/config.toml
done

setsid nohup env PORT=8787 HOST=127.0.0.1 node $R/relay/dist/index.js > /tmp/ah-relay.log 2>&1 < /dev/null &
sleep 1
for papel in anfitriao convidado; do
  setsid nohup env AGENT_HUB_HOME=/tmp/ah-$papel OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 node $R/daemon/dist/bin.js start > /tmp/ah-$papel.log 2>&1 < /dev/null &
done
for p in 47411 47412 8787; do
  for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:$p/health && break; sleep 0.5; done
  echo "porta $p: $(curl -s http://127.0.0.1:$p/health)"
done

echo "== fluxo"
node "$AQUI/fluxo.mjs"
echo "== seguranca"
pgrep -f "[d]aemon/dist/bin.js start" | while read -r p; do
  if tr '\0' '\n' < /proc/$p/environ | grep -q '^AGENT_HUB_HOME=/tmp/ah-convidado$'; then echo "$p" > /tmp/ah-convidado.pid; fi
done
node "$AQUI/extrair-convite.mjs" > /tmp/ah-convite.txt
node "$AQUI/seguranca.mjs"
echo "== anfitriao desligado"
pgrep -f "[d]aemon/dist/bin.js start" | while read -r p; do
  if tr '\0' '\n' < /proc/$p/environ | grep -q '^AGENT_HUB_HOME=/tmp/ah-anfitriao$'; then kill "$p"; fi
done
sleep 2
node "$AQUI/offline.mjs"
echo "== limpeza"
pkill -f "[r]elay/dist/index.js" || true
pkill -f "[d]aemon/dist/bin.js start" || true
rm -rf /tmp/ah-anfitriao /tmp/ah-convidado /tmp/ah-ws-anfitriao /tmp/ah-ws-convidado /tmp/ah-convite.txt /tmp/ah-convidado.pid
