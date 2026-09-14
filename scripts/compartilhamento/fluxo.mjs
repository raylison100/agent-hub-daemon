import { readFileSync } from 'node:fs'
const { NodeDaemonClient } = await import(`${process.env.ROOT}/core/dist/index.js`)

async function cliente(papel, porta) {
  const token = readFileSync(`/tmp/ah-${papel}/token`, 'utf8').trim()
  const c = new NodeDaemonClient({ url: `ws://127.0.0.1:${porta}/ws`, token, client: `teste-${papel}` })
  c.start()
  await c.ready()
  return c
}
const anfitriao = await cliente('anfitriao', 47411)
const convidado = await cliente('convidado', 47412)
const log = (...a) => console.log(...a)

const lista = await anfitriao.request({ type: 'compartilhar.listar' }, 'compartilhar.lista')
log('1. anfitriao: relay configurado', lista.relay_configurado, '| modelos locais', lista.modelos_locais.join(', '))

const criado = await anfitriao.request({ type: 'compartilhar.criar', nome: 'Amigo de teste', modelos: [process.env.MODELO], limite_tokens_dia: 60000, janela: 8192 }, 'compartilhar.criado')
log('2. convite criado:', criado.convite.slice(0, 40) + '...', '| tamanho', criado.convite.length)
await new Promise((r) => setTimeout(r, 1500))

const recebidos = await convidado.request({ type: 'recebidos.adicionar', convite: criado.convite, no_roteamento: true }, 'recebidos.lista')
const recebido = recebidos.recebidos[0]
log('3. convidado recebeu:', recebido.anfitriao, '| agentes', recebido.agentes.join(', '))

const teste = await convidado.request({ type: 'recebidos.testar', id: recebido.id }, 'recebidos.teste', 30000)
log('4. teste de conexao:', teste.ok, teste.detalhe, `${teste.ms} ms`)

const agentes = await convidado.request({ type: 'agents.list' }, 'agents.list')
log('5. agente aparece no convidado:', agentes.agents.some((a) => a.name === recebido.agentes[0]))

const sessao = await convidado.request({ type: 'session.create', agent: recebido.agentes[0], workspace: '/tmp/ah-ws-convidado', title: 'teste compartilhado' }, 'session.created')
const sid = sessao.session.id
let texto = ''
const ferramentas = []
const fim = new Promise((resolve) => {
  convidado.on((f) => {
    if (f.type !== 'event' || f.session_id !== sid) return
    if (f.event.type === 'text_delta') texto += f.event.delta
    if (f.event.type === 'tool_call') ferramentas.push(f.event.call.name)
    if (f.event.type === 'usage') log(`   passo ${f.event.step}: ${f.event.model}, entrada ${f.event.usage.input}, saida ${f.event.usage.output}, ${f.event.costUsd} USD, ${f.event.latencyMs} ms`)
    if (f.event.type === 'run_finished') resolve(f.event)
  })
})
const t0 = Date.now()
convidado.send({ type: 'run.start', session_id: sid, text: 'Leia o arquivo nota.txt deste workspace e me diga qual e a palavra combinada.', improve: false, mode: 'auto_approve' })
const r = await Promise.race([fim, new Promise((res) => setTimeout(() => res({ stop: 'timeout' }), 180000))])
log(`6. run no convidado: ${r.stop} em ${Math.round((Date.now() - t0) / 1000)} s | ferramentas: ${ferramentas.join(', ')}`)
log('   resposta:', texto.trim().slice(0, 300))
log('   achou a palavra do arquivo do convidado:', texto.includes('jabuticaba-azul-47'))

const depois = await anfitriao.request({ type: 'compartilhar.listar' }, 'compartilhar.lista')
log('7. anfitriao ve o uso:', depois.convidados.map((c) => `${c.nome}: ${c.uso_hoje} tokens de ${c.limite_tokens_dia}, conectado ${c.conectado}`).join(' | '))
process.env.CONVITE = criado.convite
console.log('ID_CONVIDADO=' + depois.convidados[0].id + ' ID_RECEBIDO=' + recebido.id)
anfitriao.stop(); convidado.stop(); process.exit(0)
