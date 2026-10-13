# Release notes

For every pull request that changes MergePeek's user-visible behavior, add a Changesets file under `.changeset/` with the appropriate `patch`, `minor`, or `major` bump for `@armaldio/mergepeek` and a concise user-facing summary. Use `npm run changeset` to create one. The pull request check enforces this for shipped application and CLI code.

Do not add a changeset for documentation-only, test-only, or CI/release-workflow changes that do not affect package behavior. Changesets release pull requests are generated automatically and do not need another changeset.
