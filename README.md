# MergePeek

A local GitLab merge request reviewer. It reads remote merge requests directly from GitLab and does not need a project checkout.

## Install and use

Requires Node.js 20.19 or newer.

```sh
npm install -g @armaldio/mergepeek
mpeek https://gitlab.example.com/group/subgroup/project/-/merge_requests/42
```

MergePeek uses an existing `glab` login for the exact GitLab host first. Run `glab auth login --hostname gitlab.example.com` if needed. It asks `glab config get token --host <hostname>` and verifies the candidate against that host's `/api/v4/user` endpoint before using it. This supports glab's host config, keyring and documented environment-token resolution. See [glab config get](https://docs.gitlab.com/cli/config/get/) and [glab auth status](https://docs.gitlab.com/cli/auth/status/). If glab has no usable login for that host, the legacy saved account is used. Add one with `mpeek account add https://gitlab.example.com`; the command prompts for a token without echoing it and atomically stores it in `~/.config/review-master/accounts.json` with owner-only permissions. The token needs GitLab's `api` scope. `XDG_CONFIG_HOME` changes the config directory. `mpeek account list` and `mpeek account remove https://gitlab.example.com` manage these optional fallback accounts. Existing installations can continue using the `review-master` command alias.

The command binds only to `127.0.0.1:4173` by default and opens the requested merge request. Reusing the same local origin keeps browser review state available after restarting the CLI. Set `REVIEW_MASTER_PORT` to use another local port if 4173 is already in use. For a separate browser host, set `REVIEW_MASTER_HOST` to a reachable interface and add that hostname or IP to `REVIEW_MASTER_ALLOWED_HOSTS`. Ctrl+C stops the server. No argument prints usage. For local development use `npm run dev` and supply a merge request URL in the page.

While the CLI is running, its terminal reports a new commit (short SHA), the number of newly published comments, or when the MR is merged or closed. It seeds the current MR on load, so existing activity is not announced; later changes are detected on the app's normal refreshes (every 90 seconds while visible, or on manual/focus refresh). Log lines contain no comment text, author names or credentials. The local server binds to `127.0.0.1:4173` by default; set `REVIEW_MASTER_HOST` and `REVIEW_MASTER_PORT` to choose another bind address and port when opening it from a separate browser host.

## Security and API behavior

GitLab credentials are resolved for the MR URL's exact host. glab credentials are never copied into MergePeek's account file or browser storage; manually configured fallback tokens stay in the existing local config file. The server binds to loopback by default. For a separate browser host, `REVIEW_MASTER_HOST` selects the bind address and `REVIEW_MASTER_ALLOWED_HOSTS` explicitly lists additional trusted hostnames; requests must still have a matching same-origin header. Allowing a non-local host gives clients on that network access to GitLab actions, so use it only on a trusted network. API redirects are rejected so credential headers cannot follow a redirect. GitLab TLS verification remains enabled.

Each local API operation resolves and verifies auth once; glab is not launched per diff row or line. The validation workspace has no installed glab binary, so the auth subprocess test used a mock: 30 local `glab` process launches plus a mocked `/user` check measured 5.96 ms median and 12.66 ms p95, excluding network latency to GitLab. Host, keyring/config and environment candidate behavior is covered by mocked resolver tests; a live keyring login could not be exercised here.

The preview panel is closed by default. Candidates come from successful GitLab deployments and available environments, matched to the merge request head SHA or source branch. It never guesses a deployment URL or uses URLs from notes. Preview URLs must be absolute HTTP(S) URLs without credentials; HTTPS is preferred. The preview iframe receives no GitLab headers and is sandboxed. GitLab's frame restrictions are honored; use “Open” if a site blocks embedding.

Preview discovery reads at most three pages of 100 successful deployments and one page of available environments. Exact head SHA matches rank first; branch matches are marked as potentially stale, and branch matching is disabled for forked merge requests. Production and staging tiers are excluded. A preview with HTTP requires an explicit confirmation. See [Deployments API](https://docs.gitlab.com/api/deployments/), [Environments API](https://docs.gitlab.com/api/environments/), [Review Apps](https://docs.gitlab.com/ci/review_apps/), and [CSP `frame-ancestors`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).

Opening a file does not mark it reviewed. Use **Mark reviewed** / **Mark unreviewed**; optional auto-advance moves to the next unreviewed file. Progress is stored in browser local storage by host, user, project and merge request, and is retained across MR updates when the file blob identity is unchanged. If browser storage is unavailable, the page reports that local state could not be saved. Unsaved comment and draft-note edits are saved locally by file or note and survive navigation, refresh and reload.

GitLab draft notes load separately from published discussions and can be edited, deleted or published. The app refreshes both lists during manual, focus and 90-second visible-page refreshes. Mark ready posts GitLab's documented `/ready` quick action. Approve and unapprove use the Merge Request Approvals API; request changes posts the documented `/submit_review requested_changes` quick action.

GitLab API requests are made on demand: initial MR, project, current user, diffs, discussions, draft notes and CODEOWNERS; one Repository Files HEAD request per changed path for content identity; and direct group membership requests for owners used by CODEOWNERS. Polling refreshes MR metadata, discussions and draft notes. Diff, discussion and draft-note retrieval is paginated up to 10 pages of 100 records; full file contents are fetched only when requested. A 429 response honors `Retry-After` and applies exponential backoff up to 15 minutes; manual refresh can retry immediately. Related references: [Repository Files](https://docs.gitlab.com/api/repository_files/), [Draft Notes](https://docs.gitlab.com/api/draft_notes/), [Merge Requests](https://docs.gitlab.com/api/merge_requests/), [Merge Request Approvals](https://docs.gitlab.com/api/merge_request_approvals/), [Quick Actions](https://docs.gitlab.com/user/project/quick_actions/), [CODEOWNERS](https://docs.gitlab.com/user/project/codeowners/), and [Discussions](https://docs.gitlab.com/api/discussions/).

## Development checks

```sh
npm run build
npm run typecheck
npm test
npm run benchmark
npm run benchmark:browser
```

## npm releases

Every pull request needs a Changesets file under `.changeset/`; the `changeset-check` required status on `master` enforces it, and `AGENTS.md` tells contributors and coding agents how to add one. Run `npm run changeset` and choose the appropriate `patch`, `minor`, or `major` bump with a user-facing summary for a package change. Use `npm run changeset -- --empty` when no package release is needed. Changesets-generated version PRs are exempt.

The single `.github/workflows/publish-npm.yml` workflow handles the release lifecycle on `master`: after a merge with pending changesets, it verifies the build and asks Changesets to create or update a `Version Packages` PR. Merging that version PR triggers the same workflow again; it reruns verification and publishes the new version to npm with GitHub Actions OIDC Trusted Publishing. Existing versions are never republished. There is no npm token secret. In GitHub Actions settings, allow Actions to create pull requests; keep the npm Trusted Publisher configured for GitHub owner `Armaldio`, repository `review-master`, and workflow `publish-npm.yml`.

`npm run benchmark` measures parsing time and heap change for a 20,000 added-line patch. The browser benchmark starts the production Nitro build in headless Chromium and covers 40 files of 60–300 changed lines each and two 20,000-line single-hunk files. It measures initial usable rows, repeated scrolling (three 30-frame rounds), file switching, heap, DOM, long tasks and layout/style recalculations. It also checks large-file split/unified switching, line/range comment positions, and that a discussion refresh does not mutate the unchanged diff.

| Pathological workload | Earlier PR baseline | Final pass |
| --- | ---: | ---: |
| First usable diff row | 971 ms | 560 ms |
| 30 scroll frames | 15.4 s | 1.015 s median (three rounds) |
| Scroll frame p95 | not recorded | 60.5 ms across 90 frames |
| Median file switch | 5.55 s | 254 ms |
| Peak main-thread heap | not recorded | 11.6 MB |
| Mounted diff rows | 100 | 28 |

The final 40-file run rendered its first row in 704 ms, switched files in 97 ms median, and used 17.6 MB peak main-thread heap. The parser benchmark took 30.3 ms with a 4.4 MB heap increase. The earlier scroll harness did not wait for rendering to settle; the final harness waits for a rendered row and repeats the same scrolling path three times, so its scroll results are more representative and less sensitive to one delayed frame. Synthetic local measurements vary with host load and are not a GitLab network benchmark.

Profiling the earlier 20k-line view showed repeated `getBoundingClientRect` calls in Pierre's virtualizer's scroll-anchor work consuming about 3.2 seconds over 30 frames, in addition to code-column DOM updates. The large standalone-file path now uses Pierre's `CodeView`, which virtualizes with numeric line anchors, and caps syntax tokenization at 10,000 lines for larger diffs. Remaining rows keep line numbers, selection, comments and discussions, while avoiding a syntax-tokenization pass over every line. Pierre remains because it provides the required virtualized diff interactions and the measured bottleneck was in layout/highlighting work; replacing the diff engine is not supported by benchmark evidence. Discussion polling leaves unchanged diff DOM untouched in the browser regression check. Very large single-hunk files remain the most expensive path, and lines beyond the 10,000-line syntax limit are plain text.

`npm audit` reports 14 findings (7 high, 7 critical), all in the Nuxt/Nitro development and build dependency tree; `npm audit --omit=dev` reports zero. Findings include simple-git and its argv parser through Nuxt DevTools, which is disabled in this app, node-forge through the development server chain, and globbing/micromatch packages used by build tooling. They do not ship in the generated production Nitro package, but remain relevant when installing or running the development/build toolchain. A dry-run of `npm audit fix` offered no compatible changes; the forced full fix downgrades Nuxt 4.6.1 to 3.7.4. No unsafe downgrade or transitive major override was applied. The remaining audit findings should be rechecked after upstream compatible releases.

## Removed from the previous application

Electron and Forge packaging, GitHub provider, generic forge abstraction, local clone and Git handling, home/inbox and settings views, AI, semantic/AST/Difftastic/Inspect modes, and desktop release workflows were removed. The application is a Nuxt/Nitro Node CLI with one GitLab API service.
