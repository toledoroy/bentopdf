# Prioritize PDF Editor on Home

Status: Done
Task Type: Feature
Severity: Low
Priority: P1
Impact: Users can access PDF Editor immediately from the first main-screen tool card.
Owner: Codex
Created: 2026-08-25
Last Updated: 2026-08-25
Target Area: `src/js/config/tools.ts`
Source Request: User request on 2026-08-25

## Goal

Make PDF Editor the first option in the home screen's Popular Tools section.

## Scope

- Reordered the Popular Tools configuration only.
- Preserved PDF Editor in its existing Edit & Annotate category and retained all search metadata.
- Added a regression assertion for the home-card order, built, and deployed.

## Non-Goals

- No changes to the PDF Editor workflow, routes, or other tool ordering.

## Decisions

- Placement: PDF Editor is first in Popular Tools because it is the requested primary entry point; category membership remains unchanged.

## Database / Schema Changes

None.

## Verification

- `npm run test:run -- src/tests/tools.test.ts` passed (143 tests).
- `npm run build` completed successfully.
- Vercel deployment `dpl_HAcJPM23soVTGjCDgb5fQ6DBP1By` for commit `30aed5e` reached `READY` in production.

## Follow-Up Tasks

- None.
