# Claude Code bridge experiment (draft)

OptChat can optionally register **pi-claude-bridge 0.9.1** internally. It runs Claude Code through Anthropic's Agent SDK; Pi still owns tools and OptChat still owns the memory tree, profiles and delegation. The implementation is an upstream dependency, not copied code or an OAuth/fingerprint impersonation. Upstream's prompt guards remain enabled.

This is experimental, not a promise of subscription billing. Anthropic has changed its SDK billing policy before. Verify the currently applicable terms and Claude usage dashboard. A successful reply and a zero cost in Pi's ledger do **not** prove that Extra Usage was avoided.

## Enable (test profile first)

1. Use the experiment worktree, not your installed checkout:

   ```sh
   cd ~/.worktrees/pi-optchat/claude-bridge
   npm ci
   ```

2. Check the official Claude Code login with `claude auth status`. Confirm this is the subscription/account you intend to test. Disable paid Extra Usage in Claude's billing settings if you need a hard spending boundary. Do not use an API key or proxy for this experiment.

3. Start Pi with `OPTCHAT_CLAUDE_BRIDGE=1` and explicitly load this worktree's `src/index.ts`. The flag only registers the provider; it does **not** change profile settings or redirect existing Anthropic calls.

4. Select `claude-bridge/<model>` for **all three** roles in the disposable profile:
   - Main: Pi's model picker.
   - Compactor/handoffs: `/optchat model`.
   - Children/connected windows: `/optchat agents model`.

   Keeping either saved role on `anthropic` continues to use that provider's normal billing path. Model IDs are taken from the host Pi catalog. The smoke tests use `claude-haiku-4-5`; Opus/Sonnet 5.5 have **not** been live-tested here.

Do not also load a standalone copy of `pi-claude-bridge`: that would register the same lifecycle hooks twice. Existing provider defaults remain unchanged. Without the flag, OptChat does not initialize the bundled bridge. Dependencies are nevertheless installed by npm.

The subscription experiment refuses common API/proxy/cloud-provider **environment** overrides at startup. This is a precaution, not a complete billing firewall: Claude settings, enterprise policy, `apiKeyHelper`, and account-side billing can still influence routing. Inspect those separately. The live fixture uses `longContextExtraUsage:false` and a conservative 200K context configuration; no opt-in to metered 1M context.

## Compatibility changes

- The outgoing main system prompt retains Pi's assembled prompt rather than replacing it with an older pre-render prompt. This keeps the bridge's exact capture lookup intact, including AGENTS.md/skills.
- Published bridge 0.9.1 does not project Pi custom `sections`. OptChat's profile instructions and historical-import guidance therefore move into its `customPrompt` on bridge models only. The actual upstream projection places project context/skills before that custom prompt, retaining profile-over-repository precedence.
- Each child initializes the bridge hooks too. Inheriting only the provider function is insufficient: the bridge also needs per-session prompt captures and lifecycle events.
- Compaction and handoff calls use upstream's `cacheRetention:'none'` marker for isolated, tool-free, non-persistent SDK summary queries.
- Compactor retries fold the initial input, previous answers and length correction into one user message. Upstream's isolated path otherwise sees only the last user turn and loses the source/previous attempt.
- Non-bridge providers keep their existing prompt/retry paths and cache options.

There is no native API fallback when the bridge fails. A bridge error remains an error.

## Reproducible tests

Offline (no Claude/model calls):

```sh
npm run check
npm test
```

The new tests use real Pi sessions and actual upstream prompt-capture/projection hooks, with a synthetic provider response. They check main/child profile rules, AGENTS.md, skills, the captured prompt, isolated summary retries, handoff routing, and rejection of environment API overrides. Tests alone import upstream's internal capture helpers; production code only initializes its extension entry point.

Opt-in real calls:

```sh
OPTCHAT_BRIDGE_LIVE=1 npm run test:bridge:live
```

This sets the integration flag automatically, creates a synthetic OptChat profile and an empty Pi agent directory under a temporary root, disables automatic retry/cache warming, and runs a three-minute-bounded Haiku smoke test. It does not change your live OptChat profiles, installed Pi settings, credentials, or model selections. It uses your existing Claude Code login, however; Claude Code may write its own session artifacts for the temporary project under its normal config directory. The temporary test files are retained for inspection.

## Observed results — 2026-10-05

- Type check: **pass**.
- Full offline suite: **76/76 pass**.
- Mutation checks: reverting the outgoing prompt fix, removing retry flattening, or omitting child bridge initialization each makes the new tests fail.
- Real Claude Code/Agent SDK smoke test: **pass**, using the machine's current **Team** login and Haiku 4.5.
  - Main profile instruction marker and second-turn memory/`zoom`.
  - Main `spawn`, custom report delivery, and automatic idle-parent wake.
  - Actual isolated compactor summary.
  - Child `zoom` and mid-run `tell_parent`.
  - Main tool turn concurrent with two child sessions.
  - Nested `spawn` and grandchild-to-parent `tell_parent`.
  - Connected-agent lifecycle and final handoff summary.
- Actual installed Pi **1.0.3 CLI** loading this extension through `-e`: **pass**, producing `CLI_ACK` and the profile marker through `claude-bridge` (exit 0). The API-session tests use Pi 1.0.2 dev dependencies.
- **Billing bucket: not verified.** No API credential/proxy environment overrides were present. The fixture used empty Pi auth and no fallback. This establishes successful official SDK execution, not plan-versus-Extra-Usage accounting.

## Before making this production-ready

- Verify the usage dashboard against a controlled test with paid Extra Usage disabled; confirm the intended subscription account (the current Team login may not be the desired personal subscription).
- Test the intended Opus/Sonnet models and effort levels, plus long-running context churn.
- Exercise abort/recovery while multiple SDK queries are parked at tool boundaries, restart/reload, quota exhaustion, and handoff output limits.
- Test the real connected-window TUI with this backend (the bridge-specific live test exercises its agent/handoff backend, not a second terminal UI).
- Review upstream's Pi-compaction hooks: OptChat disables normal compaction, but both extensions install handlers. Automatic compaction is disabled in the test fixture; manual compaction behavior needs review.
- Other extensions' custom prompt sections are not forwarded by 0.9.1. Decide whether to require an upstream release with section support instead of expanding this adapter.
- Decide whether the runtime dependency/SDK binary footprint is acceptable for an opt-in feature, and whether to automatically detect/reject separately installed duplicate bridge copies.

No release/version bump or production installation is part of this draft.
