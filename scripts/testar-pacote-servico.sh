#!/usr/bin/env bash
# Confere o caminho do servico com um systemctl falso que registra as chamadas, e a recusa de trocar servico alheio.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACOTE="$(ls -t "$ROOT"/dist-pacote/agent-hub-*.tgz | head -1)"
IMAGEM="${IMAGEM:-node:24-bookworm}"

docker run --rm -v "$PACOTE:/tmp/agent-hub.tgz:ro" "$IMAGEM" bash -c '
set -e
npm install -g --no-audit --no-fund /tmp/agent-hub.tgz >/dev/null 2>&1
mkdir -p /fake
cat > /fake/systemctl <<"SC"
#!/usr/bin/env bash
echo "systemctl $*" >> /tmp/chamadas
if [ "$*" = "--user restart agent-hub.service" ]; then
  (agent-hub start > /tmp/daemon.log 2>&1 &)
fi
exit 0
SC
printf "#!/usr/bin/env bash\necho \"loginctl \$*\" >> /tmp/chamadas\n" > /fake/loginctl
chmod +x /fake/systemctl /fake/loginctl
export PATH=/fake:$PATH

echo "== servico de outra instalacao e recusado"
mkdir -p /root/.config/systemd/user
printf "[Service]\nExecStart=/usr/bin/node /outro/lugar/cli.js start\n" > /root/.config/systemd/user/agent-hub.service
agent-hub instalar | tail -1 || true

echo "== com --substituir-servico instala, sobe e confere a saude"
agent-hub instalar --substituir-servico
echo "== chamadas feitas"
cat /tmp/chamadas
echo "== unidade gravada"
grep -E "ExecStart|PATH" /root/.config/systemd/user/agent-hub.service
'
