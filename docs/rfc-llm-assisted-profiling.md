# RFC: LLM-Assisted Profiling and Controlled Measurement Runs

* Status: Implemented for the local stdio workflow with Linux strict isolation
* Authors: Clinic.js maintainers and contributors
* Target: Clinic.js and an optional companion package
* Last updated: 2026-11-01

## Current implementation status

This RFC describes the supported local workflow and its runtime contracts.
Optional deployment extensions such as authenticated network transport and
cross-reconnect quota ledgers remain outside this local stdio scope. The current
MCP implementation provides:

* project-local `profile-workloads.json` discovery from the MCP server's `cwd`;
* per-workload profiler allowlists and selection with `workload` plus `profiler`;
* a manual `profile-clinic` CLI that uses the same four profiler adapters and
  enforces each workload's profiler allowlist;
* local stdio tools for workload listing, profiling, approval, status, bounded
  waiting, findings, comparison, finding detail, and cancellation;
* collector code paths for Doctor, Bubbleprof, Flame, and Heap Profiler; and
* findings pages with a default of 10 items and 8,000 characters, capped at 20
  items and the 12,000-character per-response limit. Workload and artifact
  listings also use opaque cursors bound to their session and immutable list
  snapshot; artifact byte pages use bounded offsets. Cursors continue through
  the report's findings. Pagination is reported by `has_more` and
  `next_cursor`; on a findings page, `truncated` means a finding was compacted.
  A terminal report response that omits trailing findings at record boundaries
  marks `report.usage.truncated`; the complete report remains available to the
  findings pagination tool.
  Reports also state `summary.findings_truncated` when the analyzer's top-20
  finding limit omitted lower-ranked records. Compatible comparisons return
  bounded candidate-only, baseline-only, and changed finding summaries beside
  the metric delta, and mark the finding comparison incomplete when either
  report was capped.

The current runner returns a queued run promptly, executes it asynchronously,
exposes status, and connects cancellation to the collector child process group.
`start_profile_run` returns the run credentials for reuse; `wait_profile_run`
polls that same run until a terminal response or its bounded timeout. The server
limits active runs, so a queued response must not trigger a duplicate start.
Status polling exposes a coarse phase and progress estimate, not a completion
time prediction. The runner enforces
concurrent/stored-run limits and retention. Tool calls include estimated token
usage and enforce per-call character caps plus run, session, time-window, and
process-lifetime token quotas; estimates use UTF-8 byte length divided by four
and are explicitly approximate. Defaults are 20,000 input characters and
12,000 output characters per call, 64,000 combined estimated tokens per run,
256,000 per session, 1,000,000 per rolling 24-hour window, and 2,000,000 per
server-process lifetime. Deployments may lower these limits. Findings are sorted by
measured impact by default (or a requested allowlisted sort); opaque server-side cursors bind paging to the
session, run, findings snapshot, severity filter, sort, and expiry. The
runner revalidates the startup manifest's canonical hash and file identity
before launching a profile worker, rejecting content edits, ownership changes,
and path replacement. It resolves the selected executable to a real path and
pins its file identity and SHA-256 digest before handing it to the isolation
provider. The Linux Bubblewrap provider opens and mounts the pinned worker and
target executable descriptors read-only; this descriptor mount is the
worker's atomic-selection guarantee inside the user namespace. The worker
revalidates the target pin before launch and collection when it is not running
with that descriptor-backed guarantee. Strict MCP runs fail closed unless the
bundled systemd-Bubblewrap provider or another configured provider guarantees
atomic selection for both executables and the other sandbox requirements. It
reports the canonical hash of the manifest loaded at startup, hashes the Node
executable contents and the installed Clinic dependency tree into a descriptive
toolchain digest at server startup. The digest is report metadata, not a run
precondition. It records Clinic and operating-system versions,
measurement input digests, and host-condition snapshots when available. Clean
Git revision plus a hashed remote identity are included when available. Dirty
or unavailable repository state makes compatibility null rather than claiming
the checked-out commit describes the profiled source. Failed strict runs retain
bounded partial artifacts when present. End-to-end worker tests
cover Doctor, Bubbleprof, Flame, and Heap Profiler. `get_profile_status`
returns the report when a run is complete, rather than a compact summary; if
the response budget requires omitting findings, it marks that omission and
keeps the full report available for pagination.
`get_profile_findings` supports summary and paginated findings modes.
MCP responses sanitize control characters, terminal escapes, credentials, and
absolute paths in returned strings. Findings, finding details, comparisons,
and artifact pages carry a diagnostic classification; Clinic artifacts are
classified as sensitive by default.
`get_finding_detail` returns a bounded source-line window only when explicitly
requested and the file resolves inside the project workspace or a declared
read-only input mount. Flame findings
also return their matching call-tree subtree when requested, capped by
`top_k`, `max_depth`, a 500-node response bound, and the response character
budget; other profiler adapters report call trees as unavailable because they
do not preserve hierarchy. Oversized detail responses are pruned at tree-node
and source-line boundaries and marked `truncated`. `get_profile_artifact`
lists files under a run-scoped artifact reference and returns bounded base64
pages only after checking the run capability, artifact handle, and safe path.
Artifact exports use a same-filesystem staging directory, fsync copied files
and completion metadata (including creation and expiry times), verify each
stored file against the manifest, then atomically rename into place. Startup
removes only recognized staging directories whose owning process is no longer
alive, and startup/hourly sweeps delete expired run artifacts.
Workloads with a bounded `measurement` plan run unprofiled warmups
and measured samples inside the Clinic worker; reports retain those samples
and their median, and compatible comparisons include deterministic bootstrap
intervals for each median and for the candidate delta. Workloads without a
measurement plan still produce descriptive single-run comparisons with
uncertainty marked unsupported.
MCP-triggered runs always require strict isolation and fail closed without a
configured provider. Direct host profiling is available only through the
manual `profile-clinic` CLI and is not represented as an RFC-compliant MCP run.
The bundled Linux provider is available with
`CLINIC_PROFILE_SUPERVISOR=systemd-bwrap`. It combines a systemd user scope
(CPU quota/accounting, memory and swap limits, task limit, and whole-scope
termination) with Bubblewrap user, network, and PID namespaces. It mounts the
worker and target Node executable through already-open read-only file
descriptors, mounts the ELF interpreter and the runtime libraries required by
the running Node process, exposes declared workload files and input mounts,
and provides only private writable `/run/profile`, `/tmp`, and `HOME` paths.
An end-to-end Fibonacci `clinic-flame` run has completed through this provider
on Linux. Strict MCP runs still fail closed if the supervisor is not selected
or its rootless user namespaces, Bubblewrap, or systemd user scope are
unavailable. The provider mounts the Clinic package's installed `node_modules`
tree read-only. The toolchain digest is descriptive metadata rather than a
precondition for starting a profile.
The bundled command requires Bubblewrap's `--bind-fd`, `--disable-userns`, and
`--assert-userns-disabled` options; it has been tested with Bubblewrap 0.9.0.

The bundled provider mounts `/run/profile` as a size-limited `tmpfs` using the
workload's `artifact_mb` limit, drops `CAP_SYS_ADMIN`, and disables nested user
namespaces so the workload cannot regain mount privileges to enlarge it. It
requires Bubblewrap to confirm that nested user namespaces are disabled. The
trusted worker streams completed files
over a dedicated pipe; the host validates every relative path and the aggregate
logical byte count before creating files under the run directory. The export
path independently enforces the same exact limit before retaining files. The
tmpfs also accounts for filesystem metadata, so a run may hit `ENOSPC` before
the sum of file contents reaches the configured maximum.

The MCP SDK adapter returns the `{request_id, ok, data, error, usage}` envelope
as structured MCP content. At runtime it validates the envelope, tool payloads,
queued/running statuses, terminal performance reports, and findings pages
against the checked-in JSON Schemas. It also applies report semantic checks for
measurement medians, compatibility identity, duplicate finding/artifact IDs,
and uncertainty values; findings pages check per-page ID uniqueness,
cursor/`has_more` consistency, and that `truncated` matches compacted findings.
Some cross-field checks remain implemented in tool-specific validators rather
than represented directly in the JSON Schemas.

## Abstract

This RFC proposes an optional workflow that allows an LLM-compatible client to
start a controlled Clinic.js measurement, inspect the resulting profile, and
receive evidence-backed bottleneck hints. The proposal does not send raw
profiles to the model by default. Instead, a local runner collects the data and
a deterministic analysis layer reduces it to a bounded, structured report.

The feature is exposed through npm scripts and, optionally, a Model Context
Protocol (MCP) server. Existing Clinic commands and output formats remain
unchanged.

## Motivation

Clinic.js produces useful visualizations for humans, but a complete profile can
be too large and too low-level for an LLM context window. Asking a model to
inspect an entire flame graph or Clinic artifact is expensive, difficult to
reproduce, and likely to produce unsupported conclusions.

At the same time, performance investigations are iterative. A developer or an
LLM should be able to:

1. select a known workload;
2. run a bounded measurement;
3. identify the highest-impact findings;
4. compare a candidate run with a baseline; and
5. request deeper evidence only for a selected finding.

The proposed workflow makes those steps explicit while keeping the profiling
process local, reproducible, and under user control.

## Goals

* Allow an LLM client to start approved Clinic.js runs without arbitrary shell
  access.
* Preserve raw Clinic artifacts for human inspection and future analysis.
* Produce small, deterministic JSON reports containing bottleneck hints and
  their supporting evidence.
* Support comparisons between baseline and candidate runs.
* Keep the feature optional and fully backward compatible with the existing
  CLI.
* Apply resource, timeout, and output-size limits to model-triggered runs.

## Original MVP scope (proposal; superseded in part)

The first implementation is intentionally narrow:

* Linux only, using the strict isolation provider described below;
* one repository-controlled, immutable workload shipped in the first release
  (the current manifest format supports project-specific workloads);
* `clinic-flame` only (the current MCP adapter exposes Doctor, Bubbleprof, Flame,
  and Heap Profiler);
* local stdio MCP only, with no network transport;
* a deterministic analyzer with fixture-based tests; and
* no raw-profile upload or source modification capability.

The target MVP also applies bounded context output: summary responses are
capped at 2,000 characters, findings responses at 12,000 characters, and raw
profiles are never returned automatically. Current findings pages default to
8,000 characters and share the 12,000-character per-response maximum.

The original proposal used this rollout order; it is historical and does not
describe the current implementation status above:

1. implement and test the runner;
2. implement and test the `clinic-flame` adapter and report generator;
3. validate limits, cleanup, reproducibility, semantic schema rules, and report
   quality end to end (including executable positive and negative semantic
   validation tests);
4. add the local stdio MCP facade only after the CLI workflow is stable.

This ordering keeps protocol and access-control complexity out of the first
measurement loop.

## Non-goals

* Replacing Clinic.js visualizations or profilers.
* Letting an LLM execute arbitrary commands or modify application code.
* Treating an LLM-generated explanation as proof of a performance defect.
* Uploading raw profiles to a remote service by default.
* Introducing embeddings or semantic search into the profiling data path.

## Proposed architecture

```text
manifest workload
          |
          v
   controlled profile runner
          |
          +--> raw Clinic artifact (.clinic-*)
          |
          v
 deterministic analyzer and normalizer
          |
          +--> report.json / report.md
          |
          v
 optional MCP server (query and drill-down)
          |
          v
          LLM client
```

### 1. Workload registry

The project declares workloads in an immutable, versioned manifest. An npm
script may be a developer convenience, but it is not a security boundary:
npm scripts are arbitrary shell commands and can trigger lifecycle hooks.
The MCP runner must never execute an arbitrary `npm run <name>` request.

Each manifest entry contains a fixed executable, argument vector, working
directory, environment allowlist, resource limits, and network policy.

```json
{
  "scripts": {
    "profile:clinic:tokenizer": "node scripts/profile-clinic.js tokenizer",
    "profile:clinic:lemmatizer": "node scripts/profile-clinic.js lemmatizer"
  },
  "profile_workloads": {
    "tokenizer": {
      "executable": "node",
      "argv": ["bench/tokenizer.bench.ts", "--iterations", "${iterations}", "--warmup", "${warmup_iterations}"],
      "cwd": "/workspace",
      "env_allowlist": [],
      "profilers": ["clinic-flame"],
      "limits": {
        "wall_clock_ms": 120000,
        "cpu_ms": 120000,
        "memory_mb": 1024,
        "artifact_mb": 512
      },
      "network": "disabled",
      "input_mounts": [],
      "parameters": {
      "iterations": {"type": "integer", "min": 1, "max": 100, "binding": {"kind": "argv", "index": 2}},
      "warmup_iterations": {"type": "integer", "min": 0, "max": 20, "binding": {"kind": "argv", "index": 4}}
      },
      "throughput": {
        "unit": "documents_per_second",
        "definition": "completed tokenizer documents divided by measured wall-clock seconds"
      },
      "measurement": {
        "warmup_runs": 3,
        "measured_runs": 10,
        "max_wall_clock_ms": 30000,
        "value_field": "throughput"
      }
    }
  }
}
```

The manifest is repository-controlled, committed to the trusted project
revision, and loaded without following symlinks. It is validated and hashed
before execution and hashed again immediately before the child is spawned; any
change, ownership change, or path replacement between those steps aborts the
run. Parameters are substituted only into declared argument slots. Shell
parsing, npm lifecycle execution, and undeclared environment variables are not
permitted.

The schema constrains parameter types and numeric ranges. Because standard JSON
Schema does not compare two sibling values, the manifest loader also rejects
any parameter definition where `min > max`; this semantic check is mandatory
before the manifest hash is accepted. The root key under `profile_workloads` is
the canonical workload identity; entries do not duplicate it in an `id` field.
Every parameter has exactly one explicit binding. The loader rejects missing or
unbound placeholders, duplicate bindings, and binding indices outside `argv`.
JSON Schema validation alone is insufficient for these cross-field rules; the
executable semantic validator is mandatory and is covered by executable
positive and negative tests before a manifest is hashed.

An optional `measurement` plan declares `warmup_runs` (0–20), `measured_runs`
(2–30), `max_wall_clock_ms` (no greater than the workload limit), and a
top-level `value_field` in the workload's JSON stdout record. The worker runs
the fixed executable and argument vector without Clinic instrumentation for
each warmup and measured sample, then runs Clinic once. It uses no shell, caps
each stdout/stderr stream at 8 KiB, requires one JSON object with a finite
non-negative numeric value, and stops the measurement process group on
cancellation or timeout. The measured values and their median are retained in
the report; throughput is never inferred from profiler sampling.

When `measurement` is omitted, `throughput.value_field` is required and the
worker makes one bounded, unprofiled execution to obtain a descriptive
throughput sample. The report records that single sample; comparisons may show
the point delta but must mark uncertainty unsupported. This fallback is not a
repeated measurement plan and does not qualify a regression as high confidence.
Workloads with no meaningful throughput metric set `throughput` to `null` and
do not run this extra sample.

The root `scripts` object is developer-only metadata for convenient local
commands. It is excluded from the security-sensitive execution path and is
never invoked, resolved, or interpreted by MCP. MCP execution uses only the
`profile_workloads` entries.

The child environment is constructed from an empty environment plus a small,
explicitly validated allowlist. `NODE_OPTIONS` is not allowed in the MVP:
flags such as `--require`, `--loader`, and `--inspect` can inject code or alter
isolation. Locale or workload-specific variables must be added individually
with validation; no ambient parent environment is inherited.

### 2. Controlled profile runner

`profile-clinic.js` starts the selected Clinic command in a dedicated run
directory. Inside the sandbox, Clinic writes only to
`/run/profile/artifacts/<run-id>/`. After the process exits, the supervisor
copies into a same-filesystem staging directory under `.clinic-runs/.staging/`,
fsyncs files and the directory, writes a completion manifest containing file
sizes and hashes, fsyncs that manifest, and atomically renames the staging
directory to `.clinic-runs/<run-id>/`. A crash before the rename leaves only a
staging directory, which recovery removes or revalidates; a run is reported as
complete only when the completion manifest is present and valid. Reports use
opaque artifact references, never host paths. It records:

* run ID and timestamps;
* selected workload and profiler;
* Node.js, Clinic.js, and operating-system versions;
* command metadata (excluding secrets);
* exit code and termination reason;
* artifact metadata and opaque references; and
* benchmark input and iteration settings.

The runner must enforce the manifest limits and preserve partial diagnostics
when a run fails. In the first implementation, strict MCP-triggered runs are
supported only on Linux with a rootless isolation provider that supplies cgroup
v2 CPU/memory limits, a private network namespace, a private filesystem view,
and descendant-process cleanup. A provider may use a rootless container or an
equivalent supervisor; process-group termination alone is insufficient because
detached descendants can escape it.

The filesystem layout for the Linux provider is fixed. The exact workload
source files and declared inputs are mounted read-only under `/workspace`; the
Clinic package's installed runtime dependencies are mounted read-only under
`/clinic`. The resolved Node executable and required runtime files are
mounted read-only under `/runtime`; and only `/run/profile` and a private
temporary directory are writable. The process receives no host home directory,
credential directory, or unrestricted `/tmp`. The runner resolves the
executable to an absolute path before spawning, verifies it belongs to the
configured runtime/toolchain, records its real path, version, and content hash,
but path checks and hashing alone are not sufficient. The isolation provider
must open the executable/runtime through trusted file descriptors (for example,
descriptor-based `execveat`) or launch an immutable container/image digest that
contains the pinned runtime. It must fail closed if neither atomic mechanism is
available. Workloads must declare any additional read-only input mount;
mount sources are relative paths under an explicit `source_root` (`workspace`
or `declared-input`), and targets are canonical paths under `/inputs`; absolute
paths, dot segments, traversal, and symlinks are rejected after canonicalization.
Undeclared repository paths are not visible.

On macOS and Windows, strict isolation is unsupported in the initial release.
The runner must refuse MCP-triggered execution there unless an explicitly
configured external container/sandbox provider is available. Local manual
profiling remains possible, but it is not represented as a policy-compliant
MCP run.

### 3. Deterministic analyzer

The analyzer reads Clinic output locally and emits a bounded report. Each
profiler has a separate adapter and declares its capabilities. For example,
`flame` may provide CPU call-tree percentages, `doctor` may provide selected
event-loop diagnostics, `bubbleprof` may provide asynchronous wait structure,
and `heapprofiler` may provide heap snapshots. A field that the selected
profiler cannot produce is `null` with `"unsupported"` capability status; it
must never be inferred or fabricated.

Where supported, adapters may rank:

* self CPU time and total CPU time;
* event-loop delay and utilization;
* asynchronous wait or I/O time;
* allocation and retained-heap deltas; and
* changes relative to a baseline run.

The analyzer must distinguish observations from hypotheses. A finding such as
"`Tokenizer.tokenize` accounts for 42.1% of sampled CPU time" is an observation.
"Repeated string conversion may be a cause" is a hypothesis and must be marked
as such.

### 4. Optional MCP server

The MCP layer is a query interface over completed and running local runs. It
does not need to expose raw files in the default response.

The default transport is local stdio. A network transport is disabled unless
explicitly configured with authentication, TLS, and an authorization policy.
Each client receives an opaque run capability; every status, report, compare,
and detail request checks that the run belongs to that client. For local stdio,
the identity boundary is the MCP server process and its connection/session. The
MVP enforces concurrency and token/resource quotas per stdio session and a
process-lifetime budget; reconnecting creates a new session and is not treated
as the same authenticated client. A deployment that needs daily quotas across
reconnects must persist a ledger keyed by an authenticated client identity;
unauthenticated local stdio has no stable cross-process client identity.

The capability is returned in the `start_profile_run` response and must be
provided in the input of every subsequent run-scoped tool call; it is not
conveyed out-of-band.

`compare_profile_runs` is authorized with two capabilities: the request carries
`candidate_run_capability` and `baseline_run_capability`. The server verifies
that both runs belong to the requesting client (or explicitly authorized
session) before resolving either report.

Artifact references are unguessable, server-generated handles containing at
least 128 bits of cryptographic randomness. They are scoped to the owning
`run_id`; an artifact lookup must check the tuple `(client/session identity,
run_id, artifact_ref)` and must never resolve a reference globally. A forged,
expired, or cross-run handle returns the same not-found/unauthorized error.
Capabilities and artifact handles have a 24-hour maximum TTL, are stored only
as hashes, and are revoked when a run is deleted or its retention period
expires. Cancellation stops execution; the owner's read capability remains
valid through the retention period so terminal
status and any retained partial diagnostics can be inspected. After a server
restart, in-memory capabilities are invalid;
persisted capabilities require an explicit deployment policy and key rotation.

Proposed tools:

* `list_profile_workloads` — list registered, allowed workloads;
* `start_profile_run` — start an asynchronous bounded run;
* `approve_profile_run` — request explicit human confirmation through MCP
  elicitation for an expensive run;
* `get_profile_status` — return progress and completion status;
* `wait_profile_run` — poll the same run until terminal status or a bounded
  caller timeout, returning the current state when the timeout elapses;
* `get_profile_findings` — return ranked findings with evidence;
* `compare_profile_runs` — compare two completed reports;
* `get_finding_detail` — return a selected call-tree or source-location slice;
* `get_profile_artifact` — list and page through files using a run-scoped
  artifact reference; and
* `cancel_profile_run` — cancel a queued or running run.

Long-running operations return a `run_id` and `run_capability`. Callers can
query that same run with `get_profile_status` or use `wait_profile_run` to
poll internally for a bounded time. A queued or running response is not a
reason to start the workload again. Concurrent starts are limited to one
active run per server.

## Baseline comparison and reproducibility

A comparison is valid only when the reports reference compatible workload
manifests and the same repository identity, Node.js and Clinic.js versions,
operating-system/architecture, profiler settings, input corpus, and isolation
limits. Otherwise `compatibility` is `incompatible` and no regression ranking
is emitted.

The baseline is identified by an immutable `baseline_run_id`; it is never an
implicit "latest" run. The comparison object records both candidate and
baseline sample counts, warmup counts, and uncertainty metadata, making the
comparison self-contained for audit. Consumers must still resolve the
referenced baseline report to validate environment and manifest compatibility.
The MCP comparison response contains only the throughput delta and bounded
summaries of candidate-only, baseline-only, and changed findings. Those finding
changes are limited to the findings actually present in each report; the
`complete` flag is false if either analyzer capped its finding list.
Each report carries immutable compatibility metadata: manifest hash, profiler
configuration, input/corpus digest, isolation provider and limits, runtime
version, operating-system architecture, and repository revision identity. A
consumer compares this metadata before calculating a regression.
The input digest is derived from the canonical workload parameters and sorted
declared input-mount identities and content digests. Strict runs verify each
declared content digest again while opening the read-only mount; direct CLI
runs verify the same declaration before profiling.
The semantic validator also requires duplicated identity fields to agree:
workload, profiler name, repository revision, runtime, and architecture must
match their corresponding `run` fields. Configuration and isolation limits are
represented by canonical SHA-256/configuration values and constrained numeric
fields, not arbitrary free-form objects.
Runtime identity uses an exact `node-vMAJOR.MINOR.PATCH` value plus a pinned
toolchain digest; shorthand labels such as `24.x` are not valid compatibility
keys.
Isolation compatibility requires exact equality of provider, provider version,
network policy, and every declared resource limit. A stricter candidate limit is
not considered compatible because it can change scheduler and workload
behavior.
The comparison validator requires both candidate and baseline to be completed
reports with non-null compatibility metadata and compares a canonical,
order-independent serialization of those metadata objects after excluding the
repository revision. Repository identity must match across reports, but
repository revision is expected to differ when measuring a candidate change
against a baseline. Each report's repository revision must still match its own
`run.commit` field.
The report records the metric, units, direction
(`higher_is_better` or `lower_is_better`), denominator, sample count, warmup
count, and uncertainty method. A single sample may be displayed descriptively
but cannot receive a high-confidence regression classification. The reference
implementation uses repeated measured runs after warmup and reports bootstrap
95% intervals (or `unsupported` when the metric cannot be sampled reliably).
Candidate and baseline intervals express each run's bootstrapped median as a
percentage of its observed median (100% is the point estimate). The delta
interval expresses the bootstrapped candidate change relative to the baseline
median and may be negative. Bootstrap uses a recorded fixed seed and algorithm
version, making the interval calculation statistically reproducible for
identical input samples. The measurement samples themselves remain subject to
CPU scheduling, thermal frequency scaling, background load, benchmark
nondeterminism, and other host effects. The runner records CPU affinity,
scheduler/isolation mode, CPU governor and frequency, thermal information when
available, and these limitations in the report. Start and finish observations
are host snapshots; unavailable readings are `null`. The `confidence` field is
derived from recorded evidence and adapter quality, not generated by the LLM.
Flame findings are low below two profiler samples, medium from two through 99,
and high at 100 or more; missing sample counts are low. Doctor issue
classifications and single heap snapshots are medium confidence. Bubbleprof
findings are low for one source event, medium for two through nine, and high
for ten or more. Each finding records its `confidence_basis`; a report summary
uses the lowest confidence among its findings, or `unsupported` when it has
none. The
manifest/report validator rejects `low_pct > high_pct` as a semantic rule
because standard JSON Schema cannot compare sibling values.

## Report format

The canonical machine-readable output is `report.json`:

Every workload defines its own throughput unit and numerator/denominator in
the manifest. Reports must include both `unit` and `definition`; workloads
without a meaningful throughput metric use `null` rather than a generic value.
Run metadata records a canonical executable identifier, the working directory
relative to the workspace, and the argument count. It records validated numeric
workload parameters separately and omits resolved host paths, argument values,
and environment values that could contain secrets. The manifest hash identifies
the exact command template.

```json
{
  "schema_version": 1,
  "run": {
    "id": "run_2026-11-01T12-00-00Z_abc123",
    "workload": "tokenizer",
    "profiler": "clinic-flame",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "clinic_version": "13.0.0",
    "os_version": "linux-6.8.0",
    "node": "node-v24.21.0",
    "architecture": "linux-x64",
    "status": "completed",
    "exit_code": 0,
    "termination_reason": "completed",
    "compatibility": {
      "schema_version": 1,
      "workload": "tokenizer",
      "manifest_hash": "sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "profiler": {"name": "clinic-flame", "adapter_version": "1", "configuration_digest": "sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", "canonicalization_version": "1"},
      "input_digest": "sha256-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "isolation": {"provider": "rootless-cgroup-v2", "version": "1", "limits": {"wall_clock_ms": 120000, "cpu_ms": 120000, "memory_mb": 1024, "artifact_mb": 512, "network": "disabled"}},
      "runtime": {"node_version": "node-v24.21.0", "clinic_version": "13.0.0", "os_version": "linux-6.8.0", "toolchain_digest": "sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
      "architecture": "linux-x64",
      "repository": {"identity": "clinicjs/node-clinic", "revision": "0123456789abcdef0123456789abcdef01234567"}
    },
    "command": {"executable": "node", "working_directory": ".", "argument_count": 5},
    "parameters": {"iterations": 10, "warmup_iterations": 3},
    "lifecycle": {
      "created_at": "2026-11-01T12:00:00Z",
      "finished_at": "2026-11-01T12:00:31Z"
    }
  },
  "summary": {
    "duration_ms": 30000,
    "throughput": {
      "value": 8123,
      "unit": "documents_per_second",
      "definition": "completed tokenizer documents divided by measured wall-clock seconds"
    },
    "measurement": {
      "samples": [8000, 8150, 8120, 8200, 8090, 8140, 8080, 8160, 8110, 8126],
      "sample_count": 10,
      "warmup_count": 3,
      "value_field": "throughput",
      "max_wall_clock_ms": 30000,
      "elapsed_ms": 1420
    },
    "confidence": "medium",
    "findings_truncated": false,
    "capabilities": {
      "cpu_call_tree": "supported",
      "event_loop_delay": "unsupported",
      "heap_retained_delta": "unsupported"
    }
  },
  "comparison": {
    "baseline_run_id": "run_2026-10-31T12-00-00Z_def456",
    "metric": "throughput",
    "units": "documents_per_second",
    "metric_definition": "completed tokenizer documents divided by measured wall-clock seconds",
    "direction": "higher_is_better",
    "denominator": "baseline_median",
    "delta_pct": 12.8,
    "candidate_sample_count": 10,
    "candidate_warmup_count": 3,
    "candidate_uncertainty": {"method": "bootstrap_95_ci", "algorithm_version": "1", "seed": 0, "low_pct": 98.1, "high_pct": 102.0},
    "baseline_sample_count": 10,
    "baseline_warmup_count": 3,
    "baseline_uncertainty": {"method": "bootstrap_95_ci", "algorithm_version": "1", "seed": 0, "low_pct": 98.4, "high_pct": 101.7},
    "delta_uncertainty": {"method": "bootstrap_95_ci", "algorithm_version": "1", "seed": 0, "low_pct": 8.1, "high_pct": 17.0},
    "compatibility": "compatible"
  },
  "findings": [
    {
      "id": "finding-001",
      "severity": "high",
      "category": "cpu",
      "title": "Tokenizer.tokenize dominates sampled CPU time",
      "observation": {
        "metric": "total_cpu_time_pct",
        "self_time_pct": 18.4,
        "total_time_pct": 42.1
      },
      "location": {
        "file": "spacy-node/language.ts",
        "line": 87
      },
      "hypotheses": [
        "Repeated string conversion may be contributing to the cost"
      ],
      "next_checks": [
        "Repeat with long documents",
        "Compare against the baseline call tree"
      ],
      "confidence": "medium",
      "evidence": {
        "adapter": "clinic-flame-v1",
        "adapter_schema_version": "1",
        "confidence_basis": "profiler_sample_count",
        "sample_count": 10
      }
    }
  ],
  "artifacts": [
    {
      "kind": "clinic",
      "ref": "artifact_7vQ3mY2pL9xK4nR8sT6wZ1",
      "classification": "sensitive-diagnostic"
    }
  ],
  "usage": {
    "estimated_input_tokens": 420,
    "estimated_output_tokens": 980,
    "token_counts_are_estimates": true,
    "truncated": false
  }
}
```

Reports must be size-bounded. The default response should contain only the top
N findings (for example, 20). Detailed call trees, source snippets, and raw
artifacts are retrieved explicitly by `get_finding_detail` or a human using the
normal Clinic tooling.

Finding IDs and opaque artifact references are unique within a report. The
semantic validator rejects duplicates because `get_finding_detail` and artifact
retrieval address these values as handles; JSON Schema array validation alone
does not enforce object-field uniqueness.

The formal MVP schemas are maintained as versioned JSON Schema documents:

* [profile workload schema](schemas/profile-workload.schema.json)
* [profile workload entry schema](schemas/profile-workload-entry.schema.json)
* [performance report schema](schemas/performance-report.schema.json)
* [run status schema](schemas/run-status.schema.json)
* [MCP response envelope schema](schemas/mcp-response-envelope.schema.json)
* [MCP findings page schema](schemas/mcp-findings-page.schema.json)

Every MCP tool returns the common response envelope. The canonical wire shape
is `{request_id, ok, data, error, usage}`; clients must read tool results from
`response.data`, never from top-level tool-specific fields. Tool-specific `data`
payloads are validated by their corresponding schema; paginated finding tools
use `mcp-findings-page.schema.json`, including cursor, truncation, and
low-information fields. Cursor validation failures return the envelope's
structured error rather than an untyped exception.

Schema resolution is offline-first: the CLI and MCP package ship a local schema
bundle and resolve all relative `$ref` values from that bundle. Network loading
from the `$id` URLs is never required for validation; a release may additionally
publish the same bundle for external consumers.

## Context and token budgets

Profile size and model-context size are separate resource concerns. The MCP
server must enforce response limits before serialization and support explicit
detail levels: `summary`, `findings`, `call_tree`, and `source_context`. The
default is `summary`; deeper levels require an explicit request and remain
bounded. `limit`, `max_output_chars`, and `detail_level` are validated tool
parameters. Pagination or finding-specific drill-down is preferred to returning
an entire profile. For list-like responses, the MVP uses opaque cursors:

```json
{
  "run_id": "run_001",
  "page_size": 10,
  "cursor": null,
  "max_output_chars": 12000
}
```

The response contains `items`, `next_cursor`, and `has_more`. Clients pass
`next_cursor` unchanged in the next request; they must not interpret or forge
cursor contents. `page_size` is capped by the server, and a response with no
remaining records returns `next_cursor: null` and `has_more: false`.
`truncated` is true only when one or more returned findings were compacted to
fit the character budget; merely having another page does not truncate the
current page.
Every findings page also returns `run_id`, `snapshot_id`, the canonical sort
key, and `expires_at`. The server binds the opaque cursor to the requesting
session, run, snapshot, sort key, and expiry; a mismatch or expired cursor
returns a structured `invalid_cursor` error.

Ordering is part of the API contract. Findings default to descending measured
impact: `total_cpu_time_pct` for CPU reports, event-loop delay for event-loop
reports, and retained or allocated bytes for heap reports. The client may
request only an allowlisted sort field (`impact` or `severity`) and direction
(`asc` or `desc`). Ties are resolved by category, canonical source location,
and finding ID, all in ascending order. The server creates the opaque cursor
from the selected sort, severity filter, and immutable findings snapshot, so
records cannot move between pages during a query.

The default information-density threshold is a quantified observation backed
by at least two profiler samples (`evidence.sample_count >= 2`). This count is
the profiler's sample count, not the independent benchmark measurement count.
When the next page contains no finding above that threshold,
`low_information` is true on the current page so a client can stop before
fetching it. Deployments may lower the threshold to one quantified observation.

The following token-efficiency rules are part of the MVP contract:

* MCP tool descriptions and schemas stay concise; explanatory documentation is
  not repeated in every tool response.
* A `run_id`, `finding_id`, or cursor is a reference to server-side state. A
  follow-up response returns only the requested delta and does not repeat the
  complete report or prior findings.
* Budgets are enforced independently per response, run, MCP session, and
  configured time window. The server rejects a request that would exceed a
  budget before starting expensive serialization or profiling.
* Call-tree requests accept `top_k` and `max_depth`; source requests return
  only an explicitly requested line window. File contents are never included
  by default.
* Baseline comparisons return changed findings and metric deltas rather than
  two complete reports.
* If the next page contains no finding above the configured information-density
  threshold, the response is marked `low_information: true` so the client can
  stop requesting pages.
* The server records estimated input/output tokens per call and may expose
  hard limits for the LLM's explanatory response. Token estimates are
  client-tokenizer dependent; authoritative enforcement uses characters,
  bytes, item counts, and detail limits.

The target request policy is equivalent to:

```json
{
  "detail_level": "summary",
  "page_size": 10,
  "max_output_chars": 12000,
  "max_detail_depth": 3,
  "top_k": 20,
  "source_context_lines": 0,
  "max_explanation_chars": 4000
}
```

Clients may request a deeper level explicitly, but every field remains subject
to the server's lower of the requested limit and the active budget.
The enforced defaults are 12,000 response characters, 64,000 combined
estimated tokens per run, 256,000 combined estimated tokens per MCP session,
and 1,000,000 combined estimated tokens per 24-hour window. The implementation
also caps each server process at 2,000,000 estimated tokens. Deployments may
lower these limits.

The server may report `estimated_input_tokens` and `estimated_output_tokens`,
but these are estimates because the connected client may use a different
tokenizer. Character/byte and item limits are authoritative. A response that
exceeds a limit is truncated at a safe record boundary and marked with
`truncated: true`; it is never silently cut in the middle of a structured
value. Raw Clinic artifacts remain local and are not included in automatic MCP
responses.

Run lifecycle states are `queued`, `running`, `completed`, `failed`,
`timed_out`, `cancelled`, and `partial`. `queued` and `running` responses use
the lightweight `run-status.schema.json` and contain no summary, findings, or
artifact list. Only terminal states use `performance-report.schema.json` and
the complete report fields. Failed, timed-out, cancelled, and partial reports
include a stable `error` object with `code`, `message`, and `retryable` fields.
If startup fails before Clinic produces an artifact, terminal reports set
`summary`, `findings`, and `artifacts` to `null` and expose only the error and
run metadata. `compatibility` is also `null` when the runtime or isolation
metadata could not be captured; these nulls mean unavailable data, not
fabricated empty results.
Partial runs may include the subset of analysis and artifacts that passed the
completion-manifest check. A report must not claim findings for an unsupported
metric. `get_profile_findings` returns an envelope error with code
`analysis_unavailable` and `data: null` when `findings` is null; it returns an
empty, valid findings page only when analysis completed and there are genuinely
no findings.

## Example interaction

An LLM client may start a workload with this input. Workload parameters belong
inside the `parameters` object, not at the top level of the tool input:

```json
{
  "tool": "start_profile_run",
  "input": {
    "workload": "tokenizer",
    "profiler": "clinic-flame",
    "parameters": {
      "iterations": 10,
      "warmup_iterations": 3
    }
  }
}
```

For a successful, approved workload, the current MCP implementation returns
`queued` with `run_id` and `run_capability`; poll `get_profile_status` to see
when the run reaches a terminal state. The response below is the MCP wire
payload. The SDK exposes the common response envelope as structured content and
includes its JSON serialization in text content; the facade and MCP wire shape
are the same:

```json
{
  "request_id": "req_001",
  "ok": true,
  "data": {
    "run_id": "run_2026-11-01T12-00-00Z_abc123",
    "run_capability": "cap_opaque_value",
    "status": "queued",
    "created_at": "2026-11-01T12:00:00Z"
  },
  "error": null,
  "usage": null
}
```

The response contains a `run_id` and an opaque `run_capability`. The client must
present that capability on every subsequent run-scoped request (`get_profile_status`,
`get_profile_findings`, `compare_profile_runs`, and `get_finding_detail`). After
completion, the client requests:

```json
{
  "tool": "get_profile_findings",
  "input": {
    "run_id": "run_2026-11-01T12-00-00Z_abc123",
    "run_capability": "cap_opaque_value",
    "page_size": 10,
    "max_output_chars": 8000,
    "cursor": null,
    "min_severity": "medium"
  }
}
```

The client can request one finding separately. Flame findings can return a
bounded call-tree subtree; source context is returned only when requested and
the source file resolves inside the project workspace. Other profiler adapters
may report the call tree as unavailable.

Workloads with `wall_clock_ms > 30000` or `memory_mb > 512` require approval.
`start_profile_run` returns `approval_required`, an `approval_token`, and a
`resource_cost_estimate` whose basis is the manifest's declared wall-clock,
CPU, memory, and artifact limits. This is a maximum resource envelope, not a
prediction of actual consumption or a monetary price. Call `approve_profile_run`
with that token. The MCP server uses form elicitation to show the workload,
profiler, parameters, and resource envelope to the user, then accepts the
approval only when the user explicitly confirms. Clients without elicitation
support fail closed; calling the approval tool alone is not confirmation. After
confirmation, retry the same start request with the token. The token is bound
to the workload key, manifest hash, profiler, validated parameters, and resource
estimate, and expires after 10 minutes. Any parameter, manifest, or limit
change invalidates it.
If approval races with cancellation or another approval, the first serialized
state transition wins; a cancelled run is never spawned and a consumed token
cannot be reused.

`cancel_profile_run` requires the same run capability. Cancellation is
idempotent: a queued run is removed before spawn, while a running run is
terminated through the isolation provider and transitions to `cancelled` only
after descendants are cleaned up. If artifacts were already produced, they are
retained as classified partial diagnostics and referenced by the terminal
report; otherwise analysis fields are unavailable.

The current MCP refuses to claim cancellation when the configured runner has
no cancellation operation, or when that operation returns before confirming a
terminal state. It returns `cancellation_unavailable` or
`cancellation_unconfirmed` and leaves the run available for status checks.
Terminal failures, timeouts, and cancellations without a profile report are
returned as schema-valid terminal reports with unavailable analysis fields and
a stable error object.

`iterations` and `warmup_iterations` have meaning only when declared by the
workload manifest. A workload may instead define a fixed server lifetime or a
request-count driver. `duration_ms` is accepted only for workloads that declare
duration-based termination. Unsupported parameters are rejected rather than
silently ignored. Warmup runs are excluded from reported measurements.

## Security and safety

Model-triggered profiling is local code execution and must be treated as a
privileged capability, even though it is intended for diagnostics.

The implementation must:

* allow only immutable manifest workloads, never arbitrary npm scripts or shell
  strings;
* validate all numeric and enum parameters;
* use a dedicated run root with canonical-path checks; reject symlinks and any
  path that resolves outside that root;
* apply CPU, memory, wall-clock, network, and artifact-size limits through the
  configured isolation provider;
* avoid inheriting production credentials where possible;
* classify artifacts as `public-diagnostic`, `sensitive-diagnostic`, or
  `restricted` and apply the classification to every MCP response;
* sanitize source paths, source snippets, benchmark payloads, environment
  values, profiler output, and raw-artifact references before returning them;
* expose only opaque artifact references to MCP clients; never return host
  filesystem paths or turn client-provided paths into file-access operations;
* before `get_finding_detail` reads source context, resolve the location against
  canonical paths under `/workspace` or a manifest-declared read-only input
  mount; reject absolute paths, traversal, symlinks, and all other locations;
* retain artifacts only for a configured period (default 24 hours), then delete
  them securely or mark them unavailable; and
* provide a human-visible confirmation or policy gate for expensive runs.

The MCP server should default to read-only analysis after a run has completed.
`get_finding_detail` must apply the same ownership, path, classification, and
redaction checks as the summary endpoint. Writing source files, changing
benchmark inputs, or deploying a profiled process is outside the scope of this
RFC.

All report content originating from the profiled process is untrusted data.
Function names, file names, strings, benchmark output, source snippets, and
profiler text must be serialized as data, clearly delimited from the MCP
server's instructions, and escaped for the selected transport. The LLM client
must be instructed to treat these fields as evidence only, never as commands or
instructions. Sanitization and prompt-injection detection are defense in depth;
they do not make profiled content trusted.

## Compatibility and rollout

The feature can be introduced without changing existing Clinic commands:

1. Add the runner and report schema as an optional companion package or
   opt-in scripts.
2. Add one reference workload and a fixture-based analyzer test.
3. Add baseline comparison and bounded report generation.
4. Add the optional MCP server.
5. Update `README.md` with the implemented CLI/MCP setup, Linux prerequisites,
   manifest format, security restrictions, token/output budgets, and links to
   the JSON Schemas. The README update happens only after the end-to-end MVP
   workflow and fixture tests pass; the RFC must not be presented there as an
   already available feature.
6. Add additional profilers and workloads only when their output can be
   normalized reliably.

Users who do not install the companion package continue to use `clinic doctor`,
`clinic bubbleprof`, `clinic flame`, and `clinic heapprofiler` exactly as before.

## Alternatives considered

### Send raw Clinic artifacts to the LLM

Rejected as the default because profiles can exceed context limits, are costly
to transmit, and make it harder to distinguish evidence from interpretation.

### Let the MCP server execute arbitrary shell commands

Rejected because it expands the attack surface and makes runs difficult to
reproduce or audit.

### Modify each Clinic visualizer to emit LLM prompts

Rejected because visualization and model integration have different release
cycles and users may want to consume reports without using an LLM.

### Use embeddings for profile analysis

Not proposed for the primary path. Exact aggregation and numerical comparison
are more appropriate for CPU, latency, and memory data. Embeddings may be added
later for searching historical human-written incident reports.

## Implementation decisions

* The opt-in CLI and MCP server live in this repository; they do not change the
  existing Clinic commands.
* The first implementation normalizes Doctor, Bubbleprof, Flame, and Heap
  Profiler output through separate adapters.
* The defaults are the bounded limits described in the Context and token
  budgets section; deployments may lower them.
* Completed reports are retained in the MCP process for the run retention
  period, while raw artifacts are stored under the project's run directory.
  Restarting the server revokes capabilities and in-memory reports, as required
  by the capability lifecycle. Cross-restart baseline catalogs are not part of
  this local stdio implementation.
* Local stdio is the supported MCP transport. No network transport is exposed.

## Success criteria

The feature is successful when a user can run one approved manifest workload,
ask an LLM for the top bottlenecks, inspect the evidence for a selected finding,
and reproduce the same report locally without sending the raw Clinic artifact
to a remote service.
