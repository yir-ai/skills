#!/usr/bin/env node
// Account API only. Never accepts an arbitrary path or a Gateway Key.
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function runAccount(args, { env = process.env, fetch: fetchFn = globalThis.fetch } = {}) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    id: { type: 'string' }, json: { type: 'string' }, query: { type: 'string' }, write: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return { usage: 'account.mjs <analytics|logs|routing|webhooks|alerts|low-balance-alert> <get|list|create|update|archive|delete|deliveries> [--id ID] [--query JSON] [--json FILE] [--write]' };
  const [resource, action = resource === 'analytics' ? 'get' : 'list'] = positionals;
  if (positionals.length > 2) throw new Error('unexpected_arguments');
  const routes = {
    'analytics:get': ['GET','/analytics'], 'logs:list': ['GET','/logs'], 'logs:get': ['GET','/logs/:id'],
    'routing:list': ['GET','/routing-profiles'], 'routing:create': ['POST','/routing-profiles'], 'routing:update': ['PATCH','/routing-profiles/:id'], 'routing:archive': ['DELETE','/routing-profiles/:id'],
    'webhooks:list': ['GET','/webhook-endpoints'], 'webhooks:get': ['GET','/webhook-endpoints/:id'], 'webhooks:create': ['POST','/webhook-endpoints'], 'webhooks:update': ['PATCH','/webhook-endpoints/:id'], 'webhooks:delete': ['DELETE','/webhook-endpoints/:id'], 'webhooks:deliveries': ['GET','/webhook-endpoints/:id/deliveries'],
    'alerts:get': ['GET','/alerts/settings'], 'alerts:update': ['PUT','/alerts/settings'],
    'low-balance-alert:get': ['GET','/wallet/low-balance-alert'], 'low-balance-alert:update': ['PUT','/wallet/low-balance-alert'],
  };
  const route = routes[`${resource}:${action}`];
  if (!route) throw new Error('unsupported_account_operation');
  const [method, template] = route;
  if (method !== 'GET' && !values.write) throw new Error('account_write_requires_explicit_write_flag');
  if (template.includes(':id') && !/^[1-9]\d{0,18}$/.test(values.id ?? '')) throw new Error('account_id_invalid');
  const key = env.YIR_ACCOUNT_API_KEY;
  if (!key?.startsWith('yir_ak_') || /\s/.test(key)) throw new Error('YIR_ACCOUNT_API_KEY_required');
  const base = new URL(env.YIR_ACCOUNT_BASE_URL || 'https://api.yir.ai/account/v1');
  if (!['https:','http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('account_base_url_invalid');
  const url = new URL(base.href.replace(/\/$/, '') + template.replace(':id', values.id));
  if (values.query) {
    const query = JSON.parse(values.query);
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('query_invalid');
    for (const [name,value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        if (!value.every(item => typeof item === 'string')) throw new Error('query_value_invalid');
        url.searchParams.set(name, value.join(','));
      } else {
        if (!['string','number','boolean'].includes(typeof value)) throw new Error('query_value_invalid');
        url.searchParams.set(name, String(value));
      }
    }
  }
  let body;
  if (['POST','PATCH','PUT'].includes(method)) {
    if (!values.json) throw new Error('json_file_required');
    const input = JSON.parse(await readFile(values.json, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings_object_required');
    body = JSON.stringify(input);
  }
  const response = await fetchFn(url, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type':'application/json' } : {}) }, body, redirect:'manual', signal:AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`account_http_${response.status}`); }
  const result = await response.json();
  if (result?.code !== 200) throw new Error('account_response_invalid');
  return result.data ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAccount(process.argv.slice(2)).then(result => console.log(JSON.stringify(result,null,2))).catch(error => {
    // JSON parsing failures can quote private input. Only emit known, safe errors.
    const message = String(error?.message ?? '');
    console.error(/^[A-Za-z0-9_]+$/.test(message) ? message : 'account_request_failed'); process.exitCode=1;
  });
}
