# Rekin

TypeScript port of [google-research/harness2](https://github.com/google-research/harness2):
recursive agent harnessing for an open world. Package name matches the parent
directory (`Rekin`).

## Install

```bash
npm install
npm run build
npm test
```

## Demo (no model credentials)

```bash
npm run demo -- --output runs/demo --k 2
```

CLIs after build: `rekin`, `rekin-demo`, `rekin-check`, `rekin-setup`,
`rekin-judge`, `rekin-report`, `rekin-bridge` (also aliased as `harness2*`).

## Status

Core method layer is ported for the local demo path: tree, ledger, recursion
(parallel/sequential), selection, library, runmark, judge/report, substrates
(OpenCode + Codex surfaces), and demo CLI. Run `npm test` for the current suite.
