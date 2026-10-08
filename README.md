# Ask All

Ask one question, get answers from several free AIs side by side, then have one of them combine the answers: what they agree on, where they differ (by letter), what only one said, and what to double-check.

Live: https://gutsmcd-cmd.github.io/ask-all/

- **Ask:** one box, Ctrl/⌘ + Enter to send. Every model you turned on answers at the same time, each in its own panel with live typing, time taken, Copy and Retry. If one hits its daily limit or has no key, only that panel shows the problem.
- **Combine:** sends the answers to the model you choose as *Answer A, B, C…* so it can't favour a name. You see who is who. If it hits a limit, a backup model takes over. Can run automatically.
- **History:** the last 50 questions with answers stay on this device. Reopen or delete them.
- **Also ask in ChatGPT / Claude / Grok:** copies your question and opens the site (no API, no cost).

## Free keys (no card)

| Provider | Default models | Free limit (Oct 2026) | Get a key |
|---|---|---|---|
| Google Gemini | `gemini-3.8-flash` (+ optional `gemini-2.5-flash` with Google Search) | Per-project daily limits, shown in AI Studio | https://aistudio.google.com/apikey |
| Groq | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` | ~1,000 requests/day each | https://console.groq.com/keys |
| Mistral | `mistral-large-latest` | Free mode (SMS check) | https://console.mistral.ai |
| OpenRouter (optional) | `nvidia/nemotron-3-ultra-550b-a55b:free` | 50 requests/day total | https://openrouter.ai/keys |
| Cohere (optional) | `command-a-plus-05-2026` | 1,000 calls/month | https://dashboard.cohere.com/api-keys |

Model ids change. Edit them in Settings; **Test key** shows whether each id is in the provider's model list.

## Privacy

- Keys are stored only in this browser (IndexedDB) and sent only to the matching provider. No server, no analytics.
- A Content-Security-Policy only allows network calls to the five provider API hosts.
- Free tiers may use your prompts to train or improve models. Don't paste private information.
- Tip: in Google Cloud Console, restrict the Gemini key to the referrer `https://gutsmcd-cmd.github.io/*`.

## Develop

```bash
npm install
npm run dev
npm run build
```

Vite + TypeScript, no runtime dependencies. Published with GitHub Pages from `.github/workflows/pages.yml`. PWA icons live in `public/icons/`.

MIT License.
