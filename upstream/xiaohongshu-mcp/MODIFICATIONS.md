# Modified service snapshot

Base: [xpzouying/xiaohongshu-mcp v2.5.5](https://github.com/xpzouying/xiaohongshu-mcp/tree/v2.5.5), licensed under Apache-2.0. The original license is retained in LICENSE.

This directory contains the locally adapted service used by dsh-xhs-whale. It is not an official upstream release. Source files carry a notice identifying this modified distribution.

Local adaptations include:

- checked_handlers.go, routes.go: checked-comment, identity and owner-resolution HTTP endpoints.
- xiaohongshu/checked_comment.go and checked_comment_match.js: account/target preflight checks, selecting a real mention candidate, reply handling and submitted-comment verification.
- types.go, xiaohongshu/user_profile.go: public user-profile lookup and profile reading used by manual follow-up tasks.
- profile_request_test.go, xiaohongshu/checked_comment_test.go: regression checks. Personal identifiers in fixtures have been replaced with fictional values.

Packaging retains the Go module, application/library sources, embedded browser version and JavaScript matcher, and the two local regression test files. Upstream screenshots, examples, deployment files and browser/live-account integration tests are omitted. See the pinned upstream tree for the complete original distribution and its tests.

Build from this directory with `go build .`; on Windows, prefer the root project's build script, which also creates the integrity manifest required by its launcher.
