---
name: yir
description: Generate and edit images and generate videos through Yir, the image & video API router (GPT Image, Nano Banana, Seedream, FLUX, Seedance, Veo, Kling, Wan and more under one API key). Use when the user asks to create an image from text, edit or restyle an image from a local file or URL, make a video from text or from a first frame / reference image, compare or pick image/video models and prices, or check, download or cancel a Yir job by ID. Requires YIR_API_KEY.
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

Options: `-p key=value` (repeatable), `--image` (reference_image for image jobs, first_frame for video jobs), `--ref role=src` (repeatable), `--max-cost USD` (caps the Job's total charge), `--out DIR`, `--no-wait`, `--timeout SEC` (default 600 image, 1800 video), `--routing JSON`.

Routing: do not pass `--routing` unless the user asks; Yir picks the channel and fails over by itself. When asked, keys are `only` (list of providers), `variants`, `preference` (`cost` default, or `speed`) and `fallback` (boolean), e.g. `--routing '{"preference":"speed"}'`.

## What to expect

- **Async jobs.** Images usually take tens of seconds; videos take minutes and sometimes longer. If the wait times out (exit code 3), the Job keeps running: resume with `job <id> --wait --download` instead of submitting again.
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
- `YIR_CONTENT_REJECTED`: the prompt or input was refused; ask the user to change it.
- `YIR_NO_EXECUTABLE_ROUTE`, `YIR_TEMPORARILY_UNAVAILABLE`, `YIR_RATE_LIMITED`: try other parameters or another model, or retry later.
- `YIR_EXECUTION_FAILED`, `YIR_OUTCOME_TIMEOUT`, `YIR_RESULT_DELIVERY_FAILED`: the Job failed after trying the available channels; retry once if `retryable` is true, otherwise report the code and `request_id`.
