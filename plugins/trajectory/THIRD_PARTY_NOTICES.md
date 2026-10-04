# Third-party notices

## deepseek-harness ui-trajectory (partial port)

- Source: `llm-server-monitoring` repository, `external/deepseek-harness/packages/client/ui-trajectory/src/client`
- Ported commit: `afd92680f2`
- License: MIT License — Copyright (c) 2026 DeepSeek (see the upstream `LICENSE`)
- Ported files (`plugins/trajectory/shared/dsh/`): `record.ts` (from `trajectory-record.ts`),
  `preview.ts` (from `trajectory-preview.ts`), `virtual-rows.ts` (from
  `trajectory-virtual-rows.ts`), `timeline.ts` (from `timeline.ts`), `layout.ts`
  (from `layout.ts`), `search-index.ts` (from `trajectory-search-index.ts`), and
  the retargeted specs under `plugins/trajectory/shared/dsh/*.test.ts`.
- Port changes: the react-dom base (`HTMLAttributes<HTMLDivElement>`) is stripped
  from the record contract; dsh runtime/primitives imports are replaced by local
  structural types; the rendering layer (`.tsx`, `*.module.css`, cordis
  definitions) is NOT ported — React Native rendering is our own.
