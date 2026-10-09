# review-master

A local GitLab merge request reviewer. It reads remote merge requests directly from GitLab and does not need a project checkout.

## Install and use

Requires Node.js 20.19 or newer.

```sh
npm install -g review-master
review-master account add https://gitlab.example.com
review-master https://gitlab.example.com/group/subgroup/project/-/merge_requests/42
```

The account command prompts for a token without echoing it, verifies it with GitLab, and atomically stores it in `~/.config/review-master/accounts.json` with owner-only permissions. The token needs GitLab's `api` scope for comments, reviews, approvals, reactions and uploaded images. `XDG_CONFIG_HOME` changes the config directory. Accounts are selected by the exact GitLab host. Remove one with `review-master account remove https://gitlab.example.com`; list configured usernames and hosts with `review-master account list`.

The command binds only to `127.0.0.1` on a free port, opens the requested merge request, and exits with the terminal process. Ctrl+C stops the server. No argument prints usage. For local development use `npm run dev` and supply a merge request URL in the page.

## Security and API behavior

Personal access tokens stay in the local config file and are only sent from Nitro to the matching configured GitLab host. Requests are same-origin, the server binds to loopback, and API redirects are rejected so token headers cannot follow a redirect. Self-managed GitLab hosts are supported by adding an account for each origin. GitLab TLS verification remains enabled.

The preview panel is closed by default. Candidates come from successful GitLab deployments and available environments, matched to the merge request head SHA or source branch. It never guesses a deployment URL or uses URLs from notes. Preview URLs must be absolute HTTP(S) URLs without credentials; HTTPS is preferred. The preview iframe receives no GitLab headers and is sandboxed. GitLab's frame restrictions are honored; use “Open” if a site blocks embedding.

Preview discovery reads at most three pages of 100 successful deployments and one page of available environments. Exact head SHA matches rank first; branch matches are marked as potentially stale, and branch matching is disabled for forked merge requests. Production and staging tiers are excluded. A preview with HTTP requires an explicit confirmation. See [Deployments API](https://docs.gitlab.com/api/deployments/), [Environments API](https://docs.gitlab.com/api/environments/), [Review Apps](https://docs.gitlab.com/ci/review_apps/), and [CSP `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).

Review progress is local to the host, user, project, merge request and file content identifier. Unsaved text is stored locally and draft notes are created with GitLab's Draft Notes API. Polling runs every 90 seconds only while the page is visible; focus and manual refresh also update discussions.

GitLab API requests are made on demand: initial MR, project, current user, diffs, discussions and CODEOWNERS; one Repository Files HEAD request per changed path for content identity; and direct group membership requests for owners used by CODEOWNERS. Polling refreshes only MR metadata and discussions. Diff and discussion retrieval is paginated up to 10 pages of 100 records; full file contents are fetched only when requested. A 429 response honors `Retry-After` and applies exponential backoff up to 15 minutes; manual refresh can retry immediately. Related references: [Repository Files](https://docs.gitlab.com/api/repository_files/), [Draft Notes](https://docs.gitlab.com/api/draft_notes/), [CODEOWNERS](https://docs.gitlab.com/user/project/codeowners/), [Merge Requests](https://docs.gitlab.com/api/merge_requests/), and [Discussions](https://docs.gitlab.com/api/discussions/).

## Development checks

```sh
npm run build
npm run typecheck
npm test
npm run benchmark
```

The benchmark reports the cold parse time and heap change for a 20,000 added-line patch using `@pierre/diffs`. Rendering is lazy: only the selected file is parsed. GitLab may omit diffs for collapsed or oversized files; the review shows that state rather than treating missing content as an empty file.

## Removed from the previous application

Electron and Forge packaging, GitHub provider, generic forge abstraction, local clone and Git handling, home/inbox and settings views, AI, semantic/AST/Difftastic/Inspect modes, and desktop release workflows were removed. The application is a Nuxt/Nitro Node CLI with one GitLab API service.
