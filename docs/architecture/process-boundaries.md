# Process boundaries

## Rust / Tauri

**Owns**

- Window and desktop settings lifecycle.
- Spawning, routing, monitoring, restarting, and shutting down the per-workspace Node Pi Hosts.
- Platform process-tree containment for the Host and its ordinary descendants.
- The JSONL stdin/stdout bridge and bounded stderr forwarding.
- Native path opening and folder selection.

**Must not**

- Reimplement Pi Package install, filtering, or resource discovery.
- Parse `pi list` text or own Pi `settings.json`.

## Startup splash and main-window handoff

Startup renders in two windows, not one:

- `splash` — a small frameless window created programmatically in `setup()`
  (`src-tauri/src/splash.rs`) loading the `splash.html` entry. It is created
  **before** the Host is spawned so the Host's startup cost is fully covered.
  It is skipped entirely when the app was launched at login.
- `main` — configured `visible: false`; it loads and runs the whole bootstrap
  (settings → Host → workspace → session) off-screen.

The splash shows only narrative rotating copy (`src/splash/splash-copy.ts`) — no
technical stage text like "Starting Pi Host". The startup stage is still tracked
because it drives two things: the sweep bar fills and stops on `ready`, and the
rotation halts so the last line holds. Rust reports `preparing` / `starting-host`,
then `main` pushes its own `resolveStartupStage` result for the rest. Because the
splash bundle loads *after* Rust's first broadcasts, the current stage also lives
in `AppState.splash_stage` and is pulled once via `splash_context` before the
`splash-stage` event stream takes over.

`main` calls `splash_finish` once `startupSettled` flips true — including the
terminal Host-failure path, so the Host-unavailable panel is reachable. Rust
then waits out a 3 s minimum display (measured from the splash's *first paint*,
not from process start), shows and focuses `main`, and closes `splash` 260 ms
later. A 45 s watchdog force-completes the handoff if the renderer never
reports, so a broken renderer can never leave an unclosable splash on screen.

## Node Pi Host

**Owns**

- All Pi SDK services and cwd-bound workspace graphs.
- Immediate project resource loading after workspace selection.
- Package mutation reconciliation and Extension UI bridging.
- Provider/model health and Host identity revisions.

**Must not**

- Mix logs into stdout.
- Add a second workspace trust state machine outside the selected-workspace policy.

## Workspace Host pool

Rust owns a `PiHostPool` keyed by canonical workspace path. Startup creates one
Host. When its Agent is idle, selecting an unallocated workspace keeps the
legacy `workspace.setCurrent` flow and rebinds that Host to the selected path.
When the active Host has a running Agent, selecting another workspace allocates
an independent Node Host with its own protocol identity, service graph,
provider runtime, and lock set. Returning to an already allocated workspace
reuses its process and replays its saved `host.ready` frame so React performs a
normal authoritative rehydrate.

Only frames for the active route reach the renderer `HostClient`. Inactive
Hosts continue consuming model streams, running tools, and maintaining their
same-workspace background Sessions. Unexpected restart and fatal events retain
the route id, so one workspace cannot replace another workspace's UI epoch.
An inactive Host is retained while busy. After all of its Agents settle, it is
retained for 30 minutes and then reclaimed by the desktop's periodic cleanup.
The active Host is never reclaimed by this idle cleanup.

## Host process-tree lifecycle

Rust owns every complete Pi Host process tree, not only each direct Node process.
On Windows, the Host is assigned to a kill-on-close Job Object. On macOS and
Linux, Rust calls `setsid()` before exec so the Host leads an isolated Unix
session and process group; subprocesses inherit that group by default.

Normal app exit sends the typed `system.shutdown` request to every pooled Host
and preserves each Host's bounded graph-disposal window. After a direct Host exits or that
window expires, Rust sends `SIGTERM` to the group, waits 500 ms, and escalates
to group `SIGKILL`. Startup rollback, forced cleanup, unexpected Host exit, and
the manager's Drop fallback use immediate group `SIGKILL`. A shared one-owner
cleanup claim prevents the stdout crash monitor and manager from both signaling
a later-reused process-group id.

Extensions, tools, and SDK helpers may spawn ordinary child processes, but they
must not evade PiAbyss ownership with detached mode, `setsid`, `setpgid`, or a
double-fork daemon. A deliberately detached process has left the Host lifecycle
contract and cannot be contained by either a Unix process group or ordinary
parent-death handling. As with all userspace Unix supervisors, an unrecoverable
`SIGKILL` of the Tauri process itself cannot run cleanup code; stdin EOF and the
Host's own shutdown handling remain defense in depth for that external case.

## React

**Owns**

- Zustand projections, typed Host requests/events, and all user-facing views.
- Explicit confirmation before Project Package mutations.

**Must not**

- Import the Pi SDK, spawn package tooling, or directly read the agent directory.

## Workspace selection policy

The order is fixed:

1. Canonicalize cwd.
2. Create `SettingsManager` with explicit `projectTrusted: true`.
3. Load project resources and create the cwd-bound AgentSession graph.
4. Publish one ready `workspace.changed` snapshot.

Selecting or restoring a workspace authorizes its existing `.pi` project
resources to load. There is no persistent workspace trust store, pending state,
or deny action. Existing `.pi/extensions` may execute local code immediately.
