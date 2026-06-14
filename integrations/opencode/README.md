# MemPalace OpenCode Integration

OpenCode plugin that captures live session transcripts into MemPalace on every `session.idle` and `session.compacted` event. Each capture spawns `mempalace mine` against a JSONL snapshot of the conversation, scoped to a wing derived from the working directory.

## What it does

- Listens for OpenCode `session.idle` and `session.compacted` events.
- Debounces 3 seconds per session ID, so rapid event bursts collapse to one fire.
- Fetches the live message list via `ctx.client.session.messages`, serializes text turns, reasoning blocks, tool calls, tool results, and file references into JSONL.
- Writes the snapshot to `$TMPDIR/mempalace-opencode/<sessionID>/session-<ISO-timestamp>.jsonl`. Each fire produces a new timestamped file so MemPalace's source-file deduplication does not collapse later snapshots.
- Spawns `mempalace mine <dir> --mode convos --wing <normalized-cwd-basename> --agent opencode` detached, with `inFlight` tracking to drop overlapping fires.
- Wing names normalize to lowercase with spaces and hyphens replaced by underscores, matching `mempalace`'s `normalize_wing_name` so `Mixed Case-Name` -> `mixed_case_name`.

Failure-open by design: if the message fetch rejects or the mine spawn errors, the plugin logs to stderr and the session continues.

## Install via Nix flake output

The fork exposes the plugin as `packages.<system>.opencode-plugin` with `passthru.agents` metadata that OpenCode's plugin loaders consume directly.

In a flake-based OpenCode config:

```nix
{
  inputs.mempalace.url = "github:shgew/mempalace";

  outputs = { mempalace, ... }: let
    pkg = mempalace.packages.${system}.opencode-plugin;
  in {
    # Pass `pkg` to your OpenCode plugin list. The `passthru.agents.opencode.entrypoint`
    # field (`plugin.js`) and the `passthru.agents.backends` list (`[ "opencode" ]`)
    # tell the loader how to mount it.
  };
}
```

The output is a `runCommand`-built directory containing one file:

```
<store-path>/
  plugin.js
```

And carries:

```nix
passthru.agents = {
  backends = [ "opencode" ];
  opencode = {
    entrypoint = "plugin.js";
  };
};
```

Build it directly:

```bash
nix build github:shgew/mempalace#opencode-plugin
ls result/   # plugin.js
```

## Install manually (no Nix)

OpenCode loads plugins by URL spec. Reference `plugin.js` directly in `opencode.json`:

```json
{
  "plugin": [
    "file:///absolute/path/to/integrations/opencode/plugin.js"
  ]
}
```

or symlink the file into your OpenCode plugin directory and load it however your setup expects.

## Environment

- `MEMPALACE_BIN` (optional): absolute path to the `mempalace` executable used for the `mine` spawn. Defaults to `mempalace` on `PATH`. Nix consumers typically set this to `${mempalacePkg}/bin/mempalace` so the plugin does not depend on shell PATH.

The plugin reads no other environment. Wing scoping, mining mode, and agent name are derived at fire time.

## Behavior contract

`plugin.test.js` (bun:test, co-located) pins the following:

1. Exports only the `event` hook.
2. Fires `mine` after the 3-second debounce on `session.idle`.
3. Normalizes the wing name (lowercase, spaces and hyphens to underscores).
4. Fires on `session.compacted` too.
5. Drops a second capture for the same session while the first `mine` spawn is in flight.
6. Fails open if `ctx.client.session.messages` rejects.
7. Ignores unrelated events (`session.updated`, etc.) without scheduling a capture.

Run the test in a dev shell:

```bash
nix develop .#  # or: nix shell nixpkgs#bun
cd integrations/opencode
bun test plugin.test.js
```

Or via the bundled flake check:

```bash
nix build .#checks.<system>.opencode-plugin-test
```

## See also

- `integrations/openclaw/SKILL.md` for the equivalent OpenClaw integration.
- `integrations/shared/recall-protocol.md` for the canonical recall protocol shared across every MemPalace integration.
