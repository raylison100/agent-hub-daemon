import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const serviceName = 'agent-hub.service'

const foraDoModelo = new Set(['.git', 'node_modules', 'schedules', 'mcp.json', '.plugins'])

export interface StepResult {
  ok: boolean
  detail: string
}

/** Caminho do cli.js que esta rodando agora, usado no ExecStart do servico. */
export function currentCli(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url))
}

/** Pasta com o modelo de agentes: dentro do pacote ou, no repositorio de desenvolvimento, o agents ao lado. */
export function agentsTemplateDir(): string | undefined {
  const candidatos = [new URL('../agents-modelo', import.meta.url), new URL('../../agents', import.meta.url)].map((u) => resolve(fileURLToPath(u)))
  return candidatos.find((c) => existsSync(join(c, 'profiles')))
}

/** Confere se os modulos nativos carregam neste Node; quando nao carregam, a instalacao nao compilou. */
export async function checkNative(): Promise<StepResult> {
  const falhas: string[] = []
  for (const nome of ['better-sqlite3', 'node-pty']) {
    try {
      await import(nome)
    } catch (err) {
      falhas.push(`${nome}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }
  if (falhas.length === 0) return { ok: true, detail: 'better-sqlite3 e node-pty carregam' }
  return {
    ok: false,
    detail:
      `modulos nativos nao carregam (${falhas.join('; ')}). Instale as ferramentas de compilacao ` +
      '(no Ubuntu: sudo apt install -y build-essential python3) e reinstale o pacote.',
  }
}

/** config.toml inicial desta maquina: agentes em ~/.agent-hub/agents e a pasta Projects liberada quando existir. */
export function initialConfig(home: string): string {
  const projetos = join(homedir(), 'Projects')
  const workspace = existsSync(projetos) ? projetos : homedir()
  return [
    `agents_dir = ${JSON.stringify(join(home, 'agents'))}`,
    'host = "127.0.0.1"',
    'port = 47311',
    `workspaces = [${JSON.stringify(workspace)}]`,
    'approval_timeout_ms = 600000',
    `device_name = ${JSON.stringify(hostname())}`,
    '# relay_url = "wss://relay.exemplo.com"',
    '',
  ].join('\n')
}

/** Grava o config.toml quando ainda nao existe; nunca sobrescreve. */
export function ensureConfig(home: string): StepResult {
  const file = join(home, 'config.toml')
  if (existsSync(file)) return { ok: true, detail: `mantido ${file}` }
  mkdirSync(home, { recursive: true })
  writeFileSync(file, initialConfig(home))
  return { ok: true, detail: `criado ${file}` }
}

/** Copia o modelo de agentes para a pasta configurada quando ela ainda nao existe; nunca mistura com uma existente. */
export function ensureAgents(agentsDir: string, template: string | undefined): StepResult {
  if (existsSync(agentsDir) && readdirSync(agentsDir).length > 0) return { ok: true, detail: `mantido ${agentsDir}` }
  if (!template) return { ok: false, detail: 'modelo de agentes nao encontrado no pacote' }
  mkdirSync(agentsDir, { recursive: true })
  for (const item of readdirSync(template)) {
    if (foraDoModelo.has(item)) continue
    cpSync(join(template, item), join(agentsDir, item), { recursive: true })
  }
  return { ok: true, detail: `agentes iniciais copiados para ${agentsDir}` }
}

/** Unidade do systemd de usuario apontando para este Node e este cli, com o PATH que acha o node e o npx. */
export function serviceUnit(nodePath: string, cliPath: string, home: string, agentHubHome?: string): string {
  const path = [...new Set([dirname(nodePath), '/usr/local/bin', '/usr/bin', '/bin'])].join(':')
  return [
    '[Unit]',
    'Description=Agent Hub, daemon local',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${homedir()}`,
    `ExecStart=${nodePath} ${cliPath} start`,
    `Environment=PATH=${path}`,
    'Environment=OLLAMA_BASE_URL=http://127.0.0.1:11434/v1',
    ...(agentHubHome ? [`Environment=AGENT_HUB_HOME=${agentHubHome}`] : []),
    'Restart=always',
    'RestartSec=2',
    `StandardOutput=append:${join(home, 'daemon.log')}`,
    `StandardError=append:${join(home, 'daemon.log')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', serviceName)
}

/** Se ha systemd de usuario respondendo nesta sessao. */
export function systemdAvailable(): boolean {
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' })
  return r.status === 0
}

/** Caminho do cli para onde o servico instalado aponta, quando ha um. */
export function serviceTarget(): string | undefined {
  const file = unitPath()
  if (!existsSync(file)) return undefined
  const linha = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('ExecStart='))
  return linha?.split(' ')[1]
}

/** Grava a unidade, recarrega o systemd, habilita, reinicia e liga o linger. */
export function installService(home: string): StepResult {
  if (!systemdAvailable()) return { ok: false, detail: 'systemd de usuario indisponivel; rode "agent-hub start" em segundo plano ou habilite o systemd (no WSL, em /etc/wsl.conf)' }
  const file = unitPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, serviceUnit(process.execPath, currentCli(), home, process.env.AGENT_HUB_HOME))
  for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', serviceName], ['--user', 'restart', serviceName]]) {
    const r = spawnSync('systemctl', args, { encoding: 'utf8' })
    if (r.status !== 0) return { ok: false, detail: `systemctl ${args.join(' ')} falhou: ${(r.stderr || r.stdout).trim()}` }
  }
  const linger = spawnSync('loginctl', ['enable-linger', userInfo().username], { stdio: 'ignore' })
  return { ok: true, detail: `servico ${serviceName} ativo${linger.status === 0 ? ' e sobe com a maquina' : '; sem linger, so sobe quando voce abre uma sessao'}` }
}

/** Espera o daemon responder em /health. */
export async function waitHealth(host: string, port: number, timeoutMs = 20000): Promise<StepResult> {
  const fim = Date.now() + timeoutMs
  while (Date.now() < fim) {
    const ok = await fetch(`http://${host}:${port}/health`).then((r) => r.ok).catch(() => false)
    if (ok) return { ok: true, detail: `daemon respondendo em http://${host}:${port}` }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, detail: `daemon nao respondeu em http://${host}:${port}/health; veja o daemon.log` }
}
