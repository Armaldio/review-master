# Release notes

Every pull request must include a Changesets file under `.changeset/`. For a user-visible package change, use `npm run changeset` and choose the appropriate `patch`, `minor`, or `major` bump for `@armaldio/mergepeek` with a concise user-facing summary. For a PR that does not need a package release, use `npm run changeset -- --empty`.

The required `changeset-check` status enforces this on `master`. Changesets-generated Version Packages PRs are exempt and do not need another changeset.
