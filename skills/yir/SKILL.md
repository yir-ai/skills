---
name: yir
description: Generate and edit images and generate videos through Yir, the image & video API router (GPT Image, Nano Banana, Seedream, FLUX, Seedance, Veo, Kling, Wan and more under one API key). Use when the user asks to create an image from text, edit or restyle an image from a local file or URL, make a video from text or from a first frame / reference image, produce a set of images or clips for a page, deck or article in one batch, compare or pick image/video models and prices, or check, download or cancel a Yir job by ID. Requires YIR_API_KEY.
---

# Yir image and video jobs

All calls go through one zero-dependency script (Node.js 18+). Run it from this skill's directory:

```sh
node scripts/yir.mjs --help
```

It reads `YIR_API_KEY` from the environment. If it is missing or rejected (`YIR_UNAUTHORIZED`), tell the user to create an API Key in the Yir Console at https://yir.ai and export it as `YIR_API_KEY`. Never print or write the key.

## Workflow

1. **Pick a model.** `node scripts/yir.mjs models --type image` (or `--type video`) lists model IDs and input modes (`text`, `image`, `reference`). If the user named a model, use its ID as listed (`creator/model`).
2. **Check parameters and prices.** `node scripts/yir.mjs model <creator/model>` shows each parameter's allowed values and default, accepted reference roles, and listed prices per spec. Omitted required parameters are filled with the defaults.
3. **Quote when cost matters** (video, high resolution, or when the user asks): `node scripts/yir.mjs quote image|video <same options as the job>`. It creates no Job and charges nothing. Check `supply.available` and `price.amount` (USD). Tell the user the price before an expensive job.
4. **Submit.** The script polls until the Job is terminal, downloads results to `--out` (default `./yir-output`) and prints a JSON summary with local `files[].path`, `charged_usd` and `final_provider`. Show the user the local paths.

Give results meaningful names with `--name` (e.g. `--name hero-desktop`). Every saved result gets a `<name>.json` sidecar with the prompt, parameters, references, channel, Job ID and charge, so the asset can be reproduced or credited later. Keep it next to the file.

## Many assets at once (pages, decks, articles)

When the user needs several images or clips, write a plan file and run it as one batch instead of calling `image`/`video` repeatedly:

```json
{
  "defaults": { "type": "image", "model": "openai/gpt-image-2", "params": { "resolution": "2K", "aspect_ratio": "16:9" } },
  "jobs": [
    { "name": "hero", "prompt": "..." },
    { "name": "feature-edit", "prompt": "...", "image": "./before.png" },
    { "name": "hero-mobile", "prompt": "...", "params": { "aspect_ratio": "9:16" } },
    { "name": "demo-clip", "type": "video", "model": "bytedance/seedance-1.5-pro", "prompt": "...", "refs": ["first_frame=./hero.png"], "params": { "duration": 5 } }
  ]
}
```

Each job takes `name` (required, unique, becomes the file name), `type`, `model`, `prompt`, `params` (merged over the defaults), `image`, `refs` (`role=path`), `routing` and `max_cost`. Local paths are relative to the plan file.

```sh
node scripts/yir.mjs batch plan.json --dry-run --out ./assets        # validate and quote every job; submits nothing
node scripts/yir.mjs batch plan.json --max-total 2.00 --out ./assets # run, at most 3 jobs in flight (--concurrency)
```

1. Always `--dry-run` first. It checks every job against the model contract and current supply and reports all problems at once; fix the plan until it passes. Tell the user the quoted total and get approval when it is more than a few dollars.
2. Run with `--max-total` set to the amount the user approved. Before each submit the script checks what earlier jobs actually charged plus what is in flight, and skips jobs that would pass the limit.
3. Re-running the same command resumes: finished jobs are skipped, submitted jobs are waited on instead of resubmitted, and skipped or interrupted jobs are submitted. State lives in `<out>/.yir-batch.json`; do not delete it while jobs are running. Failed jobs stay failed unless you pass `--retry-failed`.
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

# Reference video (roles reference_image / reference_video / reference_audio)
node scripts/yir.mjs video -m <model> --prompt "..." --ref reference_image=./character.png

# Existing jobs
node scripts/yir.mjs job <id>                       # status, billing, result links
node scripts/yir.mjs job <id> --wait --download     # wait, then save results
node scripts/yir.mjs cancel <id>
```

Options: `-p key=value` (repeatable), `--image` (reference_image for image jobs, first_frame for video jobs), `--ref role=src` (repeatable), `--max-cost USD` (caps the Job's total charge), `--out DIR`, `--name STEM`, `--no-wait`, `--timeout SEC` (default 600 image, 1800 video), `--routing JSON`.

Routing: do not pass `--routing` unless the user asks; Yir picks the channel and fails over by itself. When asked, keys are `only` (list of providers), `variants`, `preference` (`cost` default, or `speed`) `fallback` (boolean) and `fidelity`, e.g. `--routing '{"preference":"speed"}'`.

`fidelity` sets how faithful the channel must be to the official model: `genuine` (the default unless the API Key's routing profile sets another) skips channels known to upscale or alter the output, `original` keeps only channels that return the model's native output, `any` applies no filter. Use `{"fidelity":"original"}` when the user says the results will be published or shown as what the model produces (showcases, landing pages, comparisons), and tell them it may cost more or leave fewer channels. If every channel is excluded, generation fails with `YIR_FIDELITY_EXCLUDED`; relax to `genuine`. Each delivered file also carries `fidelity.grade` (`original`, `app`, `equivalent`, `altered` or `unverified`), copied into the sidecar; before presenting a result as the model's own output, check that it is `original`.

## What to expect

- **Async jobs.** Images usually take tens of seconds; videos take minutes and sometimes longer. If the wait times out (exit code 3), the command is interrupted, or the submit failed with a network error, the Job keeps running: re-run the exact same command (same options and `--out`) and it resumes the same Job instead of creating another. `job <id> --wait --download` also works when you have the ID. Until the Job finishes, `<out>/.yir-pending/` holds the request; once it finishes, the same command asks for a new generation.
- **Status** is one of `queued`, `running`, `delivering`, `succeeded`, `failed`, `cancelled`.
- **Billing.** The charge follows the upstream channel that actually ran the Job, so the final `charged_usd` can differ from the quote. Yir may fail over to another channel; an attempt the upstream billed is charged even if it failed or was replaced. Use `--max-cost` to cap spending.
- **Result links** are short-lived signed URLs; the script downloads them right away. Re-run `job <id> --download` to fetch again while the result is still available.
- **Input files** are uploaded temporarily for the Job; the script logs the `file_...` ID so it can be reused for a follow-up request.

## Errors

Failures print `{"error": {code, message, action, retryable, request_id}, "hint": ...}` and exit 1; usage errors exit 2 with a message naming the bad option or allowed values.

- `YIR_INSUFFICIENT_BALANCE` or action `add_funds`: ask the user to top up in the Yir Console at https://yir.ai. Do not retry.
- `YIR_SPEND_LIMIT_EXCEEDED`: the API Key's monthly limit is reached; the user can raise it in the Console.
- `YIR_BUDGET_EXCEEDED`: the cost exceeds `--max-cost`.
- `YIR_INVALID_REQUEST`, `YIR_MODEL_NOT_FOUND`: re-check with `models` / `model <id>`.
- `YIR_FIDELITY_EXCLUDED`: no channel meets the requested `fidelity`; use `genuine`, or another model.
- `YIR_CONTENT_REJECTED`: the prompt or input was refused; ask the user to change it.
- `YIR_NO_EXECUTABLE_ROUTE`, `YIR_TEMPORARILY_UNAVAILABLE`, `YIR_RATE_LIMITED`: try other parameters or another model, or retry later.
- `YIR_EXECUTION_FAILED`, `YIR_OUTCOME_TIMEOUT`, `YIR_RESULT_DELIVERY_FAILED`: the Job failed after trying the available channels; retry once if `retryable` is true, otherwise report the code and `request_id`.
