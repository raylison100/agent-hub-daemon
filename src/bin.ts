#!/usr/bin/env node
import { checkNative } from './install.js'

const nativo = await checkNative()
if (!nativo.ok) {
  console.error(`falha: ${nativo.detail}`)
  process.exit(1)
}
await import('./cli.js')
