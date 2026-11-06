import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type {
  SandboxCheckpointHandle, SandboxCheckpointKind, SandboxFactory, SandboxFactoryContext,
  SandboxFactoryEnv, SandboxPort, SandboxProviderPort, SandboxRuntimeHandle,
  SandboxRuntimePort, SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";

// Structural subset of NVIDIA's curated SDK. The SDK is loaded at runtime so
// deployments not using OpenShell do not need its GitHub Packages distribution.
export interface OpenShellRef {
  id: string;
  name: string;
  workspace: string;
  phase: string;
  labels: Record<string, string>;
}
export interface OpenShellExecOptions {
  workspace: string;
  workdir?: string;
  environment?: Record<string, string>;
  timeoutSecs: number;
  stdin?: Buffer;
  noLoginShell: boolean;
  signal: AbortSignal;
}
export interface OpenShellClientPort {
  create(spec: {
    name: string; workspace: string; image: string; labels: Record<string, string>;
  }): Promise<OpenShellRef>;
  get(name: string, options: { workspace: string }): Promise<OpenShellRef>;
  waitReady(name: string, timeoutSecs: number, options: { workspace: string }): Promise<OpenShellRef>;
  delete(name: string, options: { workspace: string; allowMissing: boolean }): Promise<unknown>;
  exec(name: string, command: string[], options: OpenShellExecOptions): Promise<{
    exitCode: number; stdout: Uint8Array; stderr: Uint8Array;
  }>;
}
export interface OpenShellConnectionOptions {
  gateway: string;
  caCert?: Buffer;
  clientCert: Buffer;
  clientKey: Buffer;
}
export type OpenShellConnector = (options: OpenShellConnectionOptions) => Promise<OpenShellClientPort>;

export interface OpenShellOptions {
  gateway: string;
  workspace: string;
  readyTimeoutSeconds: number;
  caFile?: string;
  certFile: string;
  keyFile: string;
}

export function optionsFromEnvironment(env: SandboxFactoryEnv): OpenShellOptions {
  let gateway: URL;
  try { gateway = new URL(env.OPENSHELL_GATEWAY ?? ""); }
  catch { throw new Error("OPENSHELL_GATEWAY must be an HTTPS gateway URL"); }
  if (gateway.protocol !== "https:" || gateway.username || gateway.password
    || gateway.pathname !== "/" || gateway.search || gateway.hash) {
    throw new Error("OPENSHELL_GATEWAY must be HTTPS without credentials, path, query or fragment");
  }
  if (!env.OPENSHELL_CLIENT_CERT_FILE || !env.OPENSHELL_CLIENT_KEY_FILE) {
    throw new Error("OpenShell requires OPENSHELL_CLIENT_CERT_FILE and OPENSHELL_CLIENT_KEY_FILE");
  }
  const readyTimeoutSeconds = Number(env.OPENSHELL_READY_TIMEOUT_SECONDS ?? 120);
  if (!Number.isSafeInteger(readyTimeoutSeconds) || readyTimeoutSeconds <= 0) {
    throw new Error("OPENSHELL_READY_TIMEOUT_SECONDS must be a positive integer");
  }
  const workspace = env.OPENSHELL_WORKSPACE ?? "default";
  if (!workspace.trim()) throw new Error("OPENSHELL_WORKSPACE must not be empty");
  return {
    gateway: gateway.origin, workspace,
    readyTimeoutSeconds,
    caFile: env.OPENSHELL_CA_FILE,
    certFile: env.OPENSHELL_CLIENT_CERT_FILE,
    keyFile: env.OPENSHELL_CLIENT_KEY_FILE,
  };
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
function filePath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("Invalid sandbox file path");
  return posix.resolve("/workspace", path);
}
const unsupported = (): never => { throw new Error("OpenShell adapter does not support checkpoints or suspension"); };

export class OpenShellSandbox implements SandboxPort, SandboxRuntimePort {
  private env: Record<string, string> = {};
  constructor(
    private readonly client: OpenShellClientPort,
    private readonly ref: OpenShellRef,
  ) {}

  runtimeHandle(): SandboxRuntimeHandle {
    // Include the immutable UUID as well as the workspace/name addressed by RPC.
    return { provider: "openshell", runtimeId: JSON.stringify([this.ref.workspace, this.ref.name, this.ref.id]) };
  }
  runtimeCapabilities() { return { lease: false, suspend: [], checkpoint: [] } as const; }
  async status(): Promise<SandboxRuntimeStatus> {
    const ref = await this.client.get(this.ref.name, { workspace: this.ref.workspace });
    if (ref.id !== this.ref.id) throw new Error("OpenShell sandbox identity changed");
    if (ref.phase === "ready" || ref.phase === "running") return "running";
    if (ref.phase === "suspended") return "suspended";
    if (["stopped", "completed", "error", "deleted"].includes(ref.phase)) return "stopped";
    return "unknown";
  }
  async renewLease(_input: { ttlMs: number }): Promise<void> {
    throw new Error("OpenShell adapter does not support leases");
  }
  async suspend(_input: { kind: SandboxCheckpointKind }): Promise<SandboxCheckpointHandle> { return unsupported(); }
  async resume(_checkpoint: SandboxCheckpointHandle): Promise<void> { unsupported(); }
  async checkpoint(_input: { kind: SandboxCheckpointKind; name?: string }): Promise<SandboxCheckpointHandle> { return unsupported(); }

  async setEnvVars(env: Record<string, string>): Promise<void> { Object.assign(this.env, env); }
  private async run(command: string[], timeout = 120_000, stdin?: Buffer, workdir?: string) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Command timeout must be positive");
    return this.client.exec(this.ref.name, command, {
      workspace: this.ref.workspace, workdir, environment: { ...this.env },
      timeoutSecs: Math.ceil(timeout / 1000), stdin, noLoginShell: true,
      signal: AbortSignal.timeout(Math.ceil(timeout)),
    });
  }
  async exec(command: string, timeout?: number): Promise<string> {
    const result = await this.run(["/bin/sh", "-c", command], timeout, undefined, "/workspace");
    const stdout = Buffer.from(result.stdout).toString("utf8");
    const stderr = Buffer.from(result.stderr).toString("utf8");
    return (stdout + (stderr ? `${stdout && !stdout.endsWith("\n") ? "\n" : ""}${stderr}` : "")).trimEnd()
      + (result.exitCode ? `\n[exit ${result.exitCode}]` : "");
  }
  async readFileBytes(path: string): Promise<Uint8Array> {
    const result = await this.run(["cat", "--", filePath(path)]);
    if (result.exitCode !== 0) throw new Error("OpenShell file read failed");
    return result.stdout;
  }
  async readFile(path: string): Promise<string> {
    return Buffer.from(await this.readFileBytes(path)).toString("utf8");
  }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const target = filePath(path);
    // File contents use stdin, never command interpolation or host temp files.
    const result = await this.run([
      "/bin/sh", "-c", `mkdir -p -- ${quote(posix.dirname(target))} && cat > ${quote(target)}`,
    ], undefined, Buffer.from(bytes));
    if (result.exitCode !== 0) throw new Error("OpenShell file write failed");
    return "ok";
  }
  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, Buffer.from(content, "utf8"));
  }
  async destroy(): Promise<void> {
    let ref: OpenShellRef;
    try { ref = await this.client.get(this.ref.name, { workspace: this.ref.workspace }); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "not_found") return;
      throw error;
    }
    if (ref.id !== this.ref.id) throw new Error("Refusing to delete a replacement OpenShell sandbox");
    await this.client.delete(this.ref.name, { workspace: this.ref.workspace, allowMissing: true });
  }
}

async function sdkConnect(options: OpenShellConnectionOptions): Promise<OpenShellClientPort> {
  const moduleName = "@nvidia/openshell-sdk";
  let sdk;
  try { sdk = await import(moduleName); }
  catch { throw new Error("Install the NVIDIA OpenShell TypeScript SDK before selecting SANDBOX_PROVIDER=openshell"); }
  if (typeof sdk.SandboxClient?.connect !== "function") throw new Error("Unsupported OpenShell SDK: SandboxClient.connect is missing");
  return sdk.SandboxClient.connect(options);
}

/** Override the connector for custom hosts and deterministic contract tests. */
export function createOpenShellProvider(connect: OpenShellConnector = sdkConnect): SandboxProviderPort<OpenShellSandbox> {
  async function connection(env: SandboxFactoryEnv) {
    const options = optionsFromEnvironment(env);
    const [clientCert, clientKey, caCert] = await Promise.all([
      readFile(options.certFile), readFile(options.keyFile),
      options.caFile ? readFile(options.caFile) : undefined,
    ]);
    const client = await connect({ gateway: options.gateway, clientCert, clientKey, caCert });
    return { client, options };
  }
  const labelsFor = (ctx: SandboxFactoryContext): Record<string, string> => ({
    "oma-session-id": ctx.sessionId,
    ...(ctx.allocationId ? { "oma-allocation-id": ctx.allocationId } : {}),
    ...(ctx.workspaceId ? { "oma-tenant-id": ctx.workspaceId } : {}),
  });
  return {
    async create(ctx, env) {
      if (ctx.preparedBase) throw new Error("OpenShell adapter does not support prepared bases");
      const image = ctx.image?.reference ?? env.OPENSHELL_IMAGE;
      if (!image?.trim()) throw new Error("OPENSHELL_IMAGE or an Environment catalog image is required");
      const { client, options } = await connection(env);
      // Cold creates always allocate a unique physical resource, even for the same session.
      const ref = await client.create({
        name: `oma-${randomUUID()}`, workspace: options.workspace, image, labels: labelsFor(ctx),
      });
      try {
        const ready = await client.waitReady(ref.name, options.readyTimeoutSeconds, { workspace: options.workspace });
        if (ready.id !== ref.id || ready.workspace !== options.workspace) throw new Error("Unexpected OpenShell allocation identity");
        const sandbox = new OpenShellSandbox(client, ready);
        const result = await client.exec(ready.name, ["mkdir", "-p", "/workspace"], {
          workspace: options.workspace, timeoutSecs: 30, noLoginShell: true, signal: AbortSignal.timeout(30_000),
        });
        if (result.exitCode !== 0) throw new Error("Cannot initialize OpenShell workspace");
        return sandbox;
      } catch (error) {
        // Never turn a failed create into attaching some other session's sandbox.
        await (async () => {
          const current = await client.get(ref.name, { workspace: options.workspace });
          if (current.id === ref.id) {
            await client.delete(ref.name, { workspace: options.workspace, allowMissing: true });
          }
        })().catch(() => undefined);
        throw error;
      }
    },
    async resume(handle, ctx, env) {
      if (handle.provider !== "openshell") throw new Error("Expected an OpenShell runtime handle");
      let identity: unknown;
      try { identity = JSON.parse(handle.runtimeId); } catch { throw new Error("Invalid OpenShell runtime handle"); }
      if (!Array.isArray(identity) || identity.length !== 3 || identity.some(v => typeof v !== "string" || !v)) {
        throw new Error("Invalid OpenShell runtime handle");
      }
      const [workspace, name, id] = identity as string[];
      const { client, options } = await connection(env);
      if (workspace !== options.workspace) throw new Error("OpenShell runtime workspace mismatch");
      const ref = await client.get(name, { workspace });
      if (ref.id !== id || ref.workspace !== workspace
        || Object.entries(labelsFor(ctx)).some(([key, value]) => ref.labels[key] !== value)) {
        throw new Error("OpenShell runtime ownership mismatch");
      }
      if (ref.phase !== "ready" && ref.phase !== "running") {
        throw new Error("OpenShell sandbox is not running; automatic restart is not supported");
      }
      return new OpenShellSandbox(client, ref);
    },
    async restore() { return unsupported(); },
  };
}

export const sandboxProvider = createOpenShellProvider();
export const sandboxFactory: SandboxFactory = Object.assign(
  (ctx: SandboxFactoryContext, env: SandboxFactoryEnv) => sandboxProvider.create(ctx, env),
  { capabilities: { allocationIsolation: true } },
);
