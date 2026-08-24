# Prioritize Existing Text Editor

Status: In Progress
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

- Keep the existing removal and replacement handlers and preservation safeguards unchanged.
- Mount the panel before the embedded viewer and use established dark/indigo utility styling to distinguish it.
- Build, commit to `main`, and verify the production editor route after the Git-connected Vercel deployment.

## Non-Goals

- No changes to PDF mutation, metadata preservation, or editor capabilities.
- No schema, API, or access-control changes.

## Context

- The panel is currently created by `installTextEditingPanel` and appended after `#embed-pdf-container`.
- The viewer is initialized in `src/js/logic/edit-pdf-page.ts`.

## Metadata Notes

- Severity rationale: The feature is functional but difficult to discover in its current placement.
- Priority rationale: The user explicitly requested this layout improvement.
- Folder placement: Move this file to `docs/tasks/completed/` when deployment verification passes.

## Related Codex Plans

- None found; searched `docs/superpowers/plans/` under `/Users/snicklet/Documents/Codex`.

## Plan

- [ ] Mount and visually distinguish the existing text-editing panel above the viewer.
- [ ] Run focused static checks and a production build.
- [ ] Commit on `main`, confirm Vercel production readiness, and inspect `/edit-pdf`.

## Decisions

- UI placement: Insert the custom workflow before `#embed-pdf-container` within the existing wrapper. This preserves the viewer lifecycle while making the workflow first.
- Styling: Reuse existing gray/indigo Tailwind conventions; do not introduce a new visual system.

## Database / Schema Changes

None.

## Verification

- TypeScript check through the production build.
- Inspect the built editor markup and the deployed `/edit-pdf` response.

## Risks and Questions

- The production site is password gated, so interaction verification requires the existing authenticated deployment access.

## Follow-Up Tasks

- None.
