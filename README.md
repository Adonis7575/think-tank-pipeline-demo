# Think Tank Pipeline

A browser replay of a three-agent planning workflow. The Strategist, Builder, and Editor take turns refining a fictional community garden sign-up. The procedural Three.js scene responds to each handoff, and the transcript updates as events arrive.

```sh
npm ci
npm run dev
```

Use Node.js 22.12 or newer. Open the printed local address and select **Replay demo**. The transcript works on its own when WebGL is unavailable.

The replay streams synthetic NDJSON events inside the browser. It demonstrates message framing and completion checks with no model, account, or API key. It contains no original prompts, training data, model weights, or personal workspace.

`npm test` checks stream parsing and scene motion. `npm run build` typechecks the app and builds the static site.
