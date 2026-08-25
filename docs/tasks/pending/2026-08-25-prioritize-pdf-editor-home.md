# Prioritize PDF Editor on Home

Status: In Progress
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

- Reorder the Popular Tools configuration only.
- Preserve PDF Editor in its existing Edit & Annotate category and retain all search metadata.
- Add a regression assertion for the home-card order, then build and deploy.

## Non-Goals

- No changes to the PDF Editor workflow, routes, or other tool ordering.

## Decisions

- Placement: PDF Editor is first in Popular Tools because it is the requested primary entry point; category membership remains unchanged.

## Database / Schema Changes

None.

## Verification

- Focused tools configuration test and production build.
- Production deployment readiness.

## Follow-Up Tasks

- None.
