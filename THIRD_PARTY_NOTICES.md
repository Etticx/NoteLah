# Open-source acknowledgments

NoteLah's interface is an original implementation inspired by a quiet document workspace. It does not include Notion's code, branding, or assets.

NoteLah's MIT licence applies to its original code, not to third-party material. The following is a summary, not a replacement for upstream licence texts. Run `npm run licenses:generate` to collect installed package licence and notice files into `THIRD_PARTY_LICENSES.txt`. The packaging hook regenerates and includes that file, including collected transitive, embedded, font, and Electron/Chromium notices. Review the generated output and actual artifact before release; automatic collection is not a compatibility audit.

- **Next.js** — MIT — https://github.com/vercel/next.js
- **React** — MIT — https://github.com/facebook/react
- **Electron** — MIT, with Chromium and other third-party notices bundled by Electron — https://github.com/electron/electron
- **Radix Primitives** — MIT — https://github.com/radix-ui/primitives
- **Lucide** — ISC — https://github.com/lucide-icons/lucide
- **Inter** — SIL Open Font License 1.1 — https://github.com/rsms/inter
- **sql.js** — MIT; SQLite is public domain — https://github.com/sql-js/sql.js
- **Zod** — MIT — https://github.com/colinhacks/zod
- **PDF.js** — Apache-2.0 — https://github.com/mozilla/pdf.js (including bundled font and character-map notices).
- **@napi-rs/canvas** — MIT — https://github.com/Brooooooklyn/canvas (PDF.js optional Node dependency).

Fontsource packages the Inter font. Electron Builder, TypeScript, tsx, and Playwright are used for development, packaging, and testing.

## Separately installed AI software and models

The current executable does not bundle Ollama or model weights. Users install them separately and remain subject to their respective terms. Product references do not imply endorsement.

- **Ollama** — MIT for the Ollama project; model licences are separate — https://github.com/ollama/ollama/blob/main/LICENSE
- **Qwen3.5-2B** — Apache-2.0 upstream — https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE
- **Nomic Embed Text v1** — Apache-2.0 upstream — https://huggingface.co/nomic-ai/nomic-embed-text-v1/blob/main/LICENSE

Check the exact downloaded tag, upstream version, and any quantization distributor's notices before redistributing weights. The model selector can use other installed models; their terms may differ. No model weights are relicensed by NoteLah's MIT licence.
