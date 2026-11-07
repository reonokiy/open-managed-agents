import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenShellProvider, OpenShellSandbox, optionsFromEnvironment, sandboxFactory,
  type OpenShellClientPort, type OpenShellRef,
} from "../src/index";
import type { SftpConnector, SftpFiles } from "../src/sftp";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => Buffer.alloc(0)) }));

const env = {
  OPENSHELL_GATEWAY: "https://gateway.example.test",
  OPENSHELL_CLIENT_CERT_FILE: "/run/openshell/client.crt",
  OPENSHELL_CLIENT_KEY_FILE: "/run/openshell/client.key",
  OPENSHELL_IMAGE: "registry.example.test/sandbox@sha256:fixture",
  OPENSHELL_WORKSPACE: "agents",
};
const ctx = { sessionId: "session-test", allocationId: "allocation-a", workspaceId: "tenant-a", workdir: "/unused" };
const ok = () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
let client: OpenShellClientPort;
let refs: Map<string, OpenShellRef>;
let files: SftpFiles;
let connectFiles: SftpConnector;
beforeEach(() => {
  refs = new Map();
  client = {
    create: vi.fn(async spec => {
      const ref = { ...spec, id: `uuid-${refs.size}`, phase: "ready" };
      refs.set(ref.name, ref);
      return ref;
    }),
    get: vi.fn(async name => {
      const ref = refs.get(name);
      if (!ref) throw new Error("not found");
      return ref;
    }),
    waitReady: vi.fn(async name => refs.get(name)!),
    delete: vi.fn(async name => { refs.delete(name); }),
    exec: vi.fn(async () => ({ ...ok(), stdout: Buffer.from("/workspace\n") })),
  };
  files = { readFile: vi.fn(async () => Buffer.alloc(0)), writeFile: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  connectFiles = vi.fn(async () => files);
});
const provider = () => createOpenShellProvider(async () => client, connectFiles);

describe("OpenShell configuration", () => {
  it("keeps TLS verification enabled and requires paired mTLS files", () => {
    expect(optionsFromEnvironment(env)).toMatchObject({ workspace: "agents", readyTimeoutSeconds: 120 });
    expect(() => optionsFromEnvironment({ ...env, OPENSHELL_CLIENT_KEY_FILE: undefined })).toThrow(/requires/);
  });
  it.each([
    "http://gateway.example.test", "https://user:pass@gateway.example.test",
    "https://gateway.example.test/path", "https://gateway.example.test/?query=1", "https://gateway.example.test/#fragment",
  ])("rejects unsafe gateway configuration %s", gateway => {
    expect(() => optionsFromEnvironment({ ...env, OPENSHELL_GATEWAY: gateway })).toThrow(/HTTPS/);
  });
  it.each(["0", "-1", "NaN", "1.5"])("rejects invalid readiness timeout %s", value => {
    expect(() => optionsFromEnvironment({ ...env, OPENSHELL_READY_TIMEOUT_SECONDS: value })).toThrow(/positive/);
  });
  it.each(["0", "-1", "1.5", "4294967296"])("rejects invalid file timeout %s", value => {
    expect(() => optionsFromEnvironment({ ...env, OPENSHELL_FILE_TIMEOUT_MS: value })).toThrow(/uint32/);
  });
});

describe("OpenShell sandbox lifecycle", () => {
  it("allocates independent sandboxes and reconnects using ownership labels", async () => {
    const p = provider();
    const a = await p.create(ctx, env);
    const b = await p.create(ctx, env);
    expect(a.runtimeHandle()).not.toEqual(b.runtimeHandle());
    expect(sandboxFactory.capabilities?.allocationIsolation).toBe(true);
    expect((await p.resume(a.runtimeHandle(), ctx, env)).runtimeHandle()).toEqual(a.runtimeHandle());
    await a.destroy();
    expect(refs.size).toBe(1);
    expect(await b.status()).toBe("running");
  });
  it("passes the catalog image and connection credentials only to the SDK connector", async () => {
    const connect = vi.fn(async () => client);
    await createOpenShellProvider(connect).create({ ...ctx, image: { alias: "custom", reference: "custom:image" } }, env);
    expect(connect).toHaveBeenCalledWith({
      gateway: env.OPENSHELL_GATEWAY, caCert: undefined, clientCert: Buffer.alloc(0), clientKey: Buffer.alloc(0),
    });
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ image: "custom:image", workspace: "agents" }));
    expect(client.create).not.toHaveBeenCalledWith(expect.objectContaining({ environment: expect.anything() }));
  });
  it("cleans up an allocation if readiness fails", async () => {
    vi.mocked(client.waitReady).mockRejectedValueOnce(new Error("not ready"));
    await expect(provider().create(ctx, env)).rejects.toThrow("not ready");
    expect(refs.size).toBe(0);
    expect(client.delete).toHaveBeenCalledTimes(1);
  });
  it("creates and reattaches without probing or restricting the workload root", async () => {
    const p = provider();
    const s = await p.create(ctx, env);
    await p.resume(s.runtimeHandle(), ctx, env);
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(connectFiles).not.toHaveBeenCalled();
  });
  it("does not delete a replacement when readiness observes a changed UUID", async () => {
    vi.mocked(client.waitReady).mockImplementationOnce(async name => {
      const replacement = { ...refs.get(name)!, id: "replacement" };
      refs.set(name, replacement);
      return replacement;
    });
    await expect(provider().create(ctx, env)).rejects.toThrow(/allocation identity/);
    expect(client.delete).not.toHaveBeenCalled();
  });
  it("rejects unsupported prepared bases and missing images before creating resources", async () => {
    await expect(provider().create({ ...ctx, preparedBase: { provider: "other", id: "base" } }, env)).rejects.toThrow(/prepared bases/);
    await expect(provider().create(ctx, { ...env, OPENSHELL_IMAGE: undefined })).rejects.toThrow(/image/i);
    expect(client.create).not.toHaveBeenCalled();
  });
  it("rejects cross-workspace, cross-tenant and cross-allocation resumes", async () => {
    const p = provider();
    const sandbox = await p.create(ctx, env);
    await expect(p.resume(sandbox.runtimeHandle(), ctx, { ...env, OPENSHELL_WORKSPACE: "other" })).rejects.toThrow(/workspace mismatch/);
    await expect(p.resume(sandbox.runtimeHandle(), { ...ctx, workspaceId: "other" }, env)).rejects.toThrow(/ownership/);
    await expect(p.resume(sandbox.runtimeHandle(), { ...ctx, allocationId: "other" }, env)).rejects.toThrow(/ownership/);
  });
  it("does not attach to or delete a same-name replacement", async () => {
    const p = provider();
    const sandbox = await p.create(ctx, env);
    const ref = [...refs.values()][0];
    refs.set(ref.name, { ...ref, id: "replacement" });
    await expect(p.resume(sandbox.runtimeHandle(), ctx, env)).rejects.toThrow(/ownership/);
    await expect(sandbox.destroy()).rejects.toThrow(/replacement/);
    expect(client.delete).not.toHaveBeenCalled();
  });
  it("treats already deleted sandboxes as cleaned up, but propagates authorization failures", async () => {
    const sandbox = await provider().create(ctx, env);
    vi.mocked(client.get).mockRejectedValueOnce({ code: "not_found" });
    await expect(sandbox.destroy()).resolves.toBeUndefined();
    vi.mocked(client.get).mockRejectedValueOnce({ code: "permission_denied" });
    await expect(sandbox.destroy()).rejects.toEqual({ code: "permission_denied" });
  });
  it("does not claim stopped sandboxes are resumed or snapshots are supported", async () => {
    const p = provider();
    const sandbox = await p.create(ctx, env);
    [...refs.values()][0].phase = "stopped";
    expect(await sandbox.status()).toBe("stopped");
    await expect(p.resume(sandbox.runtimeHandle(), ctx, env)).rejects.toThrow(/not running/);
    expect(sandbox.runtimeCapabilities()).toEqual({ lease: false, suspend: [], checkpoint: [] });
    await expect(sandbox.checkpoint({ kind: "filesystem" })).rejects.toThrow(/not support/);
    await expect(sandbox.suspend({ kind: "memory" })).rejects.toThrow(/not support/);
  });
  it.each(["not-json", "[]", '["agents","name"]'])("rejects malformed handles %s", async runtimeId => {
    await expect(provider().resume({ provider: "openshell", runtimeId }, ctx, env)).rejects.toThrow(/Invalid/);
  });
});

describe("OpenShell tool execution", () => {
  async function sandbox() { return provider().create(ctx, env); }
  it("sets cwd, timeout, cancellation and environment without invoking a host shell", async () => {
    const s = await sandbox();
    await s.setEnvVars({ MODE: "test" });
    vi.mocked(client.exec).mockResolvedValueOnce({ exitCode: 3, stdout: Buffer.from("out"), stderr: Buffer.from("err") });
    expect(await s.exec("echo hello", 1500)).toBe("out\nerr\n[exit 3]");
    expect(client.exec).toHaveBeenLastCalledWith(expect.any(String), ["/bin/sh", "-c", "echo hello"], expect.objectContaining({
      workspace: "agents", workdir: "/workspace", environment: { MODE: "test" },
      timeoutSecs: 2, noLoginShell: true, signal: expect.any(AbortSignal),
    }));
  });
  it("uses SFTP for binary files and treats metacharacters as literal path bytes", async () => {
    const s = await sandbox();
    const bytes = Buffer.from([0, 255, 1, 10]);
    expect(await s.writeFileBytes("a'b;$(id)/data.bin", bytes)).toBe("/workspace/a'b;$(id)/data.bin");
    expect(files.writeFile).toHaveBeenCalledWith("/workspace/a'b;$(id)/data.bin", bytes);
    vi.mocked(files.readFile).mockResolvedValueOnce(bytes);
    expect(await s.readFileBytes("/workspace/data.bin")).toEqual(bytes);
    expect(files.readFile).toHaveBeenCalledWith("/workspace/data.bin");
    expect(files.close).toHaveBeenCalledTimes(2);
    expect(client.exec).not.toHaveBeenCalled();
  });
  it.each(["/tmp/data.bin", "/mnt/memory/data.bin"])("passes absolute path %s unchanged to SFTP", async path => {
    const s = await sandbox();
    const bytes = Buffer.from([1, 2, 3]);
    expect(await s.writeFileBytes(path, bytes)).toBe(path);
    await s.readFileBytes(path);
    expect(files.writeFile).toHaveBeenCalledWith(path, bytes);
    expect(files.readFile).toHaveBeenCalledWith(path);
  });
  it("closes SFTP after a file failure and preserves the original error if cleanup also fails", async () => {
    const s = await sandbox();
    vi.mocked(files.readFile).mockRejectedValueOnce(new Error("missing file"));
    vi.mocked(files.close).mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(s.readFile("missing")).rejects.toThrow("missing file");
    expect(files.close).toHaveBeenCalledTimes(1);
    vi.mocked(files.close).mockRejectedValueOnce(new Error("revoke failed"));
    await expect(s.writeFile("data", "content")).rejects.toThrow("revoke failed");
  });
  it("rejects invalid paths and timeouts", async () => {
    const s = await sandbox();
    await expect(s.readFile("bad\0path")).rejects.toThrow(/Invalid/);
    await expect(s.exec("pwd", 0)).rejects.toThrow(/positive/);
  });
  it("exposes neither native credential egress nor in-sandbox harness transport", async () => {
    const s: OpenShellSandbox = await sandbox();
    expect(s).not.toHaveProperty("prepareCredentialEgress");
    expect(s).not.toHaveProperty("spawnDuplexProcess");
  });
});
