# NoteProject Engineering Guide

## Current Baseline

- Canonical open-source branch: `main`. The pre-publication history remains in the legacy repository on `feature/review-effect-coach-v2`.
- Product boundary: `docs/新的方案.md`.
- Database version: schema 21. Store definitions live in `src/db/reviewCoachSchema.ts`; schema 19 finalizes confirmed legacy facts and removes the six old Coach projection/execution tables, schema 20 adds the device-local `reviewAnnotationDrafts` store, and schema 21 adds three voice-recall local-only stores (`voiceRecallSessions`/`voiceRecallTurns`/`voiceRecallLocalHistory`) that are never added to `CloudSyncEntityType`, backup, export, or record transfer and whose writes must not mark a cloud mutation. See `docs/realtime-voice-recall-design.md` (frozen v1.0) for the full spec.
- AI cockpit implementation is complete: Stages 0-8 were completed and verified on 2026-09-07, and Stage 9 automated release acceptance is complete. Physical-device upgrade and controlled real-account Firebase quota sign-off remain release gates; do not describe the release itself as signed off until they pass.
- Product UI migration is complete through final automated acceptance. `src/styles/visual-v2.css` is the active visual layer; `reading` is the default visual theme and `modern` is the alternative. The visual theme is device-local and independent from the existing light/dark/system setting; do not add it to the database or cloud-sync contract.
- The UI migration preserves formal create/save/rating semantics and routes Review Coach through `Review -> Learning Coach`. All caught errors rendered by React pages/components must pass through `src/lib/uiError.ts`; `src/lib/uiErrorSurface.test.ts` prevents raw `error.message` regressions.
- The 2026-09-08 review-workspace follow-up adds compact primary-page headers, process-lifetime cross-tab rating undo, and a first-stage read-only annotation surface. The annotation toolbar is viewport-fixed and dynamically avoids visible rating controls.

## Review Annotation Boundaries

- Review annotations wrap the read-only review editor and never mutate `RecordBlock.contentHtml`.
- Drafts live only in `reviewAnnotationDrafts`. They are excluded from cloud sync, ZIP/streaming/native backup, knowledge export, and record transfer, and annotation writes must not mark a cloud mutation.
- An unscored draft survives component unmounts, navigation changes, reloads, and app restarts on the same device. A successful rating clears the matching `(recordId, reviewOccurrenceKey)` draft; undoing that rating restores the card but never restores the old annotation.
- Rating undo history belongs to the App-level `ReviewSessionRuntimeState`. It survives navigation while the App root remains mounted, but is not serialized into tab history, Dexie, backup, or sync.
- The current annotation editor supports browsing, pen/highlighter/eraser, basic shapes, text/input/select elements, color, width, opacity, and annotation undo/redo. Selection transforms, grouping, z-order editing, orphan repair, and full Excalidraw parity remain future work; do not describe them as implemented.

## Review Coach Boundaries

- `RecordBlock.contentHtml` is the only editable source of decision-block content. `DecisionBlock` is an index, not a second content copy.
- Formal review-coach writes go through `src/features/reviewCoach/repository.ts`; cross-entity workflows belong in `orchestrator.ts`, not `useAppData.ts`.
- Projections must be rebuildable from formal facts. AI responses and local execution caches are not truth sources.
- Record-level FSRS remains responsible for whole-record scheduling. Decision-block facts must not silently rewrite FSRS state.
- Stage 3 added block feedback, immutable history, tombstones, queue enrollment, exclusion/restoration, analysis notes, and manual legacy-comment association.
- Stage 4 calls only the quick feedback interpreter and preserves original feedback.
- Stage 5 adds the manually confirmed deep-analysis workbench, validated `SessionBlueprint` creation, and deterministic current/waiting/deferred task scheduling.
- Stage 6 adds the dedicated adaptive review page, Blueprint-constrained turn generation, independent question quality review, answer evaluation, hint/skip/invalid/defer/abandon dispositions, and atomic answer/outcome commits.
- Stage 7 schedules delayed verification through deterministic local policy, requires fresh retrieval questions, records retained/decayed outcomes independently from record FSRS, rebuilds block/effect projections from formal facts, and applies aging plus a two-verification streak cap to task selection.
- Stage 8 makes schema 11/16 migration transactional and retryable, retains confirmed legacy quiz/KnowledgePoint facts and record-level comments without automatic block binding, syncs every formal entity and tombstone, archives losing decision-block content conflicts, strips prompts/raw provider responses/secrets at export boundaries, and removes old Coach runtime tables.
- Stage 9 adds deterministic Playwright coverage at desktop and Android-narrow viewports plus isolated Firebase Emulator acceptance for namespace rules, bounded incremental writes, no-op replay, interruption recovery, and revision-based clock-skew convergence.
- The post-Stage-8 cloud audit keeps AI prompts, device-local backup paths, and knowledge-podcast rows/audio outside cloud and portable exports; restore preserves those local values transactionally. Ordinary no-op sync skips the cloud lock, and large read/write plans require explicit confirmation.
- App initialization may refresh due verifications, but must not select or replace the current task. Startup-created verification tasks use IDs and queue timestamps derived from the verification fact so two devices produce identical sync hashes.
- Cloud review-event history is append-only until a checkpoint plus event-tombstone protocol is designed. Do not delete remote events merely because local retention compacts old logs.
- Stage 6 quick-model calls use strict JSON and explicitly disable thinking. Controlled real-provider acceptance may use `https://api.deepseek.com` with `deepseek-v4-flash`; never persist API keys in source, tests, docs, logs, screenshots, backup, or sync data.

## Voice Recall Boundaries

The real-time voice recall feature (`src/features/voiceRecall/`) is implemented through Phase 6 (Phases 0-2: state machine, audio/turn base, DeepSeek streaming LLM real + ASR/TTS Mock-only pending credentials; Phase 3: free-topic and scope sessions + structured session memory + local-only history; Phase 4: record-level review entry and capture-point return; Phase 5: Review Coach deep integration with `answerInputMode`/`transcriptEdited` formal fields; Phase 6: restore/cloud-pull voice-recall store policy + §16 cost gating + real-device checklist). ASR/TTS real integration and the AdaptiveReviewPage inline voice toggle remain pending ASR/TTS credentials. Authority: `docs/realtime-voice-recall-design.md` (frozen v1.0). Agent-facing constraints:

- Original audio, ASR partials, TTS audio chunks, Provider raw responses, and credentials never participate in cloud sync, backup, export, or record transfer. Credentials are injected into adapter instances at session start (runtime, never persisted) and discarded on session end; never in source, tests, logs, or snapshots.
- Open-source repo, automated tests, and preview use only the deterministic Mock Provider; real providers run only in explicit controlled acceptance. The DeepSeek streaming LLM adapter reuses the existing `aiProviders.ts` DeepSeek profile and `aiClientService.ts` URL normalization without persisting keys.
- schema 21 voice-recall tables are local-only; free-topic and scope-practice sessions default local-only; only Coach task-bound sessions reuse existing formal facts (`AdaptiveQuizTurn`/`TaskOutcomeEvent`/`DelayedVerification`). ASR provider/model/confidence/raw transcript stay in local-only turn data, never in formal learning facts.
- Phase 5 §5.1 "one formal answer per turn": `AdaptiveQuizTurn.answerInputMode` (`voice`|`text`) and `transcriptEdited` record only how an answer was entered, never the raw transcript. A submitted turn cannot be overwritten; a follow-up creates a `sequence`-incrementing new turn; `insufficient-context` leaves the turn `displayed` so the same turn can be re-submitted (idempotent). Voice practice never auto-rates FSRS. The AdaptiveReviewPage voice toggle is gated off until ASR/TTS real integration lands.
- Phase 6 §15.1 restore policy: a full backup/streaming restore clears `voiceRecallSessions`/`voiceRecallTurns` (temporary, not transferable) but keeps `voiceRecallLocalHistory`; a cloud pull (`restoreCloudSyncSnapshot*`) preserves all three local-only stores (user's in-device call state and history are never wiped by sync). `voiceRecallLocalHistory` is never cleared on any restore path. Phase 6 §16 cost gating: `voiceCostGating.ts` enforces a 10min default budget, 20min soft cap (request gate — no new turn), 80% one-shot reminder, and annotates every estimate with "仅供参考，以 Provider 账单为准". Real-device acceptance (回声消除/蓝牙/来电/弱网/后台/长会话/配额) is a user checklist at `docs/voice-recall-real-device-acceptance-checklist.md`, not blocking code.
- All voice-recall UI errors pass through `src/lib/uiError.ts` (context `"voice-recall"`); raw Provider responses or keys are never shown. Phase 0 immersive prototype is reachable at `?preview=voice-stage0` (localhost-only, gated out of native/desktop). Phase 3 start page is reachable at `?preview=voice-stage3` (localhost-only, seeded deterministic Mock session).

## Cross-Cutting Checks

When changing decision-block or review-coach behavior, verify all affected paths:

- Dexie migration and repository invariants
- backup/restore and record-transfer round trips
- cloud-sync entity mapping and tombstones
- export privacy at cloud, ZIP, streaming, and native repository boundaries
- read/write quota estimates and no-op lock avoidance
- record deletion and mixed-record cleanup
- Desktop and Android narrow-screen interaction

## Verification

```powershell
npm run test
npm run test:e2e
npm run test:firebase
npm run build
git diff --check
```

Use deterministic mocks in automated tests. Real AI providers are limited to explicit, controlled acceptance runs and must never replace deterministic CI coverage.

The current automated acceptance baseline is `135` Vitest files / `904` tests (as of voice-recall Phase 6), `32` Playwright tests across Desktop and Android-narrow projects, and `3` isolated Firebase Emulator tests. Physical Android keyboard/IME, system back, image gestures, real DeepSeek, and controlled real-account Firebase quota checks remain manual release gates.

For local Stage 3 UI acceptance, run `npm run build`, start `npm run preview -- --host 127.0.0.1 --port 4177`, and open `http://127.0.0.1:4177/?preview=stage3`. This localhost-only query seeds an isolated `BFS Stage3 Preview` record with an overdue review, block feedback, and an analysis-queue item; it is gated out of normal URLs and native shells.

For Stage 4 UI acceptance, use `http://127.0.0.1:4177/?preview=stage4`. It adds a deterministic completed quick-model interpretation with diagnostics and confirmation controls without contacting an AI provider.

For Stage 5 UI acceptance, use `http://127.0.0.1:4177/?preview=stage5`. It seeds deterministic eligible blocks, an OCR warning, a partial analysis result, and current/waiting/deferred tasks without contacting an AI provider.

For Stage 6 UI acceptance, use `http://127.0.0.1:4177/?preview=stage6`. It seeds a deterministic in-progress task with one displayed, quality-checked turn; hints, answer submission, skip, invalid-question reporting, defer, and abandon controls can be exercised without contacting an AI provider.

For Stage 7 UI acceptance, use `http://127.0.0.1:4177/?preview=stage7`. It seeds one in-progress delayed verification plus retained and decayed history, then rebuilds block and intervention-effect projections without contacting an AI provider.

For a combined Review Coach showcase, use `http://127.0.0.1:4177/?preview=coach`. It renders the dashboard, adaptive training, and delayed verification in a localhost-only preview shell. Its controls use deterministic in-memory behavior and do not mount cloud sync or contact an AI provider.
