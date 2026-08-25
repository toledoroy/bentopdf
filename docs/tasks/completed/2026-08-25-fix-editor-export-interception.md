# Fix PDF Editor Export Interception

Status: Done
Task Type: Maintenance
Severity: High
Priority: P0
Impact: PDF Editor uploads again open the custom text removal/replacement workflow.
Owner: Codex
Created: 2026-08-25
Last Updated: 2026-08-25
Target Area: `src/js/logic/pdf-editor-session.ts`, `src/js/logic/edit-pdf-page.ts`
Source Request: Production upload failure reported with screenshot on 2026-08-25

## Goal

Restore PDF Editor uploads while keeping all saves on the verified export path.

## Scope

- Removed the unsupported mutation of the embedded viewer's export capability that aborted viewer initialization.
- Disabled the viewer's built-in export command through its supported UI-category configuration.
- Retained the custom verified download button and all preservation checks.
- Built, deployed, and verified the production deployment.

## Non-Goals

- No weakening of the PDF preservation guard.
- No PDF mutation, metadata, schema, API, or access-control changes.

## Context

- Production threw `The embedded viewer export path could not be secured` from `PdfEditorSession.interceptUnverifiedExports` during the first upload.
- The embedded viewer exposes `document-export` as a supported disabled category.

## Metadata Notes

- Severity rationale: The feature was inaccessible to every editor user.
- Priority rationale: This was a production regression caused by the prior hardening implementation.
- Folder placement: Completed task record.

## Related Codex Plans

- None found; searched `docs/superpowers/plans/` under `/Users/snicklet/Documents/Codex`.

## Plan

- [x] Use the viewer's supported export-category suppression instead of mutating its capability object.
- [x] Verify the custom download button continues to route through preservation verification.
- [x] Build, deploy, and confirm production deployment readiness.

## Decisions

- Export control: Hide the embedded viewer's `document-export` command using its declared configuration API; do not monkey-patch a potentially immutable third-party capability object.
- Save safety: Keep `PdfEditorSession.downloadVerifiedPdf` as the only application-provided download handler. It snapshots and verifies document preservation before download.

## Database / Schema Changes

None.

## Verification

- `npm run test:run -- src/tests/pdf-editor-session.test.ts` passed.
- `npm run build` completed successfully.
- Vercel deployment `dpl_EYBUgNcsRGoAUMfCn9h79LegCMv2` for commit `18d9404` reached `READY` in production.

## Risks and Questions

- A manual post-upload check remains useful for confirming normal interactions with an actual PDF, but this exact initialization failure is covered by a regression test.

## Follow-Up Tasks

- None.
