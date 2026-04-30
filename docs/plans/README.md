# Plans

Design documents and implementation plans, mostly generated with
[Claude Code](https://claude.ai/claude-code). Each file is a snapshot
of the thinking at a point in time — not a commitment.

## Naming convention

- `YYYY-MM-DD-<slug>.md` — implementation plan or design note. The
  date is the day the plan was written, not when it shipped.
- `YYYY-MM-DD-<slug>-design.md` — high-level design decision; the
  matching `<slug>.md` (without `-design`) is the step-by-step plan
  that implements it.

## Status

These files are historical. To know whether a plan shipped, check the
code, `git log`, and the maintained reference docs in
[`../references/`](../references/) and [`../guidelines/`](../guidelines/) —
not this folder. Plans are not amended after the work lands.

## Contributing

Found something a plan implies but the code doesn't reflect (or vice
versa)? Update the relevant living doc under `docs/references/` or
`docs/guidelines/`, not the plan.
