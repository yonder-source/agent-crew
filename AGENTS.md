# AGENTS

## Start and document ownership

Read `spec.md` at the start of each session.

Use `spec.md` for requirements, acceptance criteria, project status and open
contracts; resolve relevant contracts before implementation. Read
`docs/architecture.md` when changing components, interfaces, trust boundaries
or lifecycle behavior. Consult `docs/adr/` for decision rationale. Record changes
in the document that owns the requirement, design or decision.

## Engineering

- Validate external inputs and keep interfaces small. Avoid redundant defaults.
- Check the selected OpenClaw version before reusing native capabilities.
- Keep environment-specific identities, addresses and limits in runtime
  configuration. Keep execution records outside product specifications.
- Keep specification-only changes limited to documentation.

## Collaboration and delivery

Write issues, PRs and commits in English. Use Conventional Commits and GitHub
Flow, with reviewed PRs from short-lived branches.

When behavior changes, find related uses of the same assumption and verify all
affected paths. Run the relevant repository checks and report failures or
checks not run. Review changes to product policy and record unresolved decisions.
