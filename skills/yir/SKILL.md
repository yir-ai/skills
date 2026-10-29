---
name: yir
description: Generate and edit images, and generate videos and audio (music, sound effects, speech), through Yir, the image & video API router (GPT Image, Nano Banana, Seedream, FLUX, Seedance, Veo, Kling, Wan and more under one API key). Use when the user asks to create an image from text, edit or restyle an image from a local file or URL, make a video from text or from a first frame / reference image, make a song, instrumental track or sound effect, read text aloud as speech (text-to-speech / voiceover), produce a set of images or clips for a page, deck or article in one batch, compare or pick image/video/audio models and prices, check, download or cancel a Yir job by ID, or migrate existing fal (fal.ai) code to Yir. Requires YIR_API_KEY.
---

# Yir image, video and audio jobs

All calls go through one zero-dependency script (Node.js 18+). Run it from this skill's directory:

```sh
node scripts/yir.mjs --help
```

It reads `YIR_API_KEY` from the environment. If it is missing or rejected (`YIR_UNAUTHORIZED`), tell the user to create an API Key in the Yir Console at https://yir.ai and export it as `YIR_API_KEY`. Never print or write the key.

If the Yir MCP server is already connected (tools such as `list_models`, `quote` and `generate` from server `yir`) and `YIR_API_KEY` is not set, use those tools for single jobs instead of asking for a key: same workflow, quote first, tell the user the price, the official price and the saving, and pass the approved amount as `max_cost`. Use this script when files must be saved locally or for batches.

## Account API: analytics and settings

Use **Gateway Key** (`YIR_API_KEY`, `yir_sk_`) for generation commands. Use a separate **Account Key** (`YIR_ACCOUNT_API_KEY`, `yir_ak_`) for account commands. Create it in Console → API Keys → Account Key. Default permission is read only; settings writes need the explicit settings permission. The public Account API is not Yir's internal Admin API. Never use browser cookies or try internal administrator paths.

- Query: `node scripts/account.mjs analytics get --query '{"group_by":"model"}'`; specify `from`, `to` and `timezone` for comparisons. Explain returned coverage, missing samples and content rejection separately from execution failures.
- Inspect: `node scripts/account.mjs logs list --query '{"status":"failed","page_limit":20}'`; `node scripts/account.mjs routing list`; `node scripts/account.mjs webhooks list`.
- Change settings only when requested by the user. Read the target first and use its exact ID. Write the intended patch to a local JSON file, then run `node scripts/account.mjs routing update --id ID --json patch.json --write`. The flag is an execution safeguard, not a substitute for user authorization.
- Other supported resources: `alerts get|update` and `low-balance-alert get|update`. Webhooks support `list|get|create|update|delete|deliveries`. Routing supports `list|create|update|archive`.
- The account script does not retry writes. If a create result is uncertain, list resources before retrying. Never automatically raise budgets, create/reveal/rotate/revoke keys, change identity or initiate payments; these remain Console sign-in operations.
- Account data may be private. Summarize the requested findings; do not publish raw logs or keys. `YIR_ACCOUNT_BASE_URL` overrides only the Account API endpoint; gateway environment variables are not used.

## Workflow

1. **Pick a model.** `node scripts/yir.mjs models --type image` (or `--type video`, `--type audio`) lists model IDs and input modes (`text`, `image`, `reference`). If the user named a model, use its ID as listed (`creator/model`).
2. **Check parameters and prices.** `node scripts/yir.mjs model <creator/model>` shows each parameter's allowed values and default, accepted reference roles, and listed prices per spec. Omitted required parameters are filled with the defaults.
   For images, keep the lowest resolution (usually the default `1K`): it is enough for web pages, articles, chat and drafts, and 2K/4K often cost 2–5× more. Go higher only when the user asks for it; if you think the use needs it (print, large displays, heavy cropping), quote it and confirm the price with the user first.
   When exact output pixels are requested, inspect the model for optional `size` and pass `--param size=WIDTHxHEIGHT`. Never approximate a requested size with a resolution tier. Omit `resolution`/`aspect_ratio` to let the Gateway derive them from its exact-size declaration, or pass matching explicit values; conflicts are rejected. Initially only Seedream 5.0 Pro official image sizes are declared; unsupported models/channels (including video sizes) fail explicitly. If `size` is omitted, existing defaults remain unchanged.
   For an explicit video frame rate, inspect optional `fps` and pass `--param fps=24` only when declared. Initially only the official Google route for `google/veo-3.1-generate-001` declares native 24 FPS. Unsupported rates/channels are rejected without interpolation or transcoding. Omit FPS to preserve existing behavior; the Gateway must have FPS support deployed.
   First-frame video may omit `--prompt` only when the model input contract declares `prompt_optional`; initially this is the official Google Veo 3.1 route. Do not invent text. Text-only inputs still require a prompt. The Gateway enforces channel eligibility.
3. **Quote before every job and get the user's OK**: `node scripts/yir.mjs quote image|video|audio <same options as the job>`. It creates no Job and charges nothing. Check `supply.available` and `expected_amount` (USD; it includes reference-image input charges, fall back to `price.amount` when absent). Before submitting, tell the user in one line the model and spec, the Yir price, and, when `vs_official` is present, the official price (prefix `≈` when `official_is_estimate`) and the saving in USD and percent, e.g. `GPT Image 2 · 1K 16:9: $0.0085 (official ≈ $0.032, you save $0.024 / 74%). Generate?`. When `vs_official` is null, say the official price is not available; never invent one. Submit only after the user agrees, passing the agreed amount as `--max-cost` with a little headroom. Skip the question only when the user has already approved a budget that covers this job; still mention the price and saving. Quote does not download URL references: with a URL reference video or audio, an available quote can have no amount (`complete_price_unavailable`). For the exact price, download the file and pass it as a local path, which the script uploads.
4. **Submit.** The script polls until the Job is terminal, downloads results to `--out` (default `./yir-output`) and prints a JSON summary with local `files[].path`, `charged_usd` and `final_provider`. Show the user the local paths.

Give results meaningful names with `--name` (e.g. `--name hero-desktop`). Every saved result gets a `<name>.json` sidecar with the prompt, parameters, references, channel, Job ID and charge, so the asset can be reproduced or credited later. Keep it next to the file.

## Many assets at once (pages, decks, articles)

When the user needs several images or clips, write a plan file and run it as one batch instead of calling `image`/`video` repeatedly:

```json
{
  "defaults": { "type": "image", "model": "openai/gpt-image-2", "params": { "resolution": "1K", "aspect_ratio": "16:9" } },
  "jobs": [
    { "name": "hero", "prompt": "..." },
    { "name": "feature-edit", "prompt": "...", "image": "./before.png" },
    { "name": "hero-mobile", "prompt": "...", "params": { "aspect_ratio": "9:16" } },
    { "name": "demo-clip", "type": "video", "model": "bytedance/seedance-1.5-pro", "prompt": "...", "refs": ["first_frame=./hero.png"], "params": { "duration": 5 } }
  ]
}
```

Each job takes `name` (required, unique, becomes the file name), `type` (`image`, `video` or `audio`), `model`, `prompt`, `params` (merged over the defaults), `image`, `refs` (`role=path`), `lyrics` or `lyrics_file` (songs only), `duration` (same as `params.duration`), `routing` and `max_cost`. Local paths are relative to the plan file.

```sh
node scripts/yir.mjs batch plan.json --dry-run --out ./assets        # validate and quote every job; submits nothing
node scripts/yir.mjs batch plan.json --max-total 2.00 --out ./assets # run, at most 3 jobs in flight (--concurrency)
```

1. Always `--dry-run` first. It checks every job against the model contract and current supply and reports all problems at once; fix the plan until it passes. Tell the user the quoted total and, from `vs_official`, the official total and the saving (it covers `jobs_compared` of `jobs_total` jobs; say so when some have no official price), then get approval before running. An available route without an estimate is reported as pending (`quoted_total_usd: null`), never as free. It can be submitted without `--max-total`; with a total budget, provide an explicit per-job `max_cost` and let the Gateway enforce it. Missing estimates never allow the script to exceed an approved budget.
2. Run with `--max-total` set to the amount the user approved. The script settles earlier submitted jobs before admitting new ones, counts charges from failed attempts and retries, and reserves each new job’s cap before submission. With `--max-total`, each new job gets a server-side `max_cost`: its explicit `max_cost`, or its current quote if omitted. Set an explicit per-job `max_cost` for headroom; the sum of reserved caps and prior charges must fit the total. Unresolved older jobs block new submissions.
3. Re-running the same command resumes: finished jobs are skipped, submitted jobs are waited on instead of resubmitted, and skipped or interrupted jobs are submitted. State lives in `<out>/.yir-batch.json`; do not delete it while jobs are running. Failed jobs stay failed unless you pass `--retry-failed`. Download failures exit nonzero; re-running retries the download of the same Job without generating or charging again. Keep one batch process per output directory.
4. Look at the results before using them. Regenerate a weak one by changing its prompt and name (or `--retry-failed` after a failure); a job that already succeeded is never resubmitted.

## Commands

```sh
# Text to image
node scripts/yir.mjs image -m openai/gpt-image-2 --prompt "..." -p resolution=1K -p aspect_ratio=16:9

# Image edit / image-to-image: local file, https URL or an uploaded file_ id
node scripts/yir.mjs image -m openai/gpt-image-2 --prompt "make the sky stormy" --image ./photo.png

# Text to video
node scripts/yir.mjs video -m bytedance/seedance-1.5-pro --prompt "..." -p duration=4 -p resolution=480p

# First-frame video, optional last frame
node scripts/yir.mjs video -m <model> --prompt "..." --ref first_frame=./start.png --ref last_frame=./end.png

# Keyframes between the first and last frame (klingai/kling-4.0: up to 8, total frames <= duration + 1 below 9 s, else 10).
# Keyframes play in --ref order and may repeat a shot; the prompt names them @first_frame, @keyframe_1, @keyframe_2, @last_frame.
node scripts/yir.mjs video -m klingai/kling-4.0 --prompt "@first_frame walks out, crosses @keyframe_1, arrives at @last_frame" -p duration=10   --ref first_frame=./home.png --ref keyframe=./street.png --ref last_frame=./party.png

# First frame plus driving audio (lip sync and beat-matched motion, alibaba/wan-2.7); the audio is kept as the soundtrack
node scripts/yir.mjs video -m alibaba/wan-2.7 --prompt "she sings along to the song" --ref first_frame=./singer.png --ref reference_audio=./vocals.mp3 -p duration=5

# Reference video (roles reference_image / reference_video / reference_audio)
# Prompts name references by position within each role (@image1, @video1). Pass each file once:
# Yir drops a repeated reference (with a parameter_notices entry) unless the prompt numbers past it, then rejects.
# Kling 4.0 uses its own names: @image_1, @video_1, @first_frame, @keyframe_1, @last_frame; a misspelled name is rejected.
node scripts/yir.mjs video -m <model> --prompt "..." --ref reference_image=./character.png

# Characters from photos (Kling 3.0): 2-4 photos per character, up to 3, named with @NAME in the prompt
node scripts/yir.mjs video -m klingai/kling-3.0 --prompt "@hero hands a coffee to @friend" -p aspect_ratio=16:9 \
  --ref reference_image@hero=./hero-front.png --ref reference_image@hero=./hero-side.png \
  --ref reference_image@friend=./friend-front.png --ref reference_image@friend=./friend-side.png

# Edit a video (Seedance 2.5): output length and aspect follow the input video
node scripts/yir.mjs video -m bytedance/seedance-2.5 --prompt "replace the man with a woman in a red coat" --ref reference_video=./clip.mp4 -p duration=auto -p aspect_ratio=auto

# Song with lyrics, instrumental, or lyrics written from the prompt (see Audio below)
node scripts/yir.mjs audio -m minimax/music-2.6 --prompt "warm indie pop, female vocal, summer evening" --lyrics-file ./lyrics.txt
node scripts/yir.mjs audio -m minimax/music-2.6 --prompt "calm lo-fi piano for a product demo" -p instrumental=true
node scripts/yir.mjs audio -m elevenlabs/music-v2.5 --prompt "upbeat synthwave, male vocal" -p lyrics_optimizer=true --duration 120

# Sound effect (1-22 s)
node scripts/yir.mjs audio -m elevenlabs/sound-effects-v2 --prompt "heavy wooden door creaking open" --duration 4

# Text-to-speech: --prompt is the exact text to read; -p voice= picks a preset voice (see Speech below)
node scripts/yir.mjs audio -m minimax/speech-2.8-hd --prompt "清晨六点，城市还没有完全醒来。" -p "voice=Chinese (Mandarin)_News_Anchor"
node scripts/yir.mjs audio -m elevenlabs/eleven-v3 --prompt "[whispers] The sea was finally quiet."

# Existing jobs
node scripts/yir.mjs job <id>                       # status, billing, result links
node scripts/yir.mjs job <id> --wait --download     # wait, then save results
node scripts/yir.mjs cancel <id>
```

Options: `-p key=value` (repeatable), `--image` (reference_image for image jobs, first_frame for video jobs), `--ref role=src` (repeatable), `--lyrics TEXT` / `--lyrics-file PATH` (songs), `--duration SEC` (same as `-p duration=SEC`), `--max-cost USD` (caps the Job's total charge), `--out DIR`, `--name STEM`, `--no-wait`, `--timeout SEC` (default 600 image, 1800 video, 900 music), `--routing JSON`.

## Audio

`audio` runs music, sound-effect and text-to-speech models (the `/v1/audio` endpoints). `music` is its old name and still works, as do `--type music`, `quote music` and batch `type: "music"`. It runs music and sound-effect models from a text prompt (style, mood, scene, or the sound) and optional lyrics (lines separated by newlines, tags such as `[Verse]` and `[Chorus]` allowed). Prompt and lyrics limits are per model. It takes no reference files. Pick one of three forms; the script rejects other combinations before sending anything, and the API rejects forms a model does not offer:

- **Song with your lyrics:** `--lyrics-file ./lyrics.txt` (or `--lyrics "..."` for short text). Vocal music needs lyrics.
- **Instrumental:** `-p instrumental=true`, no lyrics.
- **Lyrics written for you:** `-p lyrics_optimizer=true`, no lyrics; Yir writes them from the prompt for a small extra charge shown in the quote.

Models (check `model <id>` or `quote audio` for current prices):

- `minimax/music-2.6`: all three forms; the model picks the length. About $0.15 per track, plus $0.01 when lyrics are written for you.
- `minimax/music-3`: your own lyrics required, no instrumental or written lyrics; song ends with the lyrics, up to 300 s. Quoted at the 300 s cap ($0.60), charged for the actual length; delivers WAV.
- `elevenlabs/music-v2`, `elevenlabs/music-v2.5`: no custom lyrics; use `-p lyrics_optimizer=true` or `-p instrumental=true`. `--duration` 30, 60, 120, 180, 240 or 300 (default 60); $0.60 per started minute (60 s = $0.60, 300 s = $3.00).
- `elevenlabs/sound-effects-v2`: short sound effects, `--duration` 1-22 s (default 5), no lyrics or switches. About $0.002 per second.
- `suno/suno-v6`, `suno/suno-v6-wild` (experimental), `suno/suno-v6-mini` (efficient, may return shorter tracks): all three forms; every request makes two tracks (`n` is 2), about $0.05-0.06 per request. Suno has no official API; Yir accesses it unofficially through third-party channels. Say so when the user picks it.

## Speech

Text-to-speech models also run through `audio`. `--prompt` is the exact text to read aloud; there are no lyrics, switches or `--duration`. `-p voice=ID` picks a preset voice of that model (omit it for the model default); the voice does not change the price. Billing is per character of the text, spaces, punctuation and audio tags included, so quote long scripts first.

- `minimax/speech-2.8-hd`: strong Chinese, up to 10000 characters, $0.0001 per character ($0.10 per 1000). Voices are MiniMax system voice IDs such as `Chinese (Mandarin)_News_Anchor`, `Chinese (Mandarin)_Gentleman`, `Chinese (Mandarin)_Sweet_Lady`; default `English_expressive_narrator`.
- `elevenlabs/eleven-v3`: expressive English and multilingual, up to 5000 characters, $0.0001 per character; audio tags such as `[whispers]`, `[laughs]` steer delivery and are billed but not spoken. Default voice `JBFqnCBsd6RMkjVDRZzb`.

Only preset voices are available; voice cloning is not offered. A wrong voice ID fails the Job without a charge.

There is no tempo or key control. Each delivered track is saved with its type's extension (`.mp3`, or `.wav` for Music 3); two tracks save as `<name>-1` and `<name>-2`. The measured length is `files[].duration_ms` in the summary and `durations` in the sidecar, which also records the lyrics. Tell the user the length.

Routing: do not pass `--routing` unless the user asks; Yir picks the channel and fails over by itself. When asked, keys are `only` (list of providers), `variants`, `preference` (`cost` default, or `speed`), `fallback` (boolean), `fidelity` and `accelerate` (boolean), e.g. `--routing '{"preference":"speed"}'`. Do not use `only` to save money: channels outside it cannot take over, so the Job fails when the listed channels fail. To cap spend, use `--max-cost` with headroom over the quote; keep `only` for tests or when the user requires a specific channel.

`fidelity` sets how faithful the channel must be to the official model: `genuine` (the default unless the API Key's routing profile sets another) skips channels known to upscale or alter the output, `original` keeps only channels that return the model's native output, `any` applies no filter. Use `{"fidelity":"original"}` when the user says the results will be published or shown as what the model produces (showcases, landing pages, comparisons), and tell them it may cost more or leave fewer channels. If every channel is excluded, generation fails with `YIR_FIDELITY_EXCLUDED`; relax to `genuine`. Each delivered file also carries `fidelity.grade` (`original`, `app`, `equivalent`, `altered` or `unverified`), copied into the sidecar; before presenting a result as the model's own output, check that it is `original`.

`accelerate` is on by default: when an image attempt stalls well past its channel's usual completion time and another eligible channel remains, Yir cuts it off and retries there (if the stalled upstream still bills, that cost is charged and counts toward `--max-cost`). Leave it alone; pass `{"accelerate":false}` only when the user must stay on one slow channel.

## Migrating code from fal

Use this when the user wants existing fal code moved to Yir: `fal_client.subscribe`/`submit` (Python), `fal.subscribe`/`fal.queue.submit` from `@fal-ai/client`, or HTTP calls to `queue.fal.run`/`fal.run`.

1. **Find every fal call.** Note each call's endpoint ID (such as `bytedance/seedance-2.5/image-to-video`) and the request body (`arguments`/`input`). `node scripts/from-fal.mjs --list` shows which fal endpoints map to a Yir model.
2. **Translate each call:** `node scripts/from-fal.mjs <endpoint> --json '<body>' --quote` (or `--file body.json`). When the body is built from variables, translate a representative literal and every value the code can pass (for example each `duration` a UI offers). The script never guesses: it prints the Yir request plus a per-field report, and `--quote` asks Yir for the price without creating a Job.
3. **Read the report before rewriting.**
   - `filled_default`: fal applied a default the code never set, so the Yir request sets it explicitly to keep the output the same (for example Seedance audio on, which Yir would otherwise leave off). Keep these values in the rewritten code.
   - `split`: `num_images` above 1 becomes that many Yir Jobs, each with its own idempotency key.
   - `yir_default`: a Yir parameter fal does not have; Yir's default applies.
   - `errors`: needs a decision; never work around one silently. Typical cases: fal's automatic duration (pick explicit seconds), fal-only options such as `seed`, `negative_prompt` or safety toggles (Yir accepts only their defaults), and sizes with no exact Yir tier (set `resolution`/`aspect_ratio` from `node scripts/yir.mjs model <id>`).
   - An endpoint missing from `--list`, or listed with `supported: false`, has no Yir equivalent yet. Leave that call on fal and say so.
4. **Confirm with the user first.** Show one row per call site: fal endpoint, Yir model, what changes (from the report and errors) and the quoted price per Job. Edit code only after the user agrees.
5. **Rewrite.** The translated `request` is the body for `POST /v1/images/generations` or `/v1/videos/generations` on `https://gateway.yir.ai` with `Authorization: Bearer $YIR_API_KEY`; it returns an async Job to poll at `/v1/jobs/{id}` or receive by Webhook (see https://yir.ai/docs). Replace the fal key with `YIR_API_KEY`. Inputs uploaded with `fal.storage.upload` become a public HTTPS `url` or a Yir `file_id`. Results arrive as short-lived signed URLs in `result.files`; download or store them right away.
6. **Verify.** Quote every rewritten call. Run one real Job per model only if the user approves the cost.

## What to expect

- **Async jobs.** Images usually take tens of seconds; videos and audio take minutes, videos sometimes longer. If the wait times out (exit code 3), the command is interrupted, or the submit failed with a network error, the Job keeps running: re-run the exact same command (same options and `--out`) and it resumes the same Job instead of creating another. `job <id> --wait --download` also works when you have the ID. Until the Job finishes, `<out>/.yir-pending/` holds the request; once it finishes, the same command asks for a new generation.
- **Status** is one of `queued`, `running`, `delivering`, `succeeded`, `failed`, `cancelled`.
- **Billing.** A terminal result can still have `billing.status: pending`; `charged_usd` is the amount charged so far, final only at `settled`. Download results immediately and use `job <id>` to recheck fees; do not call a pending zero charge free. Missing billing status is unconfirmed. Batch caps remain reserved until settlement. New requests omit `billing_mode`; retries preserve the original request and idempotency key, including legacy fields. Delayed settlement sends an independent `job.billing_settled` webhook with a new event ID. Yir may fail over to another channel; an attempt the upstream billed is charged even if it failed or was replaced. Use `--max-cost` on routes with reliable estimates to cap spending. Prices can change between runs, so re-quote and leave headroom over the quote.
- **Result links** are short-lived signed URLs; the script downloads them right away. Re-run `job <id> --download` to fetch again while the result is still available.
- **Input files** are uploaded temporarily for the Job; the script logs the `file_...` ID so it can be reused for a follow-up request.

## Errors

Failures print `{"error": {code, message, action, retryable, request_id}, "hint": ...}` and exit 1; usage errors exit 2 with a message naming the bad option or allowed values.

- `YIR_INSUFFICIENT_BALANCE` or action `add_funds`: ask the user to top up in the Yir Console at https://yir.ai. Do not retry.
- `YIR_SPEND_LIMIT_EXCEEDED`: the API Key's monthly limit is reached; the user can raise it in the Console.
- `YIR_BUDGET_EXCEEDED`: the current price exceeds `--max-cost`; the message names the lowest current estimate. Quote again and tell the user the old cap and the new price, then let them choose: raise `--max-cost`, or pick a cheaper model or spec. Do not raise the cap or relax `fidelity` on your own.
- `YIR_INVALID_REQUEST`, `YIR_MODEL_NOT_FOUND`: re-check with `models` / `model <id>`.
- `YIR_FIDELITY_EXCLUDED`: no channel meets the requested `fidelity`; use `genuine`, or another model.
- `YIR_CONTENT_REJECTED`: the prompt or input was refused; ask the user to change it.
- `YIR_INPUT_REJECTED`: the provider rejected the parameters or input files; `error.provider_error.message` says why (for example a reference video below the pixel minimum). Fix the input and submit again; do not retry unchanged.
- `YIR_NO_EXECUTABLE_ROUTE`, `YIR_TEMPORARILY_UNAVAILABLE`, `YIR_RATE_LIMITED`: try other parameters or another model, or retry later.
- `YIR_EXECUTION_FAILED`, `YIR_OUTCOME_TIMEOUT`, `YIR_RESULT_DELIVERY_FAILED`: the Job failed after trying the available channels; retry once if `retryable` is true, otherwise report the code and `request_id`.
