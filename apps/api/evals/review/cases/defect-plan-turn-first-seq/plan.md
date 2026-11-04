## Goal

Add a table and repository for a card's planning conversation. Turns are numbered per card, and the repository can list them from a sequence number and find the latest engine session.

## Files in scope

- apps/api/data/migrations/20260826130000_plan_turns.sql
- apps/api/src/modules/data/db.ts
- apps/api/src/modules/plan/plan.turn.repository.ts
