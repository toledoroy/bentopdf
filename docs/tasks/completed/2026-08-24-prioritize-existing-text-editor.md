# Prioritize Existing Text Editor

Status: Done
Task Type: Feature
Severity: Medium
Priority: P1
Impact: PDF Editor users can find the custom destructive text removal/replacement controls before the embedded editor controls.
Owner: Codex
Created: 2026-08-24
Last Updated: 2026-08-24
Target Area: `src/js/logic/pdf-text-editing.ts`
Source Request: Referenced ChatGPT conversation `6a8074ff-207c-83ec-a024-7fbfd72e6d49`

## Goal

Place the custom **Remove / Replace Existing Text** workflow first in the PDF Editor, in a visually distinct block above the embedded viewer.

## Scope

- Kept the existing removal and replacement handlers and preservation safeguards unchanged.
- Mounted the panel before the embedded viewer with established dark/indigo utility styling.
- Built, committed to `main`, and verified the Git-connected Vercel production deployment.

## Non-Goals

- No changes to PDF mutation, metadata preservation, or editor capabilities.
- No schema, API, or access-control changes.

## Context

- The panel is created by `installTextEditingPanel`; it now inserts before `#embed-pdf-container`.
- The viewer is initialized in `src/js/logic/edit-pdf-page.ts`.

## Metadata Notes

- Severity rationale: The feature was functional but difficult to discover in its former placement.
- Priority rationale: The user explicitly requested this layout improvement.
- Folder placement: Completed task record.

## Related Codex Plans

- None found; searched `docs/superpowers/plans/` under `/Users/snicklet/Documents/Codex`.

## Plan

- [x] Mount and visually distinguish the existing text-editing panel above the viewer.
- [x] Run focused static checks and a production build.
- [x] Commit on `main`, confirm Vercel production readiness, and inspect the deployed editor.

## Decisions

- UI placement: Insert the custom workflow before `#embed-pdf-container` within the existing wrapper. This preserves the viewer lifecycle while making the workflow first.
- Styling: Reuse existing gray/indigo Tailwind conventions; do not introduce a new visual system.

## Database / Schema Changes

None.

## Verification

- `npm run build` completed successfully, including TypeScript and the production bundle.
- Vercel deployment for commit `16c5e12` reached `READY` in production.
- The deployed editor page at `/edit-pdf.html` loads with the PDF uploader and no browser console errors. The panel is created only after a PDF is uploaded; no document was uploaded during production verification.

## Risks and Questions

- The production site is password gated. A full post-upload visual check requires uploading a PDF in the authenticated editor session.

## Follow-Up Tasks

- None.
