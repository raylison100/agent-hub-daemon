import { createRequire } from 'node:module'
const require = createRequire(`${process.env.ROOT}/daemon/package.json`)
const Database = require('better-sqlite3')
const { SecretStore } = await import(`${process.env.ROOT}/daemon/dist/secrets.js`)
const { codificarConvite } = await import(`${process.env.ROOT}/daemon/dist/compartilhar.js`)
const db = new Database('/tmp/ah-anfitriao/agent-hub.sqlite', { readonly: true })
const s = new SecretStore('/tmp/ah-anfitriao', db, {})
const row = db.prepare("SELECT * FROM convidados WHERE nome = 'Amigo de teste'").get()
console.log(codificarConvite({ v: 1, relay: 'ws://127.0.0.1:8787', sala: s.unseal(row.sala), dispositivo: row.dispositivo, anfitriao: 'x', modelos: [{ nome: process.env.MODELO, janela: 8192 }], limite_tokens_dia: 1 }))
