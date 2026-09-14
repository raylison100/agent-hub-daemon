#!/usr/bin/env bash
# Monta o pacote instalavel do Agent Hub: daemon, core embutido, interface e modelo de agentes num .tgz.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist-pacote"
STAGE="$OUT/agent-hub"

for obrigatorio in core/dist daemon/dist web/dist/index.html agents/profiles; do
  [ -e "$ROOT/$obrigatorio" ] || { echo "falta $obrigatorio; rode make build e clonar-tudo.sh antes" >&2; exit 1; }
done

rm -rf "$STAGE"
mkdir -p "$STAGE/node_modules/@agent-hub/core"

cp -r "$ROOT/daemon/dist" "$STAGE/dist"
cp -r "$ROOT/web/dist" "$STAGE/web"
cp "$ROOT/daemon/LICENSE" "$STAGE/LICENSE"
cp -r "$ROOT/core/dist" "$STAGE/node_modules/@agent-hub/core/dist"
cp "$ROOT/core/LICENSE" "$STAGE/node_modules/@agent-hub/core/LICENSE"

mkdir -p "$STAGE/agents-modelo"
for item in "$ROOT"/agents/*; do
  nome="$(basename "$item")"
  case "$nome" in schedules|mcp.json|node_modules) continue ;; esac
  cp -r "$item" "$STAGE/agents-modelo/$nome"
done

node --input-type=module - "$ROOT" "$STAGE" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
const [root, stage] = process.argv.slice(2)
const ler = (p) => JSON.parse(readFileSync(p, 'utf8'))
const daemon = ler(`${root}/daemon/package.json`)
const core = ler(`${root}/core/package.json`)

const coreEmbutido = {
  name: core.name,
  version: core.version,
  type: core.type,
  main: core.main,
  types: core.types,
  exports: core.exports,
  license: core.license,
}
writeFileSync(`${stage}/node_modules/@agent-hub/core/package.json`, JSON.stringify(coreEmbutido, null, 2) + '\n')

const dependencias = { ...core.dependencies }
for (const [nome, versao] of Object.entries(daemon.dependencies)) {
  if (nome === '@agent-hub/core') continue
  dependencias[nome] = versao
}
dependencias['@agent-hub/core'] = core.version

const pacote = {
  name: 'agent-hub',
  version: daemon.version,
  description: 'Gerenciador de modelos de IA que roda na sua maquina',
  license: daemon.license,
  author: daemon.author,
  homepage: 'https://github.com/raylison100/agent-hub/wiki',
  repository: { type: 'git', url: 'https://github.com/raylison100/agent-hub.git' },
  type: 'module',
  bin: { 'agent-hub': './dist/bin.js' },
  engines: daemon.engines,
  files: ['dist', 'web', 'agents-modelo', 'LICENSE', 'README.md'],
  dependencies: Object.fromEntries(Object.entries(dependencias).sort(([a], [b]) => a.localeCompare(b))),
  bundleDependencies: ['@agent-hub/core'],
}
writeFileSync(`${stage}/package.json`, JSON.stringify(pacote, null, 2) + '\n')
JS

cat > "$STAGE/README.md" <<'MD'
# agent-hub

Pacote instalavel do Agent Hub: daemon, interface web e agentes iniciais.

```bash
npm install -g ./agent-hub-VERSAO.tgz
agent-hub instalar
```

Documentacao em https://github.com/raylison100/agent-hub/wiki

Licenca PolyForm Noncommercial 1.0.0: uso comercial nao e permitido.

Required Notice: Copyright (c) 2026 Raylison Nunes (https://github.com/raylison100)
MD

chmod +x "$STAGE/dist/bin.js"
(cd "$STAGE" && npm pack --silent --pack-destination "$OUT" >/dev/null)
ls -la "$OUT"/*.tgz
