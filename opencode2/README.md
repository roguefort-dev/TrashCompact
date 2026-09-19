# OpenCode 2 completion compaction

The companion requests **native OpenCode compaction after each successful completed assistant response**, once the session is idle. OpenCode summarizes eligible older context and preserves its configured recent tail. The companion itself is a native-only trigger. The separate [OpenCode Jev plugin](../docs/SETUP.md) can enrich native summaries on supported releases; its compaction callback was verified on OpenCode 2.0.10 using a synthetic scorer and local model. The installed beta `0.0.0-beta-19157` does not invoke that callback, so its companion compactions receive no Jev enrichment. The companion's beta REST integration has not been validated against 2.0.10.

Tested against installed OpenCode `0.0.0-beta-19157`. Its REST API supports compaction, but its plugin session client does not expose that action. The companion uses the running server's authenticated API and polls durable state, avoiding reliance on events that are lost during disconnection.

Install for your normal `opencode2` background service:

```sh
node opencode2/install-service.mjs --install
```

The user service waits for OpenCode to run, discovers its current local port, and reads authentication privately from OpenCode's service configuration. It does not start OpenCode itself. It covers normal root sessions across projects. Existing idle history is not compacted just because the companion is installed; an existing task becomes eligible when its next response completes. Disable/remove it with:

```sh
node opencode2/install-service.mjs --uninstall
```

Uninstallation retains the private deduplication state. Status and sanitized logs are available through `systemctl --user status trashcompact-opencode2.service` and `journalctl --user -u trashcompact-opencode2.service`.

For an explicit standalone server, run the watcher directly:

```sh
node opencode2/auto-compact.mjs --server http://127.0.0.1:4096 --directory /absolute/project --state /private/path/watcher.json --password-file /private/path/service.json
```

The password file contains JSON with a `password` field. Alternatively supply `OPENCODE_SERVER_PASSWORD` in the environment. Credentials are never placed in request URLs or logged. Omitting `--directory` covers all projects; `--once` runs one scan. The companion's default interval is two seconds.

Behavior and limits:

- Only successful `finish: stop` assistant responses qualify. Tool continuations, failed/interrupted responses, subagents, archived sessions, and compaction messages do not.
- Active sessions and queued work defer admission. A prompt arriving after the checks can run before compaction because admission uses `delivery: queue`; the watcher never requests steering/interruption. Several responses completed while the watcher was offline or the session was busy may be covered by one compaction.
- Request IDs are deterministic and saved before admission. Ambiguous failures retry the same ID at most three times. Server conflicts cannot produce a new compaction ID. Checkpoints do not trigger another compaction.
- API admission is not proof of successful summarization. OpenCode records compaction failures in its history; this companion does not repeatedly retry a failed model summary.
- Frequent native summaries incur the selected model's normal latency/cost and can lose detail. Existing OpenCode compaction settings remain in control of the summary and recent tail.
- One process owns each state file. If forcibly killed, remove a `.lock` only after checking its recorded process is gone. Corrupt state fails closed.

From a repository checkout, run focused tests with `node --test test/opencode2-auto-compact.test.mjs test/opencode2-service.test.mjs`. Test sources are not included in the npm package. An isolated synthetic runtime check verified completed-response checkpoints and polling/restart deduplication on the beta above, without real chats, provider credentials, or Jev; compatibility with other versions remains unverified.

Runtime API contract was inspected from this installed beta's OpenAPI. Public references: [session API](https://opencode.ai/v2/docs/api), [plugin API](https://opencode.ai/v2/docs/build/plugins).
