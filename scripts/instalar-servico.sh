#!/usr/bin/env bash
# Instala o daemon como servico de usuario do systemd, para ele subir com a maquina
# e voltar sozinho depois de reiniciar pela interface.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIDADE="$HOME/.config/systemd/user/agent-hub.service"

command -v systemctl >/dev/null || { echo "systemd nao esta disponivel neste sistema" >&2; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node nao encontrado no PATH; rode com o nvm carregado" >&2; exit 1; }

mkdir -p "$(dirname "$UNIDADE")"
cat > "$UNIDADE" <<UNIT
[Unit]
Description=Agent Hub, daemon local
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/daemon/dist/cli.js start
Environment=OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
Restart=always
RestartSec=2
StandardOutput=append:$HOME/.agent-hub/daemon.log
StandardError=append:$HOME/.agent-hub/daemon.log

[Install]
WantedBy=default.target
UNIT

mkdir -p "$HOME/.agent-hub"
systemctl --user daemon-reload
systemctl --user enable --now agent-hub.service
loginctl enable-linger "$USER" >/dev/null 2>&1 || echo "aviso: sem linger, o servico so sobe quando voce abre o WSL"
sleep 2
systemctl --user --no-pager status agent-hub.service | head -8
echo
echo "log em ~/.agent-hub/daemon.log"
echo "parar: systemctl --user stop agent-hub   |   desinstalar: systemctl --user disable --now agent-hub"
