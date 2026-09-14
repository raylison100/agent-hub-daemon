import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(`${process.env.ROOT}/daemon/package.json`)
const Database = require('better-sqlite3')
const { NodeDaemonClient } = await import(`${process.env.ROOT}/core/dist/index.js`)
const { Convidados } = await import(`${process.env.ROOT}/daemon/dist/compartilhar.js`)
const { SecretStore } = await import(`${process.env.ROOT}/daemon/dist/secrets.js`)

const ok = (cond, texto) => console.log(`${cond ? 'PASSOU' : 'FALHOU'}  ${texto}`)
async function cliente(papel, porta) {
  const c = new NodeDaemonClient({ url: `ws://127.0.0.1:${porta}/ws`, token: readFileSync(`/tmp/ah-${papel}/token`, 'utf8').trim(), client: 'seguranca' })
  c.start(); await c.ready(); return c
}
const anfitriao = await cliente('anfitriao', 47411)
const convidado = await cliente('convidado', 47412)
const recebidoAtual = (await convidado.request({ type: 'recebidos.listar' }, 'recebidos.lista')).recebidos[0]
const shim = `http://127.0.0.1:47412/compartilhado/${recebidoAtual.id}/v1/chat/completions`
const pedir = (model, extra = {}) => fetch(shim, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'responda so: ok' }], max_tokens: 5, reasoning_effort: 'none', ...extra }) }).then(async (r) => ({ status: r.status, corpo: await r.text() }))

const naoLiberado = await pedir('modelo-que-nao-foi-liberado')
ok(naoLiberado.status === 403 && naoLiberado.corpo.includes('nao foi compartilhado'), `1. modelo nao liberado recusado (${naoLiberado.status}: ${naoLiberado.corpo.slice(0, 80)})`)

const db = new Database(':memory:')
const pasta = mkdtempSync(join(tmpdir(), 'ah-seg-'))
const secrets = new SecretStore(pasta, db, {})
const avulso = new Convidados({ db, secrets, porta: 1, log: () => undefined })
const criadoAvulso = await anfitriao.request({ type: 'compartilhar.criar', nome: 'Pequeno limite', modelos: [process.env.MODELO], limite_tokens_dia: 50, janela: 8192 }, 'compartilhar.criado')
await new Promise((r) => setTimeout(r, 1500))
const rAvulso = avulso.adicionar(criadoAvulso.convite, true)
const viaTunel = (metodo, caminho, corpo) => new Promise((resolve) => {
  let status = 0; let texto = ''
  avulso.encaminhar(rAvulso.id, metodo, caminho, corpo, { resposta: (s) => (status = s), pedaco: (d) => (texto += d), fim: () => resolve({ status, texto }), erro: (m) => resolve({ status: -1, texto: m }) })
})
const pull = await viaTunel('POST', '/api/pull', JSON.stringify({ name: 'llama3:70b' }))
ok(pull.status === 404, `2. caminho nao liberado (/api/pull) recusado (${pull.status}: ${pull.texto.slice(0, 70)})`)
const tags = await viaTunel('GET', '/api/tags')
ok(tags.status === 404, `2b. listar todos os modelos do anfitriao (/api/tags) recusado (${tags.status})`)

const corpoChat = JSON.stringify({ model: process.env.MODELO, messages: [{ role: 'user', content: 'conte ate vinte por extenso' }], max_tokens: 200, reasoning_effort: 'none' })
const primeiro = await viaTunel('POST', '/v1/chat/completions', corpoChat)
const segundo = await viaTunel('POST', '/v1/chat/completions', corpoChat)
ok(primeiro.status === 200 && segundo.status === 429 && segundo.texto.includes('limite diario'), `3. limite diario: primeiro ${primeiro.status}, segundo ${segundo.status} (${segundo.texto.slice(0, 70)})`)

const [a, b] = await Promise.all([pedir(process.env.MODELO, { max_tokens: 60, messages: [{ role: 'user', content: 'escreva tres frases sobre o mar' }] }), new Promise((r) => setTimeout(r, 300)).then(() => pedir(process.env.MODELO))])
ok([a.status, b.status].sort().join(',') === '200,429', `4. dois pedidos ao mesmo tempo: ${a.status} e ${b.status}`)

const lista = await anfitriao.request({ type: 'compartilhar.listar' }, 'compartilhar.lista')
const principal = lista.convidados.find((c) => c.nome === 'Amigo de teste')
await anfitriao.request({ type: 'compartilhar.revogar', id: principal.id }, 'compartilhar.lista')
await new Promise((r) => setTimeout(r, 1500))
const aposRevogar = await convidado.request({ type: 'recebidos.testar', id: recebidoAtual.id }, 'recebidos.teste', 30000)
ok(!aposRevogar.ok, `5. apos revogar, o convidado nao conecta: ${aposRevogar.detalhe}`)
const chatRevogado = await pedir(process.env.MODELO)
ok(chatRevogado.status === 502, `5b. chamada do agente revogado falha com mensagem clara (${chatRevogado.status}: ${chatRevogado.corpo.slice(0, 90)})`)

const pid = readFileSync('/tmp/ah-convidado.pid', 'utf8').trim()
const ambiente = readFileSync(`/proc/${pid}/environ`, 'utf8')
const salaAvulsa = JSON.parse(Buffer.from(criadoAvulso.convite.slice('agenthub-convite-1.'.length), 'base64url').toString()).sala
const salaPrincipal = JSON.parse(Buffer.from(readFileSync('/tmp/ah-convite.txt', 'utf8').trim().slice('agenthub-convite-1.'.length), 'base64url').toString()).sala
ok(!ambiente.includes(salaPrincipal) && !ambiente.includes(salaAvulsa), '7. token da sala ausente do ambiente do processo do convidado (MCP nao herda)')
const bancoConvidado = readFileSync('/tmp/ah-convidado/agent-hub.sqlite')
ok(!bancoConvidado.includes(Buffer.from(salaPrincipal)), '7b. token da sala nao aparece em claro no banco do convidado')

avulso.parar(); anfitriao.stop(); convidado.stop(); process.exit(0)
