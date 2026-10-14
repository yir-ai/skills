#!/usr/bin/env node
// Translate a fal request into a Yir Standard request, with a per-field difference report.
// Zero dependencies (Node.js 18+). translate.mjs and fal-dialect.json are copied from the Yir
// repository (scripts/channel-import); do not edit them here.
//
//   node scripts/from-fal.mjs <fal endpoint id> --json '<fal request body>' [--quote]
//   node scripts/from-fal.mjs <fal endpoint id> --file request.json [--quote]
//   node scripts/from-fal.mjs --list
//
// Exit codes: 0 translated (and quoted, with --quote), 1 needs changes, 2 usage error.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate } from './translate.mjs'

const BASE_URL = (process.env.YIR_BASE_URL || 'https://gateway.yir.ai').trim().replace(/\/+$/, '')
const HELP = `from-fal - translate a fal request into a Yir request

  node scripts/from-fal.mjs <fal endpoint id> --json '<body>' [--quote]
  node scripts/from-fal.mjs <fal endpoint id> --file request.json [--quote]
  node scripts/from-fal.mjs --list            list fal endpoints that map to a Yir model

Prints {ok, request, jobs, report, errors[, quote]}. "request" is the body for
POST /v1/images|videos/generations. "jobs" > 1 means submit that many Jobs.
--quote also asks Yir for a price (creates no Job, charges nothing; needs YIR_API_KEY).`

function usage(message) {
  console.error(message ? `${message}\n\n${HELP}` : HELP)
  process.exit(2)
}

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  if (value === undefined || value.startsWith('--')) usage(`${name} needs a value`)
  args.splice(i, 2)
  return value
}
if (args.includes('--help') || args.includes('-h')) usage()
const dialect = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fal-dialect.json'), 'utf8'))

if (args.includes('--list')) {
  const rows = Object.entries(dialect.endpoints).map(([endpoint, e]) => ({ fal: endpoint, yir: e.model, input: e.input_type, supported: !e.unsupported }))
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

const quote = args.includes('--quote')
if (quote) args.splice(args.indexOf('--quote'), 1)
const json = flag('--json')
const file = flag('--file')
const [endpoint, ...rest] = args
if (!endpoint || rest.length) usage(rest.length ? `unexpected argument ${rest[0]}` : 'missing fal endpoint id')
if (!json === !file) usage('pass the fal request body with exactly one of --json or --file')
let body
try {
  body = JSON.parse(json ?? (await readFile(file, 'utf8')))
} catch (error) {
  usage(`invalid request JSON: ${error.message}`)
}

const result = translate(dialect, endpoint, body)
if (quote && result.ok) {
  const key = process.env.YIR_API_KEY
  if (!key) usage('--quote needs YIR_API_KEY')
  const kind = dialect.endpoints[endpoint].operation === 'generate_video' ? 'videos' : 'images'
  const response = await fetch(`${BASE_URL}/v1/${kind}/quotes`, {
    method: 'POST',
    // A dedicated User-Agent lets Yir see whether migrations are used at all; no request content is added.
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'yir-skill-from-fal/1' },
    body: JSON.stringify(result.request),
  })
  const quoted = await response.json().catch(() => ({}))
  result.quote = response.ok
    ? { available: quoted.supply?.available, expected_amount_usd: quoted.expected_amount ?? quoted.price?.amount ?? null, per_job: true }
    : { error: quoted.error ?? { status: response.status } }
  if (!response.ok) result.ok = false
}
console.log(JSON.stringify(result, null, 2))
// Set exitCode instead of calling process.exit right after fetch (libuv assertion on Windows).
process.exitCode = result.ok ? 0 : 1
