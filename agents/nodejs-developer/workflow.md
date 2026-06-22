# nodejs-developer Workflow

## Code Style
- Use ES modules (`import`/`export`), never `require()`
- Use `async`/`await`, never `.then()`/`.catch()` chains
- Prefer early returns over nested conditionals
- Add JSDoc to all exported functions

## Naming
- Files: `kebab-case.js`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE` for env vars, `camelCase` for computed values

## Branching
- Feature branches: `feat/issue-{id}-{short-slug}`
- Spike branches: `spike/issue-{id}-{short-slug}`
- Always branch from `main`

## Pull Requests
- Title: imperative mood, under 60 chars (e.g. "Add user auth middleware")
- Body: what changed and why — no "I did X" language
- Link the issue in the PR body: `Closes #n`

## Error Handling
- Validate only at system boundaries (user input, external API responses)
- Let internal errors surface naturally — don't swallow them
- Log errors with enough context to reproduce (include relevant IDs)

## Testing
<!-- Add your testing preferences here -->

## Other Preferences
<!-- Add anything else you want the agent to know -->
