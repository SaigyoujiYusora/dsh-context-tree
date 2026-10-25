# Implementation notes

The current message editor, tree interface, and branch-navigation implementation were rewritten by isolated implementers from behavioral specifications and host contracts, without access to the implementations being replaced. Earlier repository revisions retain their original source notices; this statement describes the current implementation.

Historical edit-record identifiers are recognized solely for data compatibility. The original editor and conversation-tree packages are neither imported nor required.

The DSH 0.2.1 host integration, scoped prefix reconstruction, branch provenance and compatibility validation are implemented locally for this plugin.

React and the DSH client/session APIs are supplied by the host runtime and are not bundled in this plugin's client build.

The optional Billion integration implements its fork-v2 identity contract and decorates its live native request hook in memory. It does not bundle the compression engine or modify the installed Billion package. Billion remains a separately installed plugin: https://github.com/ranxianglei/billion-context.
