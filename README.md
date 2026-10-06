# Yir Agent Skills

Official [Agent Skills](https://agentskills.io) for [Yir](https://yir.ai), the image & video API router.

The `yir` skill lets coding agents such as Claude Code and Codex generate images, edit images from local files, and generate videos through one Yir API key. It lists models and prices, quotes a request, submits the job, waits for the result and saves the files locally.

## Requirements

- Node.js 18 or later. The bundled script has no dependencies.
- A Yir API key. Create one in the Yir Console at [yir.ai](https://yir.ai), then set it in the environment your agent runs in:

```sh
export YIR_API_KEY="..."
```

Jobs are billed to your Yir wallet. Top up in the Console.

## Install

Copy `skills/yir` into your agent's skills directory.

Claude Code (personal, or `.claude/skills/` inside a project):

```sh
git clone https://github.com/yir-ai/skills.git
cp -r skills/skills/yir ~/.claude/skills/yir
```

Codex:

```sh
cp -r skills/skills/yir ~/.codex/skills/yir
```

Other agents that support `SKILL.md` skills work the same way: point them at the `skills/yir` folder.

## Use

Ask your agent in plain language, for example:

- "Generate a 16:9 hero image of a lighthouse at dusk with Yir."
- "Use Yir to turn ./logo.png into a watercolor version."
- "Make a 5-second video from ./first-frame.png."
- "Check Yir job 2106985418292465664 and download the result."

You can also run the script directly:

```sh
node skills/yir/scripts/yir.mjs models --type image
node skills/yir/scripts/yir.mjs model openai/gpt-image-2
node skills/yir/scripts/yir.mjs quote image -m openai/gpt-image-2 --prompt "a lighthouse at dusk"
node skills/yir/scripts/yir.mjs image -m openai/gpt-image-2 --prompt "a lighthouse at dusk" -p aspect_ratio=16:9
node skills/yir/scripts/yir.mjs video -m bytedance/seedance-1.5-pro --prompt "waves at night" -p duration=4
node skills/yir/scripts/yir.mjs job <id> --wait --download
```

Results are saved to `./yir-output` by default (`--out` to change). Run `--help` for all options.

## Links

- Documentation: [yir.ai/docs](https://yir.ai/docs)
- SDKs: [yir-ai/sdk](https://github.com/yir-ai/sdk)

## License

[MIT](LICENSE)
