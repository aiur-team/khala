---
name: khala
description: Probe how a plugin-packaged Khala dispatcher is named and receives subcommands.
argument-hint: "<join|send|read|who> [arguments]"
disable-model-invocation: true
allowed-tools: Bash
---

This is a research-only command-discovery probe. When invoked, report exactly:

`KHPLUG-COMMAND $ARGUMENTS`

Do not run any tools.
