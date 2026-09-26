# PORT_NOTES — dsh layout spec disposition

Upstream source: `deepseek-harness/packages/client/ui-trajectory/tests/layout.client.spec.tsx`
@ `afd92680f2` (MIT). 22 `it()` cases. Every case is either **ported** (retargeted
to our `TrajectoryFoldRow` ledger input in `shared/dsh/layout.test.ts`) or
**dropped** with the reason from the accepted T2.0 gap map (decision d-a58946cadb).
Rendered-DOM cases belong to the RN renderer suite (T2.6), not the fold spec.

| #   | Upstream case                                                                       | Disposition                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | renders Turn N and the four metric column labels                                    | dropped: rendered-DOM assertion (TrajectoryTurn chrome) — RN renderer tests (T2.6)                                                                                   |
| 2   | renders title and optional description                                              | ported: group `description` (wall span + tool histogram) asserted via `groupDescription` layout output (title present, description emitted when the group has spans) |
| 3   | omits the description node when absent                                              | ported: layout fold emits `description` only when spans/tools exist (single-row and empty-group cases)                                                               |
| 4   | wraps a sticky header and body children                                             | dropped: rendered-DOM assertion (chrome wrapper) — RN renderer tests (T2.6)                                                                                          |
| 5   | expands assistant blocks, hangs usage on Message, and folds call+result into Tool   | ported: message usage buckets + tool pairing over ledger rows (layout.test case 1)                                                                                   |
| 6   | adds runningCalls not already present and leaves their time blank                   | ported: in-flight tool rows carry `timeSeconds: null` (em dash) via `openCallIds` (layout.test case 2)                                                               |
| 7   | appends a streaming partial without rebuilding unaffected finalized turns           | dropped: no partial/streaming input in our recorder (gap map: no chunk clocks, observer-only); live rows arrive as ledger rows with null durations                   |
| 8   | replaces a running-call placeholder with the matching streamed tool call            | dropped: depends on case 7's partial/streaming input; our ledger pairs call+result by callId in the recorder, so no placeholder replacement exists                   |
| 9   | omits duration when node times are missing instead of rendering NaN                 | ported: `durationSeconds` returns null for missing stamps; formatter renders `—` (formatDurationMillis spec in record consumers; layout keeps nulls through)         |
| 10  | builds a wall-span step description with a tool histogram                           | ported: `groupDescription` wall span + `bash×N` histogram (layout.test case 1 via Step group description)                                                            |
| 11  | assigns each user message to its enclosing turn instead of pooling into Turn 1      | ported: ledger rows carry the enclosing turnId; multi-turn ordering test (layout.test case 3)                                                                        |
| 12  | places steering in its resolved step instead of the turn-opening Message group      | dropped: paseo timeline has no steering message kind (no `_paseo` steering rows recorded); would be added with a steering recorder event                             |
| 13  | keeps a running request boundary after steering input                               | dropped: request boundaries come from dsh request-inspection (gap map: dropped); our fold has `requestOnly` support in virtual-rows but no producer                  |
| 14  | uses the following assistant step while a historical window lacks steering Location | dropped: same as 12 (no steering kind) plus eventLocations (gap map: dropped)                                                                                        |
| 15  | places standalone compaction chronologically in its own between-turn section        | dropped: compaction requests are not recorded (gap map: Phase 2 recorder addition); the `compacted` kind + `turn: null` path remain in the model                     |
| 16  | keeps usage and a meaningful summary when assistant has no text block               | ported: message rows always carry usage buckets and a length label even with empty text (recorder emits `assistant message (N chars)` regardless)                    |
| 17  | bounds a long Markdown-like thinking preview while retaining its full detail        | dropped: no thinking/reasoning text recorded (observer-only: lengths only, gap map); preview bounding lives in `preview.ts` and is covered there                     |
| 18  | advances the duration cursor over context and compaction nodes                      | dropped: context/compaction nodes are not recorded (gap map); cursor logic is moot because durations come from ledger stamps                                         |
| 19  | uses the recorded step start for assistant duration when timing exists              | ported: assistant `timeSeconds` folds from `timeMs + durationMs` stamps (layout.test case 1 asserts 1.0s)                                                            |
| 20  | nests settled sub-cells after their parent Tool cell with real durations            | dropped: sub-calls (`run_code` dispatches) are not recorded (gap map)                                                                                                |
| 21  | a running (unsettled) sub-call renders a subtool cell with blank time               | dropped: same as 20                                                                                                                                                  |
| 22  | recursively flattens nested child calls immediately after their parent              | dropped: same as 20                                                                                                                                                  |

Count: **7 ported, 15 dropped** (of which 2 are rendered-DOM cases that move to
the RN suite in T2.6, and 13 are gap-map drops).

The two rendered-DOM drops (1, 4) are re-owned by `plugins/trajectory/client`
component tests in T2.6; the 13 gap-map drops become possible again when the
recorder grows the corresponding event kinds (compaction, steering, sub-calls,
thinking lengths), each needing a matching row here.
