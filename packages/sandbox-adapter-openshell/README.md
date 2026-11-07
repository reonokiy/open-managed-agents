# OpenShell tool sandbox (experimental)

An NVIDIA **OpenShell** backend for OpenMA's external-harness tool path. This
is not Alibaba/OpenSandbox, which has a separate adapter.

Pi runs in the OpenMA Node process. Commands and file operations run in an
OpenShell sandbox through the Gateway. Model API traffic remains on the
OpenMA host; this adapter does not configure OpenShell inference routing.

## Status and prerequisites

- OpenMA base: `4a81a9f`.
- SDK contract inspected: NVIDIA/OpenShell **v0.1.4**,
  `sdk/typescript/src/client.ts` and `transport.ts`. The required methods also
  exist at main commit `e9ba8d9e3568f7ca1a6320914d0b17e0572fac2d`.
- Tests include an in-process SSH/SFTP server with the real `ssh2` client and
  an emulated Gateway relay, plus injected-client lifecycle tests. They do not
  run the OpenShell runtime or a real Gateway. The opt-in live acceptance test
  has **not** been run against OpenShell 0.1.4.
- Install a Gateway-compatible, built `@nvidia/openshell-sdk` into the runtime
  package's module resolution path. NVIDIA currently declares GitHub Packages
  as its SDK registry; do not assume the package is available on npmjs.org.
  Follow NVIDIA's SDK distribution/build instructions. A source checkout alone
  is not sufficient: generated protobuf bindings and `dist/` must exist.
- The runtime Docker image does not install this SDK automatically yet.
- Supply a dedicated mTLS client identity authorized for the chosen workspace.
  Keep the private key in a read-only runtime secret mount, never in the sandbox,
  source tree, image, or command line. No CLI profile or interactive login is read.
- Commands use `/workspace` as their working directory, matching other OpenMA
  providers; the image must provide that directory. The adapter does not probe
  or require the workload's default working directory to equal `/workspace`.
  Gateway policies and runtime restrictions remain operator-owned.

The v0.1.4 SDK exposes the required direct exec, readiness, mTLS and raw
`CreateSshSession`, `ForwardTcp`, and `RevokeSshSession`
interfaces. This is source-level compatibility evidence, not a live acceptance
result. Match SDK/Gateway versions and run the live acceptance test before
using this in a deployment. Files use SFTP exclusively; there is no fallback
to shell-based file I/O, the CLI, or `kubectl exec`.

## Node configuration

Non-secret configuration only:

```sh
SANDBOX_PROVIDER=openshell
OPENSHELL_GATEWAY=https://openshell.internal.example.test
OPENSHELL_WORKSPACE=agents
OPENSHELL_IMAGE=registry.example.test/agent-tools:reviewed
OPENSHELL_CLIENT_CERT_FILE=/run/openshell/client.crt
OPENSHELL_CLIENT_KEY_FILE=/run/openshell/client.key
OPENSHELL_READY_TIMEOUT_SECONDS=120
OPENSHELL_FILE_TIMEOUT_MS=120000
# Optional private CA; omit to use system trust roots.
# OPENSHELL_CA_FILE=/run/openshell/ca.crt
```

Use an environment requiring a sandbox and an external Pi harness. A session
with `environment: { type: "none" }` will not allocate any sandbox.
Environment catalog images override `OPENSHELL_IMAGE`.

HTTPS with certificate verification and paired mTLS files is required. There
is intentionally no insecure verification switch or plaintext option.

## Supported contract

| Feature | Status |
| --- | --- |
| Unique sandbox per cold allocation | Implemented |
| Execute shell commands, timeout, environment | Implemented |
| Text and binary file read/write | Native SFTP over the Gateway SSH relay |
| Reattach to the same running sandbox | Implemented; checks UUID, workspace, session, allocation and tenant labels |
| Delete the sandbox | Implemented; checks UUID before name-based delete |
| Restart a stopped sandbox | Not implemented; fails explicitly |
| Lease, suspend, checkpoint, prepared bases | Not supported / not advertised |
| Native memory/output mounts and workspace backup | Not implemented |
| Vault credential-egress interception | Not implemented |
| ACP duplex stdio / harness inside sandbox | Not implemented |
| Background process handles | Not implemented |

Runtime handles are serialized resource identities, not credentials. Reattach is
not snapshot recovery. Name-based deletion has no atomic UUID precondition in
the curated SDK, so sandbox names must not be reused by other controllers.
The stock Node composition consumes `sandboxFactory`; exposing the provider's
`resume()` method does not itself add durable cross-process runtime-handle
storage to that composition.

An allocation uses an operator-configured OpenShell workspace; OpenMA tenants
do not automatically get separate OpenShell authorization boundaries. Use
separate service instances/workspaces/identities when tenant-level isolation
requires it. Labels are consistency checks, not a substitute for Gateway RBAC.

## SFTP lifecycle and paths

Each file operation creates a short-lived SSH session scoped to the sandbox and
workspace, opens the `ForwardTcp` SSH target, verifies the SSH host key against
the Gateway's SHA256 fingerprint, and requests the native `sftp` subsystem.
Authentication uses the Gateway's existing mTLS transport and session token;
no SSH private key, local SSH config, direct port 22, or local CLI is required.
Missing or mismatched host fingerprints fail closed.

Reads and writes use SFTP file handles in 32 KiB chunks. Parent directories are
created with SFTP. Both success and failure close the handle and connection and
attempt explicit token revocation using an independent cleanup deadline.
The operation deadline also cancels stalled handshakes and transfers. Sessions
are not pooled; files are returned in memory as required by `SandboxPort`.
Writes truncate the target; interrupted writes can leave partial files.

Relative paths receive a `/workspace/` prefix; absolute paths pass unchanged to
SFTP, matching the OpenSandbox, Daytona and LiteBox adapters. Writes return the
target path. Empty paths and NULs are rejected; path traversal and access checks
are delegated to the backend.

OpenShell v0.1.4 confines SFTP to the workload directory, which is its virtual
root. This server behavior still applies: with a `/workspace` workload root,
`/workspace/a` addresses the real `/workspace/a`, but `/tmp/a` addresses
`/workspace/tmp/a`, not the sandbox's `/tmp/a`. The adapter does not remove this
backend restriction or guarantee identical paths between SFTP and exec outside
the workload root. Memory/output mount support remains unimplemented.
Shell commands still execute through the exec RPC under the Gateway's policies.
The adapter never executes commands on the OpenMA host.

## Tests

```sh
pnpm --filter @open-managed-agents/sandbox-adapter-openshell test
pnpm --filter @open-managed-agents/sandbox-adapter-openshell typecheck
```

The following explicitly opts into creating and deleting a real sandbox using
pre-provisioned runtime identity files. Run only against an authorized test
workspace; it does not configure credentials or change Gateway policies:

```sh
OMA_OPENSHELL_LIVE=1 pnpm --filter @open-managed-agents/sandbox-adapter-openshell test
```

No production cluster acceptance, Pi/Magpie tool round trip, cross-process
recovery, or load testing has been performed for this prototype.
