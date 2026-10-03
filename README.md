# Question Bank reviewed source

Cloudflare at https://question-bank-78u.pages.dev is the sole production application. GitHub Pages is not enabled for this repository.

This repository contains an allowlisted source snapshot, locked build dependencies, synthetic tests, and already-public immutable question banks. It contains no original Git history, environment secrets, private question banks, accounts, learner answers/history, raw reports, Telegram conversations, research evidence, or user screenshots.

Report automation is staged and disabled until its production ReportOperationStore binding, exact approver identity, source branch required checks, trusted workflow/source SHA, protected production environment and secure release credentials are independently configured and verified. An empty/missing approval or trust configuration fails closed. A PR merge is not publication success; successful completion requires a compatible Cloudflare deployment and exact revision/hash/domain/deployment readback.

Public correction requests contain only approved public content edits and opaque operation references. Original notes, reporter/contact/account/browser/provider fields remain in the controlled service. Proposed checkouts are data only: trusted tooling comes from a fixed audited SHA.

Local verification: `node --test tests/native-report*.test.mjs tests/report-public-privacy.test.mjs tests/report-oidc.test.mjs`.
