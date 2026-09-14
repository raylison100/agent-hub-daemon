#!/usr/bin/env bash
# Instala o pacote local fingindo uma versao antiga e confere que o daemon se atualiza sozinho para a ultima Release publicada.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACOTE="$(ls -t "$ROOT"/dist-pacote/agent-hub-*.tgz | head -1)"
IMAGEM="${IMAGEM:-node:24-bookworm}"
echo "pacote: $(basename "$PACOTE") | imagem: $IMAGEM"

docker run --rm -v "$PACOTE:/tmp/agent-hub.tgz:ro" "$IMAGEM" bash -c '
set -e
npm install -g --no-audit --no-fund /tmp/agent-hub.tgz >/dev/null 2>&1
RAIZ="$(npm root -g)/agent-hub"
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"0.0.1\"/" "$RAIZ/package.json"

mkdir -p /fake
cat > /fake/systemctl <<"SC"
#!/usr/bin/env bash
echo "systemctl $*" >> /tmp/chamadas
if [ "$*" = "--user restart agent-hub.service" ]; then
  kill "$(cat /tmp/daemon.pid)" 2>/dev/null || true
  sleep 1
  (INVOCATION_ID=teste agent-hub start >> /tmp/daemon.log 2>&1 & echo $! > /tmp/daemon.pid)
fi
exit 0
SC
cat > /fake/systemd-run <<"SR"
#!/usr/bin/env bash
echo "systemd-run $*" >> /tmp/chamadas
[ "$1" = "--version" ] && exit 0
while [ $# -gt 0 ]; do
  case "$1" in
    -p) shift 2 ;;
    --setenv=*) export "${1#--setenv=}"; shift ;;
    -*) shift ;;
    *) break ;;
  esac
done
unset INVOCATION_ID
("$@" >> /tmp/atualizacao.log 2>&1 &)
SR
printf "#!/usr/bin/env bash\nexit 0\n" > /fake/loginctl
chmod +x /fake/*
export PATH=/fake:$PATH

agent-hub instalar --sem-servico >/dev/null
(INVOCATION_ID=teste agent-hub start > /tmp/daemon.log 2>&1 & echo $! > /tmp/daemon.pid)
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:47311/health && break; sleep 0.5; done

cat > /tmp/cliente.mjs <<"JS"
import { readFileSync } from "node:fs"
const { NodeDaemonClient } = await import(`${process.env.RAIZ}/node_modules/@agent-hub/core/dist/index.js`)
const token = readFileSync("/root/.agent-hub/token", "utf8").trim()
const c = new NodeDaemonClient({ url: "ws://127.0.0.1:47311/ws", token, client: "teste-atualizacao" })
c.start()
await c.ready()
const antes = await c.request({ type: "versao.consultar", forcar: true }, "versao.estado")
console.log("antes:", JSON.stringify(antes.estado))
if (!antes.estado.pode_atualizar) { console.log("FALHA: deveria poder atualizar"); process.exit(1) }
const depois = await c.request({ type: "versao.atualizar" }, "versao.estado")
console.log("disparado:", depois.estado.atualizando, depois.estado.detalhe)
process.exit(0)
JS
RAIZ="$RAIZ" node /tmp/cliente.mjs

echo "== esperando a instalacao da versao nova"
for i in $(seq 1 180); do
  v=$(node -p "require(\"$RAIZ/package.json\").version" 2>/dev/null || echo "?")
  [ "$v" != "0.0.1" ] && [ "$v" != "?" ] && grep -qE "daemon respondendo|daemon nao respondeu" /tmp/atualizacao.log 2>/dev/null && break
  sleep 1
done
echo "versao instalada agora: $v"
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:47311/health && break; sleep 0.5; done
echo "== chamadas"
cat /tmp/chamadas
echo "== registro da atualizacao"
tail -5 /tmp/atualizacao.log
echo "== modulos nativos da versao nova"
(cd "$RAIZ" && node -e "import(\"node-pty\").then(()=>console.log(\"node-pty carrega\"))")
echo "== saude depois de reiniciar"
curl -s http://127.0.0.1:47311/health; echo
grep -q "restart agent-hub.service" /tmp/chamadas || { echo "FALHA: servico nao reiniciou"; exit 1; }
grep -q "ok: daemon respondendo" /tmp/atualizacao.log || { echo "FALHA: daemon novo nao respondeu"; exit 1; }
[ "$v" != "0.0.1" ] && echo "== TUDO OK" || { echo "FALHA"; exit 1; }
'
