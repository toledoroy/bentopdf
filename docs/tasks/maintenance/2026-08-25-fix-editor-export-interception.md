# Fix PDF Editor Export Interception

Status: In Progress
Task Type: Maintenance
Severity: High
Priority: P0
Impact: PDF Editor uploads fail before a document opens, blocking the custom text removal/replacement workflow.
Owner: Codex
Created: 2026-08-25
Last Updated: 2026-08-25
Target Area: `src/js/logic/pdf-editor-session.ts`, `src/js/logic/edit-pdf-page.ts`
Source Request: Production upload failure reported with screenshot on 2026-08-25

## Goal

Restore PDF Editor uploads while keeping all saves on the verified export path.

## Scope

- Remove the unsupported mutation of the embedded viewer's export capability that currently aborts viewer initialization.
- Disable the viewer's built-in export command through its supported UI-category configuration.
- Retain the custom verified download button and all preservation checks.
- Build, deploy, and verify production initialization.

## Non-Goals

- No weakening of the PDF preservation guard.
- No PDF mutation, metadata, schema, API, or access-control changes.

## Context

- Production throws `The embedded viewer export path could not be secured` from `PdfEditorSession.interceptUnverifiedExports` during the first upload.
- The embedded viewer exposes `document-export` as a supported disabled category.

## Metadata Notes

- Severity rationale: The feature is inaccessible to every editor user.
- Priority rationale: This is a production regression caused by the previous hardening implementation.
- Folder placement: Move this file to `docs/tasks/completed/` after production verification.

## Related Codex Plans

- None found; searched `docs/superpowers/plans/` under `/Users/snicklet/Documents/Codex`.

## Plan

- [ ] Use the viewer's supported export-category suppression instead of mutating its capability object.
- [ ] Verify the custom download button continues to route through preservation verification.
- [ ] Build, deploy, and confirm the editor initializes in production.

## Decisions

- Export control: Hide the embedded viewer's `document-export` command using its declared configuration API; do not monkey-patch a potentially immutable third-party capability object.
- Save safety: Keep `PdfEditorSession.downloadVerifiedPdf` as the only application-provided download handler. It snapshots and verifies document preservation before download.

## Database / Schema Changes

None.

## Verification

- Production build and focused static checks.
- Browser-based editor upload initialization with a non-sensitive test PDF.
- Production deployment readiness and editor page check.

## Risks and Questions

- The viewer may expose non-UI export APIs internally; BentoPDF's UI will expose only the verified application download control.

## Follow-Up Tasks

- None.
