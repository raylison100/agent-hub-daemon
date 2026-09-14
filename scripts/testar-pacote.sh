#!/usr/bin/env bash
# Instala o pacote num container limpo, sem nenhum repositorio, e confere instalacao, agentes, interface e saude.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACOTE="$(ls -t "$ROOT"/dist-pacote/agent-hub-*.tgz | head -1)"
IMAGEM="${IMAGEM:-node:24-bookworm}"
echo "pacote: $(basename "$PACOTE") | imagem: $IMAGEM"

docker run --rm -v "$PACOTE:/tmp/agent-hub.tgz:ro" "$IMAGEM" bash -c '
set -e
cd /root
mkdir -p /root/Projects/meu-projeto
echo "== npm install -g"
npm install -g --no-audit --no-fund /tmp/agent-hub.tgz 2>&1 | tail -3
echo "== onde ficou"
ls "$(npm root -g)/agent-hub"
echo "== agent-hub instalar --sem-servico"
agent-hub instalar --sem-servico
echo "== config gerado"
cat /root/.agent-hub/config.toml
echo "== agentes copiados"
ls /root/.agent-hub/agents
test ! -e /root/.agent-hub/agents/schedules && test ! -e /root/.agent-hub/agents/mcp.json && echo "sem schedules e sem mcp.json"
echo "== segunda execucao nao sobrescreve"
echo "# marca" >> /root/.agent-hub/config.toml
agent-hub instalar --sem-servico | grep -E "configuracao|agentes"
grep -q "# marca" /root/.agent-hub/config.toml && echo "config preservado"
echo "== agentes carregados"
agent-hub agents 2>&1 | head -12
echo "== subir e testar saude e interface"
agent-hub start > /tmp/daemon.log 2>&1 &
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:47311/health && break; sleep 0.5; done
curl -s http://127.0.0.1:47311/health; echo
curl -s http://127.0.0.1:47311/ | grep -o "<title>[^<]*" || { echo "interface nao respondeu"; cat /tmp/daemon.log; exit 1; }
echo "== unidade do systemd que seria gravada"
node --input-type=module -e "const m = await import(process.argv[1]); console.log(m.serviceUnit(process.execPath, m.currentCli(), \"/root/.agent-hub\"))" "$(npm root -g)/agent-hub/dist/install.js"
echo "== TUDO OK"
'
