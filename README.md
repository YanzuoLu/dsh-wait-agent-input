# dsh-wait-agent-input

Ends `wait_agent` and `job_output` with `wait: true` early when human input reaches the waiting Agent. Built for DSH `0.2.0-rc.2`. No Harness source files, Team services or job registry methods are patched.

## Behavior

- A user steer message ends the current wait and adds `User message received. Handle it before waiting again.` The native loop then consumes the original message at its next step.
- A user follow-up in the next-turn queue also ends the wait, but stays queued. The result says `User message queued. Finish this turn to handle it.` The plugin does not promote queued input into steering.
- Already-pending human input is handled too. Messages from teammates, jobs, tools and other Agents do not count as human input.
- Only the wait's child cancellation signal is aborted. The Agent, teammates, background jobs and original input queues are not cancelled or changed.
- `wait_agent` keeps its native successful value `{ "timedOut": false }`. Only the model-facing result content is replaced by the input notice.
- `job_output(wait: true)` returns the native unread output and current job status, with the input notice appended. The job is not cancelled. Output is consumed once, including a final result that races with the interruption. Non-waiting reads are unchanged.
- Native wait defaults, timeout caps, output byte limits, access checks, invalid arguments, real errors and upstream cancellation remain authoritative. Later completion notifications and output collection keep working after an interrupted wait.
- The plugin awaits the original tool's settlement instead of abandoning a running promise. It restores temporary wrappers and signals and removes listeners on every exit.
- Unloading releases active augmented waits with a plugin-unloaded error. Subsequent calls use native behavior.
- If another tool is still executing in the same step, this plugin does not interrupt that other tool or promise that the whole step has finished.

There is no new tool or UI button, and no extra system-prompt paragraph. Calls already dispatched before the plugin was loaded keep their original behavior; the augmentation applies to subsequent calls.

## Implementation

The plugin uses `tools/execute`, `tools/post-execute` and `agent/inbox/inserted` for per-call lifecycle and notices. `wait_agent` uses a child dispatch signal.

For `job_output`, the registered tool's `execute` method is temporarily wrapped while participating calls are in flight. An execution-token map isolates concurrent callers. Only the native body receives the wait signal, so the runtime does not discard a consuming read when completion and input race. If the native registry rejects with `wait aborted` due to human input, the same native body performs one non-waiting read. Other failures propagate. The original method is restored when the last participating call settles. Pre-execute, around-dispatch and post-execute middleware still run normally.

This adapter depends on DSH `0.2.0-rc.2`'s native `job_output` and job-registry cancellation behavior. Recheck that behavior when upgrading DSH.

## Install

Install the release into a DSH profile, then enable its `dsh-wait-agent-input` bundle in the Plugins page.

```sh
dsh plugin --profile web add github:YanzuoLu/dsh-wait-agent-input#v0.2.0
```

When migrating from a local `wait-agent-input` entry, remove that local insertion before enabling the bundle so the plugin is loaded only once.

## Load locally

Add this row to the Web profile's patch layer, replacing the path with your checkout location if needed.

```yaml
- insert:
    - id: wait-agent-input
      name: file:///Users/ol125/Documents/dsh-wait-agent-input/index.js
```

Load or unload the row through profile HMR. The plugin has no browser bundle and does not need a Web shell rebuild. Source edits require a module reload or a DSH restart unless HMR source watching includes this directory. The default `hmr.config.root: []` watches configuration only and does not reload edited JavaScript.
