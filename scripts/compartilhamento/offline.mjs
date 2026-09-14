import { readFileSync } from 'node:fs'
const { NodeDaemonClient } = await import(`${process.env.ROOT}/core/dist/index.js`)
const c = new NodeDaemonClient({ url: 'ws://127.0.0.1:47412/ws', token: readFileSync('/tmp/ah-convidado/token', 'utf8').trim(), client: 'offline' })
c.start(); await c.ready()
const add = await c.request({ type: 'recebidos.listar' }, 'recebidos.lista')
const alvo = add.recebidos[add.recebidos.length - 1]
const t = await c.request({ type: 'recebidos.testar', id: alvo.id }, 'recebidos.teste', 30000)
console.log(`${!t.ok ? 'PASSOU' : 'FALHOU'}  6. com o anfitriao desligado o teste falha com: ${t.detalhe}`)
c.stop(); process.exit(0)
