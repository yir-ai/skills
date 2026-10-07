#!/usr/bin/env node
// Yir Standard API command line for agents. Zero dependencies, Node.js >= 18.
// Auth: YIR_API_KEY (required). Optional YIR_BASE_URL (default https://gateway.yir.ai).
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const VERSION = "0.2.1";
const CONSOLE_URL = "https://yir.ai";
const BASE_URL = (process.env.YIR_BASE_URL || "https://gateway.yir.ai").trim().replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 30000;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const JOB_ID = /^[1-9][0-9]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BATCH_STATE = ".yir-batch.json";
const PENDING_DIR = ".yir-pending";
const MEDIA_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav" };
const EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav" };
const REF_ROLES = new Set(["reference_image", "first_frame", "last_frame", "reference_video", "reference_audio"]);

const HELP = `yir ${VERSION} - Yir image and video jobs (https://gateway.yir.ai Standard API)

Usage:
  node yir.mjs models [--type image|video]          List model IDs, input modes and labels
  node yir.mjs model <creator/model>                Parameters, defaults and per-spec prices
  node yir.mjs quote <image|video> [generation options]
                                                    Price and supply check; creates no Job, charges nothing
  node yir.mjs image  --model M --prompt P [options] Text-to-image, or image edit with --image
  node yir.mjs video  --model M --prompt P [options] Text/image/reference-to-video
  node yir.mjs batch <plan.json> [--max-total USD] [--concurrency N] [--dry-run]
                                                    Run many image/video jobs from a plan; re-run resumes
  node yir.mjs job <id> [--wait] [--download] [--out DIR]
                                                    Job status, billing and result links
  node yir.mjs cancel <id>                          Request cancellation

Generation options:
  --model, -m ID            Model ID from \`models\` (e.g. openai/gpt-image-2)
  --prompt P                Prompt text
  --param, -p key=value     Model parameter, repeatable (resolution=1K, aspect_ratio=16:9,
                            duration=5, generate_audio=false). Missing required parameters
                            are filled with the model's defaults.
  --image PATH|URL          Shorthand reference: reference_image for image, first_frame for video
  --ref role=PATH|URL       Reference with explicit role, repeatable. Roles: reference_image,
                            first_frame, last_frame, reference_video, reference_audio
                            Local files are uploaded through the Files API first.
  --routing JSON            Optional routing override, e.g. '{"preference":"speed"}'.
                            Keys: only, variants, preference, fallback. Default: let Yir route.
  --max-cost USD            Cap the Job's total charge (e.g. 0.20)
  --out DIR                 Result directory (default ./yir-output)
  --name STEM               Result file name without extension (default yir-<job id>)
  --no-wait                 Submit and print the Job ID without polling
  --timeout SEC             Max wait (default 600 image, 1800 video)
  --json                    models/model: print raw JSON

Batch options:
  --max-total USD           Stop submitting once quoted + charged spend would pass this amount
  --concurrency N           Jobs in flight at once (default 3)
  --dry-run                 Quote every job and print the total; submits nothing
  --retry-failed            Re-submit jobs that failed in an earlier run (default: keep the failure)

Output: quote/image/video/job/cancel/batch print one JSON object on stdout; progress goes to stderr.
Each saved result gets a <name>.json sidecar with model, prompt, parameters, channel, Job ID and charge.
Exit codes: 0 ok, 1 API or job failure, 2 usage error, 3 wait timed out (job still running).
Environment: YIR_API_KEY (create one in the Console at ${CONSOLE_URL}), YIR_BASE_URL (optional).
`;

class UsageError extends Error {}
class APIError extends Error {
  constructor(status, body) {
    const err = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : {};
    super(err.message || (typeof body === "string" && body ? body.slice(0, 500) : `HTTP ${status}`));
    this.status = status;
    this.code = err.code || "http_error";
    this.retryable = err.retryable ?? false;
    this.action = err.action;
    this.requestId = body && typeof body === "object" ? body.request_id : undefined;
  }
}

const log = msg => process.stderr.write(`${msg}\n`);
const print = obj => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiKey() {
  const key = (process.env.YIR_API_KEY || "").trim();
  if (!key) throw new UsageError(`YIR_API_KEY is not set. Create an API Key in the Yir Console (${CONSOLE_URL}) and export YIR_API_KEY.`);
  return key;
}

async function api(method, path, { body, headers = {}, holdMs = 0 } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, "User-Agent": `yir-skill/${VERSION}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS + holdMs),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) throw new APIError(res.status, data);
  if (typeof data !== "object" || data === null) throw new Error(`invalid response from ${method} ${path}`);
  return data;
}

// Submits retry on transport errors with the same Idempotency-Key, so a lost response never creates a second Job.
async function submit(path, body, key = randomUUID()) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api("POST", path, { body, headers: { "Idempotency-Key": key } });
    } catch (e) {
      const transient = !(e instanceof APIError) || e.status >= 500 || e.code === "YIR_RATE_LIMITED";
      if (!transient || attempt >= 3) throw e;
      log(`submit attempt ${attempt} failed (${e.code || e.message}); retrying with the same idempotency key`);
      await sleep(2000 * attempt);
    }
  }
}

function modelPath(id) {
  const parts = String(id || "").trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new UsageError(`model must look like creator/model, got "${id}"`);
  return parts.map(encodeURIComponent).join("/");
}

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

function parseParams(list = []) {
  const out = {};
  for (const item of list) {
    const i = item.indexOf("=");
    if (i < 1) throw new UsageError(`--param expects key=value, got "${item}"`);
    out[item.slice(0, i).trim()] = coerce(item.slice(i + 1).trim());
  }
  return out;
}

function parseRefs(operation, values) {
  const refs = [];
  for (const src of values.image || []) refs.push({ role: operation === "generate_image" ? "reference_image" : "first_frame", src });
  for (const item of values.ref || []) {
    const i = item.indexOf("=");
    const role = i > 0 ? item.slice(0, i) : "";
    if (!REF_ROLES.has(role)) throw new UsageError(`--ref expects role=PATH|URL with role in ${[...REF_ROLES].join(", ")}, got "${item}"`);
    refs.push({ role, src: item.slice(i + 1) });
  }
  return refs;
}

function inputMode(operation, refs) {
  if (!refs.length) return "text";
  if (operation === "generate_image") return "image";
  const framed = refs.some(r => r.role === "first_frame" || r.role === "last_frame");
  const referenced = refs.some(r => r.role.startsWith("reference_"));
  if (framed && referenced) throw new UsageError("video references cannot mix first_frame/last_frame with reference_* roles");
  return framed ? "image" : "reference";
}

async function uploadLocal(path) {
  const full = resolve(path);
  const media_type = MEDIA_TYPES[extname(full).toLowerCase()];
  if (!media_type) throw new UsageError(`unsupported file type ${extname(full) || "(none)"}; use ${Object.keys(MEDIA_TYPES).join(" ")}`);
  const bytes = await readFile(full);
  if (!bytes.length) throw new UsageError(`file is empty: ${path}`);
  const meta = { name: basename(full), media_type, size: bytes.length };
  log(`uploading ${meta.name} (${meta.size} bytes)`);
  const created = await api("POST", "/v1/files", { body: { files: [meta], upload_mode: "multipart" }, headers: { "Idempotency-Key": randomUUID() } });
  let file = created.files?.[0];
  if (!file?.id) throw new Error("invalid upload plan response");
  if (file.status === "pending_upload") {
    const parts = file.upload?.parts || [];
    let offset = 0;
    for (const part of parts) {
      let res;
      try {
        // Signed storage URL: never send the API Key here.
        res = await fetch(part.url, { method: "PUT", body: bytes.subarray(offset, offset + part.size), redirect: "error" });
      } catch {
        throw new Error(`upload of ${meta.name} part ${part.part_number} failed (network error)`);
      }
      await res.body?.cancel();
      if (!res.ok) throw new Error(`upload of ${meta.name} part ${part.part_number} failed: HTTP ${res.status}`);
      offset += part.size;
    }
    if (offset !== bytes.length) throw new Error("upload plan does not cover the file");
    file = await api("POST", `/v1/files/${file.id}/complete`, { body: {} });
  }
  const deadline = Date.now() + 300000;
  while (file.status !== "ready") {
    if (file.status === "failed" || file.status === "expired") throw new Error(`input file ${meta.name} is ${file.status}`);
    if (Date.now() > deadline) throw new Error(`input file ${meta.name} not ready after 300s`);
    await sleep(500);
    file = await api("GET", `/v1/files/${file.id}`);
  }
  log(`uploaded ${meta.name} as ${file.id} (reusable until it expires)`);
  return file.id;
}

async function resolveRefs(refs) {
  const out = [];
  for (const { role, src } of refs) {
    if (/^https:\/\//i.test(src)) out.push({ role, url: src });
    else if (/^file_[0-9a-f-]{36}$/.test(src)) out.push({ role, file_id: src });
    else {
      try { await stat(src); } catch { throw new UsageError(`reference not found: ${src} (use a local path, an https URL or a file_ id)`); }
      out.push({ role, file_id: await uploadLocal(src) });
    }
  }
  return out;
}

async function getContract(model) {
  const data = await api("GET", `/v1/models/${modelPath(model)}?view=contract`);
  return data.model || data;
}

// Fills required parameters the caller omitted with the model contract defaults.
async function withDefaults(model, operation, mode, params) {
  const contract = await getContract(model);
  const ops = (contract.operations || []).filter(o => o.operation === operation);
  if (!ops.length) throw new UsageError(`${model} does not support ${operation === "generate_image" ? "image" : "video"} generation; run \`models\``);
  const op = ops.find(o => (o.input_modes || []).includes(mode));
  if (!op) throw new UsageError(`${model} ${operation} supports input modes ${ops.flatMap(o => o.input_modes).join(", ")}, not "${mode}"`);
  const rules = new Map((op.parameters || []).map(p => [p.name, p]));
  for (const [name, value] of Object.entries(params)) {
    const p = rules.get(name);
    if (!p) throw new UsageError(`${model} (${mode} input) has no parameter "${name}"; allowed: ${[...rules.keys()].join(", ")}`);
    if (p.values && !p.values.includes(value)) throw new UsageError(`${name}=${JSON.stringify(value)} is not allowed for ${model}; values: ${JSON.stringify(p.values)}`);
    if (typeof value === "number" && ((p.minimum !== undefined && value < p.minimum) || (p.maximum !== undefined && value > p.maximum))) {
      throw new UsageError(`${name}=${value} is outside ${p.minimum ?? ""}..${p.maximum ?? ""} for ${model}`);
    }
  }
  const out = { ...params };
  for (const p of rules.values()) if (p.required && out[p.name] === undefined && p.default !== undefined) out[p.name] = p.default;
  return out;
}

async function buildRequest(operation, values, params = parseParams(values.param)) {
  if (!values.model) throw new UsageError("--model is required (see `models`)");
  if (!values.prompt || !values.prompt.trim()) throw new UsageError("--prompt is required");
  const refs = parseRefs(operation, values);
  const mode = inputMode(operation, refs);
  const parameters = await withDefaults(values.model, operation, mode, params);
  const input = mode === "text" ? { type: "text", prompt: values.prompt } : { type: mode, prompt: values.prompt, references: await resolveRefs(refs) };
  const body = { model: values.model, input, parameters };
  if (values.routing) {
    try { body.routing = JSON.parse(values.routing); } catch { throw new UsageError("--routing must be valid JSON"); }
  }
  return body;
}

function summarizeQuote(q) {
  return { model: q.model, operation: q.operation, input_mode: q.input_mode, parameters: q.parameters,
    currency: q.currency, price: q.primary, official_price: q.official, supply: q.supply,
    parameter_notices: q.parameter_notices, expires_at: q.expires_at };
}

function summarizeJob(job, paths = []) {
  const files = job.result?.availability === "available" ? job.result.files : [];
  return {
    id: job.id, status: job.status, model: job.model, final_provider: job.final_provider,
    error: job.error || undefined, cancellation: job.cancellation,
    charged_usd: job.billing?.total_charged_by_yir, billing: job.billing,
    result_availability: job.result?.availability,
    files: files.map((f, i) => ({ ...f, ...(paths[i] ? { path: paths[i] } : {}) })),
    parameter_notices: job.parameter_notices,
    created_at: job.created_at, completed_at: job.completed_at,
  };
}

async function waitForJob(id, timeoutSec) {
  const start = Date.now();
  let last = "";
  for (let poll = 0; ; poll++) {
    const remaining = timeoutSec * 1000 - (Date.now() - start);
    if (remaining <= 0) return null;
    const wait = Math.max(0, Math.min(20, Math.floor(remaining / 1000) - 1));
    const asked = Date.now();
    let status;
    try {
      status = await api("GET", `/v1/jobs/${id}/status${wait > 0 ? `?wait=${wait}` : ""}`, { holdMs: wait * 1000 });
    } catch (e) {
      if (e instanceof APIError && !e.retryable && e.status < 500) throw e;
      log(`status query failed (${e.code || e.message}); retrying`);
      await sleep(5000);
      continue;
    }
    if (status.status !== last) {
      log(`job ${id}: ${status.status} (${Math.round((Date.now() - start) / 1000)}s)`);
      last = status.status;
    }
    if (TERMINAL.has(status.status)) return api("GET", `/v1/jobs/${id}`);
    if (wait > 0 && Date.now() - asked >= (wait * 1000) / 2) continue;
    await sleep(poll < 6 ? 5000 : poll < 12 ? 10000 : 20000);
  }
}

async function download(job, outDir, stem = `yir-${job.id}`) {
  const files = job.result?.availability === "available" ? job.result.files : [];
  if (!files.length) return [];
  await mkdir(outDir, { recursive: true });
  const paths = [];
  for (const [i, f] of files.entries()) {
    // Signed result URL: fetched without the API Key.
    const res = await fetch(f.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`download of result ${i + 1} failed: HTTP ${res.status}`);
    const ext = EXTENSIONS[f.media_type] || extname(new URL(f.url).pathname) || ".bin";
    const path = resolve(join(outDir, `${stem}${files.length > 1 ? `-${i + 1}` : ""}${ext}`));
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    paths.push(path);
    log(`saved ${path}`);
  }
  return paths;
}

// Sidecar next to the results: enough to reproduce the request and record where it ran and what it cost.
async function writeSidecar(job, outDir, stem, paths, request) {
  const meta = {
    job_id: job.id, status: job.status, model: job.model,
    ...(request ? { prompt: request.input.prompt, parameters: request.parameters, references: request.references, routing: request.routing } : {}),
    final_provider: job.final_provider, charged_usd: job.billing?.total_charged_by_yir,
    files: paths.map(p => basename(p)), created_at: job.created_at, completed_at: job.completed_at,
  };
  await writeFile(resolve(join(outDir, `${stem}.json`)), `${JSON.stringify(meta, null, 2)}\n`);
}

async function save(job, outDir, stem, request) {
  if (job.status !== "succeeded") return [];
  const paths = await download(job, outDir, stem);
  if (paths.length) await writeSidecar(job, outDir, stem, paths, request);
  return paths;
}

async function finish(job, values, request) {
  const paths = await save(job, values.out || "yir-output", stemOf(values, job), request);
  print(summarizeJob(job, paths));
  return job.status === "succeeded" ? 0 : 1;
}

function stemOf(values, job) {
  if (values.name === undefined) return `yir-${job.id}`;
  if (!NAME.test(values.name)) throw new UsageError("--name may use letters, digits, '.', '_' and '-' only");
  return values.name;
}

// What the sidecar records about the request: local reference paths as given, never uploaded file IDs only.
function requestRecord(body, refs) {
  return { input: { prompt: body.input.prompt }, parameters: body.parameters, routing: body.routing,
    references: refs.length ? refs.map(r => ({ role: r.role, src: r.src })) : undefined };
}

async function cmdModels(values) {
  const data = await api("GET", "/v1/models?include=parameters");
  if (values.json) return print(data), 0;
  const want = values.type ? `generate_${values.type}` : null;
  if (values.type && !["image", "video"].includes(values.type)) throw new UsageError("--type must be image or video");
  for (const m of data.models || []) {
    const ops = (m.operations || []).filter(o => !want || o.operation === want);
    if (!ops.length) continue;
    const modes = {};
    for (const o of ops) for (const m of o.input_modes) (modes[o.operation.replace("generate_", "")] ||= new Set()).add(m);
    const desc = Object.entries(modes).map(([k, v]) => `${k}[${[...v].join(",")}]`).join(" ");
    process.stdout.write(`${m.id}\t${desc}\t${m.locales?.en?.label || ""}\n`);
  }
  log("Next: `model <id>` for parameters and prices.");
  return 0;
}

async function cmdModel(id, values) {
  if (!id) throw new UsageError("usage: model <creator/model>");
  const [contract, detail] = await Promise.all([
    getContract(id),
    api("GET", `/v1/models/${modelPath(id)}`),
  ]);
  if (values.json) return print({ contract, detail }), 0;
  const out = [`${contract.id || id}  ${contract.locales?.en?.description || ""}`];
  for (const op of contract.operations || []) {
    out.push(`\n${op.operation}  input modes: ${op.input_modes.join(", ")}`);
    for (const [mode, c] of Object.entries(op.input_constraints || {})) {
      if (c.max_references) out.push(`  ${mode}: ${c.min_references}-${c.max_references} references, roles ${c.allowed_reference_roles.join(", ")}`);
    }
    out.push("  parameters:");
    for (const p of op.parameters || []) {
      const range = p.values ? `values ${JSON.stringify(p.values)}` : `${p.minimum ?? ""}..${p.maximum ?? ""}`;
      out.push(`    ${p.name} (${p.type}${p.required ? ", required" : ""}) ${range}${p.default !== undefined ? ` default ${JSON.stringify(p.default)}` : ""}`);
    }
  }
  out.push("\nlisted prices (USD per output for that spec, lowest available channel; use `quote` for exact parameters; final charge follows the upstream channel actually billed):");
  for (const s of detail.specifications || []) {
    const ch = (s.channels || []).filter(c => c.availability === "available" && typeof c.amount_micros === "number");
    const min = ch.length ? Math.min(...ch.map(c => c.amount_micros)) / 1e6 : null;
    out.push(`  ${s.operation.replace("generate_", "")} ${s.input_mode}  ${s.specification_label}  ${min === null ? "unavailable" : `$${min}`}  (${ch.length} channel${ch.length === 1 ? "" : "s"})`);
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

async function cmdQuote(kind, values) {
  if (kind !== "image" && kind !== "video") throw new UsageError("usage: quote <image|video> --model M --prompt P ...");
  const body = await buildRequest(`generate_${kind}`, values);
  print(summarizeQuote(await api("POST", `/v1/${kind}s/quotes`, { body })));
  return 0;
}

// Until a Job reaches a terminal state, the exact request and its idempotency key live in
// <out>/.yir-pending/<command hash>.json. Re-running the same command then re-sends the same bytes under
// the same key (a lost response cannot create a second Job) or keeps waiting on the Job it already has.
// Once the Job is terminal the record is removed, so running the command again asks for a new generation.
function pendingPath(kind, values) {
  const refs = parseRefs(`generate_${kind}`, values).map(r => ({ role: r.role, src: /^https:\/\//i.test(r.src) || /^file_/.test(r.src) ? r.src : resolve(r.src) }));
  const id = JSON.stringify([kind, values.model, values.prompt, parseParams(values.param), refs, values.routing ?? null, values["max-cost"] ?? null, values.name ?? null]);
  return resolve(join(values.out || "yir-output", PENDING_DIR, `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`));
}

async function cmdGenerate(kind, values) {
  if (values.name !== undefined) stemOf(values, {});
  if (values["max-cost"] && !/^\d+(\.\d+)?$/.test(values["max-cost"])) throw new UsageError("--max-cost must be a decimal USD amount, e.g. 0.20");
  const path = pendingPath(kind, values);
  let pending;
  try { pending = JSON.parse(await readFile(path, "utf8")); } catch { pending = undefined; }
  const persistPending = () => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, `${JSON.stringify(pending, null, 2)}\n`));
  let jobId = pending?.job_id;
  if (jobId) {
    log(`resuming job ${jobId} from an earlier run of this command`);
  } else {
    if (pending?.body) {
      log("re-sending the unconfirmed submit from an earlier run of this command");
    } else {
      const body = await buildRequest(`generate_${kind}`, values);
      if (values["max-cost"]) body.max_cost = values["max-cost"];
      pending = { idempotency_key: randomUUID(), body, request: requestRecord(body, parseRefs(`generate_${kind}`, values)) };
      await persistPending();
    }
    let job;
    try {
      job = await submit(`/v1/${kind}s/generations`, pending.body, pending.idempotency_key);
    } catch (e) {
      // A definite rejection created no Job; forget it so a corrected command starts clean.
      if (e instanceof APIError && e.status < 500 && e.code !== "YIR_RATE_LIMITED") await rm(path, { force: true });
      throw e;
    }
    jobId = job.id;
    pending.job_id = jobId;
    await persistPending();
    log(`submitted job ${jobId} (${job.status}) model=${pending.body.model} params=${JSON.stringify(pending.body.parameters)}`);
    if (values["no-wait"]) return print(summarizeJob(job)), 0;
  }
  const timeout = Number(values.timeout || (kind === "video" ? 1800 : 600));
  const done = await waitForJob(jobId, timeout);
  if (!done) return timedOut(jobId, timeout);
  const code = await finish(done, values, pending.request);
  await rm(path, { force: true });
  return code;
}

function timedOut(id, timeout) {
  print({ id, status: "still_running", message: `Not terminal after ${timeout}s. The Job keeps running; re-run the same command, or: node yir.mjs job ${id} --wait --download` });
  return 3;
}

async function cmdJob(id, values) {
  if (!JOB_ID.test(String(id || "").trim())) throw new UsageError("usage: job <numeric id> [--wait] [--download]");
  id = id.trim();
  let job;
  if (values.wait) {
    const timeout = Number(values.timeout || 1800);
    job = await waitForJob(id, timeout);
    if (!job) return timedOut(id, timeout);
  } else {
    job = await api("GET", `/v1/jobs/${id}`);
  }
  if (values.download || values.wait) return finish(job, values);
  print(summarizeJob(job));
  return 0;
}

async function cmdCancel(id) {
  if (!JOB_ID.test(String(id || "").trim())) throw new UsageError("usage: cancel <numeric id>");
  print(summarizeJob(await api("POST", `/v1/jobs/${id.trim()}/cancel`)));
  return 0;
}

// Batch plan: {"defaults": {...}, "jobs": [{name, type, model, prompt, params, image, refs, routing, max_cost}]}
// or a bare array of jobs. Each job's fields override defaults; params are merged.
// Local reference paths resolve against the plan file's folder.
async function loadPlan(file) {
  let raw;
  try { raw = JSON.parse(await readFile(file, "utf8")); } catch (e) { throw new UsageError(`cannot read plan ${file}: ${e.message}`); }
  const defaults = Array.isArray(raw) ? {} : raw.defaults || {};
  const list = Array.isArray(raw) ? raw : raw.jobs;
  if (!Array.isArray(list) || !list.length) throw new UsageError("plan needs a non-empty \"jobs\" array");
  const base = dirname(resolve(file));
  const local = src => (/^https:\/\//i.test(src) || /^file_[0-9a-f-]{36}$/.test(src) ? src : resolve(base, src));
  const seen = new Set();
  return list.map((j, i) => {
    const job = { ...defaults, ...j, params: { ...defaults.params, ...j.params } };
    const where = `jobs[${i}]${job.name ? ` (${job.name})` : ""}`;
    if (!NAME.test(job.name || "")) throw new UsageError(`${where}: "name" is required and may use letters, digits, '.', '_' and '-' only`);
    if (seen.has(job.name)) throw new UsageError(`${where}: duplicate name`);
    seen.add(job.name);
    if (job.type !== "image" && job.type !== "video") throw new UsageError(`${where}: "type" must be image or video`);
    const values = {
      model: job.model, prompt: job.prompt,
      image: [].concat(job.image || []).map(local),
      ref: [].concat(job.refs || []).map(r => { const k = String(r).indexOf("="); return k > 0 ? `${r.slice(0, k)}=${local(r.slice(k + 1))}` : r; }),
      routing: job.routing === undefined ? undefined : JSON.stringify(job.routing),
    };
    if (job.max_cost !== undefined && !/^\d+(\.\d+)?$/.test(String(job.max_cost))) throw new UsageError(`${where}: max_cost must be a decimal USD amount`);
    return { name: job.name, kind: job.type, values, params: job.params, maxCost: job.max_cost === undefined ? undefined : String(job.max_cost) };
  });
}

async function readState(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return { jobs: {} }; }
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function cmdBatch(file, values) {
  if (!file) throw new UsageError("usage: batch <plan.json> [--max-total USD] [--concurrency N] [--dry-run]");
  const maxTotal = values["max-total"] === undefined ? undefined : Number(values["max-total"]);
  if (maxTotal !== undefined && !(maxTotal > 0)) throw new UsageError("--max-total must be a positive USD amount");
  const concurrency = Number(values.concurrency || 3);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new UsageError("--concurrency must be 1-10");
  const jobs = await loadPlan(file);
  const outDir = values.out || "yir-output";
  const statePath = resolve(join(outDir, BATCH_STATE));
  const state = await readState(statePath);
  state.jobs ||= {};
  await mkdir(outDir, { recursive: true });
  // Writes are serialized so concurrent workers never interleave a partial state file.
  let saving = Promise.resolve();
  const persist = () => (saving = saving.then(() => writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)));

  const todo = [];
  for (const j of jobs) {
    const s = state.jobs[j.name];
    if (s?.status === "succeeded") { log(`${j.name}: done in an earlier run (job ${s.job_id})`); continue; }
    if (s?.status === "failed" || s?.status === "cancelled") {
      if (!values["retry-failed"]) { log(`${j.name}: ${s.status} in an earlier run (job ${s.job_id}); pass --retry-failed to submit again`); continue; }
      delete state.jobs[j.name];
    }
    todo.push(j);
  }

  // Quotes are free; they price the plan before anything is submitted. Jobs already submitted are only resumed.
  let quoted = 0;
  const problems = [];
  for (const j of todo) {
    const prior = state.jobs[j.name];
    if (prior?.job_id) continue;
    // An earlier submit whose outcome is unknown is re-sent byte for byte under its key, so it cannot become a second Job.
    if (prior?.idempotency_key && prior.body) {
      j.body = prior.body;
      j.quote = prior.quote;
      quoted += j.quote;
      log(`${j.name}: re-sending the unconfirmed submit from an earlier run`);
      continue;
    }
    try {
      j.body = await buildRequest(`generate_${j.kind}`, j.values, j.params);
      if (j.maxCost) j.body.max_cost = j.maxCost;
      const q = await api("POST", `/v1/${j.kind}s/quotes`, { body: j.body });
      j.quote = Number(q.primary?.amount ?? NaN);
      if (!q.supply?.available || Number.isNaN(j.quote)) throw new Error(`no channel can run this request now (${(q.supply?.issues || []).map(i => i.code || i).join(", ") || "unavailable"})`);
      quoted += j.quote;
      log(`${j.name}: ${j.body.model} quoted $${j.quote}`);
    } catch (e) {
      problems.push(`${j.name}: ${e.code ? `${e.code} ` : ""}${e.message}`);
    }
  }
  // Every job is checked before anything is submitted, so one fix-up round covers the whole plan.
  if (problems.length) {
    throw new UsageError(`plan has ${problems.length} job(s) that cannot run as written:\n  ${problems.join("\n  ")}\nCheck parameters with \`model <id>\` or pick another model.`);
  }
  log(`plan: ${todo.length} job(s) to run, quoted total $${quoted.toFixed(4)}${maxTotal ? ` (limit $${maxTotal})` : ""}`);
  if (values["dry-run"]) return print({ dry_run: true, quoted_total_usd: quoted.toFixed(4), jobs: todo.map(j => ({ name: j.name, model: j.values.model, quoted_usd: j.quote, resume_job_id: state.jobs[j.name]?.job_id })) }), 0;
  if (maxTotal !== undefined && quoted > maxTotal) throw new UsageError(`quoted total $${quoted.toFixed(4)} exceeds --max-total ${maxTotal}; drop jobs or raise the limit`);

  // The final charge follows the channel that actually ran and can differ from the quote, so spending is
  // re-checked before every submit against what earlier jobs really charged plus what is still in flight.
  let charged = Object.values(state.jobs).reduce((sum, s) => sum + Number(s.charged_usd || 0), 0);
  let inFlight = 0;
  await pool(todo, concurrency, async j => {
    const s = state.jobs[j.name] ||= {};
    try {
      if (!s.job_id) {
        if (maxTotal !== undefined && charged + inFlight + j.quote > maxTotal) {
          log(`${j.name}: skipped, would pass --max-total (charged $${charged.toFixed(4)}, in flight $${inFlight.toFixed(4)})`);
          s.status = "skipped_budget";
          return;
        }
        s.idempotency_key ||= randomUUID();
        s.body = j.body;
        s.quote = j.quote;
        s.request ||= requestRecord(j.body, parseRefs(`generate_${j.kind}`, j.values));
        s.model = j.body.model;
        await persist();
        inFlight += j.quote;
        try {
          const job = await submit(`/v1/${j.kind}s/generations`, j.body, s.idempotency_key);
          s.job_id = job.id;
          s.status = job.status;
          delete s.body;
          await persist();
          log(`${j.name}: submitted job ${job.id}`);
        } catch (e) {
          inFlight -= j.quote;
          throw e;
        }
      } else {
        log(`${j.name}: resuming job ${s.job_id}`);
      }
      const timeout = Number(values.timeout || (j.kind === "video" ? 1800 : 600));
      const done = await waitForJob(s.job_id, timeout);
      if (j.quote !== undefined) inFlight -= j.quote;
      if (!done) { s.status = "still_running"; log(`${j.name}: still running after ${timeout}s; re-run the batch to resume`); return; }
      s.status = done.status;
      s.final_provider = done.final_provider;
      s.charged_usd = done.billing?.total_charged_by_yir;
      charged += Number(s.charged_usd || 0);
      if (done.status === "succeeded") s.files = (await save(done, outDir, j.name, s.request)).map(p => basename(p));
      else s.error = done.error;
      log(`${j.name}: ${done.status} via ${done.final_provider || "-"}, charged $${s.charged_usd ?? "0"}`);
    } catch (e) {
      // A lost response leaves the idempotency key in the state file: the next run re-sends it and gets the same Job.
      if (!s.job_id) {
        s.status = "submit_error";
        // A definite rejection created no Job, so the next run may send a fresh request under a new key.
        if (e instanceof APIError && e.status < 500 && e.code !== "YIR_RATE_LIMITED") {
          delete s.idempotency_key;
          delete s.body;
        }
      }
      s.error = e instanceof APIError ? { code: e.code, message: e.message, request_id: e.requestId } : { message: e.message };
      log(`${j.name}: ${e.code || ""} ${e.message}`);
    } finally {
      await persist();
    }
  });
  await saving;

  const items = jobs.map(j => ({ name: j.name, ...state.jobs[j.name], request: undefined, idempotency_key: undefined, body: undefined, quote: undefined }));
  const total = items.reduce((sum, s) => sum + Number(s.charged_usd || 0), 0);
  print({ out: resolve(outDir), charged_total_usd: total.toFixed(4), quoted_total_usd: quoted.toFixed(4), jobs: items });
  return items.every(s => s.status === "succeeded") ? 0 : items.some(s => s.status === "still_running") ? 3 : 1;
}

function hint(e) {
  if (e.code === "YIR_UNAUTHORIZED") return `Check YIR_API_KEY; create or copy an API Key in the Yir Console: ${CONSOLE_URL}`;
  if (e.code === "YIR_INSUFFICIENT_BALANCE" || e.action === "add_funds") return `Top up the wallet in the Yir Console: ${CONSOLE_URL}`;
  if (e.code === "YIR_SPEND_LIMIT_EXCEEDED") return `This API Key reached its monthly limit; raise it in the Yir Console: ${CONSOLE_URL}`;
  if (e.code === "YIR_BUDGET_EXCEEDED") return "The quoted cost exceeds --max-cost; raise it or choose a cheaper model/spec.";
  if (e.code === "YIR_MODEL_NOT_FOUND") return "Run `models` to list valid model IDs.";
  if (e.code === "YIR_INVALID_REQUEST") return "Run `model <id>` to check parameter names, values and reference roles.";
  if (e.code === "YIR_NO_EXECUTABLE_ROUTE") return "No channel can run this model/parameter combination now; try other parameters or another model.";
  if (e.action === "retry_later" || e.retryable) return "Retry later.";
  if (e.action === "contact_support") return `Contact Yir support via ${CONSOLE_URL} with the request_id.`;
  return undefined;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      help: { type: "boolean", short: "h" }, version: { type: "boolean" },
      model: { type: "string", short: "m" }, prompt: { type: "string" },
      param: { type: "string", short: "p", multiple: true },
      image: { type: "string", multiple: true }, ref: { type: "string", multiple: true },
      routing: { type: "string" }, "max-cost": { type: "string" },
      out: { type: "string", short: "o" }, "no-wait": { type: "boolean" }, timeout: { type: "string" },
      wait: { type: "boolean" }, download: { type: "boolean" }, type: { type: "string" }, json: { type: "boolean" },
      name: { type: "string" }, "max-total": { type: "string" }, concurrency: { type: "string" },
      "dry-run": { type: "boolean" }, "retry-failed": { type: "boolean" },
    },
  });
  if (values.version) return process.stdout.write(`${VERSION}\n`), 0;
  const [cmd, arg] = positionals;
  if (values.help || !cmd || cmd === "help") return process.stdout.write(HELP), 0;
  if (values.timeout !== undefined && !(Number(values.timeout) > 0)) throw new UsageError("--timeout must be a positive number of seconds");
  switch (cmd) {
    case "models": return cmdModels(values);
    case "model": return cmdModel(arg, values);
    case "quote": return cmdQuote(arg, values);
    case "image": return cmdGenerate("image", values);
    case "video": return cmdGenerate("video", values);
    case "job": return cmdJob(arg, values);
    case "cancel": return cmdCancel(arg);
    case "batch": return cmdBatch(arg, values);
    default: throw new UsageError(`unknown command "${cmd}"; run with --help`);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code ?? 0; }, e => {
  if (e instanceof UsageError || e?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || e?.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" || e?.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
    log(`error: ${e.message}`);
    process.exitCode = 2;
  } else if (e instanceof APIError) {
    print({ error: { http_status: e.status, code: e.code, message: e.message, retryable: e.retryable, action: e.action, request_id: e.requestId }, hint: hint(e) });
    process.exitCode = 1;
  } else {
    log(`error: ${e?.message || e}`);
    process.exitCode = 1;
  }
});
