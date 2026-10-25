# Attribution

The React interaction layout, message-tree rendering, client helpers and branch-navigation logic are adapted from [Unintendedz/dsh-conversation-tree](https://github.com/Unintendedz/dsh-conversation-tree) v0.8.0 (commit f012b1701dae239ab4f09a97dedd78c9fa5aa071), under MIT. The original copyright and permission notice are preserved in [LICENSES/dsh-conversation-tree-MIT.txt](LICENSES/dsh-conversation-tree-MIT.txt).

The message-edit projection was independently reimplemented from the DSH Session projection contract and behavioral requirements. Historical edit-record identifiers are recognized solely for data compatibility; the original editor package is neither imported nor required.

The DSH 0.2.1 host integration, scoped prefix reconstruction, branch provenance and compatibility validation are implemented locally for this plugin.

The optional Billion integration implements its fork-v2 identity contract and decorates its live native request hook in memory. It does not bundle the compression engine or modify the installed Billion package. Billion remains a separately installed plugin: https://github.com/ranxianglei/billion-context.
