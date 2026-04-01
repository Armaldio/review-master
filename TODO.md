# TODO

- [x] Add recent MRs on the homepage (live list)
    - Replaces the history-based list with a live feed of MRs assigned to or reviewed by the user across all connected providers.
- [ ] Add support for multiple GitLab/GitHub providers
    - Refactor settings to allow an array of accounts, supporting multiple tokens and custom GitLab instances.
- [ ] Implement Smart Polling for live comments/updates
    - Periodically fetch notes/status from the API while in Review View to keep the interface in sync without manual refresh.