import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { Client, type SFTPWrapper } from "ssh2";
import type { OpenShellClientPort, OpenShellRef } from "./openshell";

export interface SftpFiles {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export type SftpConnector = (
  client: OpenShellClientPort, ref: OpenShellRef, signal: AbortSignal,
) => Promise<SftpFiles>;

export type RelayFrame =
  | { payload: { case: "init"; value: {
    sandbox: string; workspace: string; serviceId: string;
    target: { case: "ssh"; value: Record<string, never> }; authorizationToken: string;
  } } }
  | { payload: { case: "data"; value: Uint8Array } };
export interface SshSession {
  sandboxId: string;
  token: string;
  hostKeyFingerprint?: string;
}
export interface SshGateway {
  createSshSession(input: {
    sandbox: string; workspaceScope: { selection: { case: "workspace"; value: string } };
  }, options: { signal: AbortSignal }): Promise<SshSession>;
  revokeSshSession(input: { token: string; allowMissing: boolean }, options: { signal: AbortSignal }): Promise<unknown>;
  forwardTcp(input: AsyncIterable<RelayFrame>, options: { signal: AbortSignal }): AsyncIterable<{
    payload: { case: "data"; value: Uint8Array } | { case: undefined; value?: undefined };
  }>;
}

/** Translate OpenMA paths to the SFTP virtual root, which is the workload cwd. */
export function sftpPath(path: string): string {
  if (!path || path.includes("\0") || path.split("/").includes("..")) throw new Error("Invalid sandbox file path");
  if (posix.isAbsolute(path)) {
    if (path !== "/workspace" && !path.startsWith("/workspace/")) {
      throw new Error("SFTP file paths must be under /workspace");
    }
    path = path.slice("/workspace".length);
  }
  return posix.resolve("/", path);
}

/** Byte-stream socket for ssh2 over ForwardTcp. Node streams bound both queues. */
export class SshRelay extends Duplex {
  private readonly outgoing = new PassThrough({ highWaterMark: 64 * 1024 });
  private readonly controller = new AbortController();
  private wakeRead?: () => void;
  private readonly onAbort = () => this.destroy(new Error("OpenShell SFTP operation aborted"));
  readonly finished: Promise<void>;

  constructor(gateway: SshGateway, init: RelayFrame, private readonly signal: AbortSignal) {
    super({ readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 });
    // Errors may arrive before ssh2 has installed its socket listeners.
    this.on("error", () => {});
    this.outgoing.on("error", () => {});
    signal.addEventListener("abort", this.onAbort, { once: true });
    const outgoing = this.outgoing;
    async function* frames(): AsyncGenerator<RelayFrame> {
      yield init;
      for await (const chunk of outgoing) {
        const bytes = Buffer.from(chunk);
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          yield { payload: { case: "data", value: bytes.subarray(offset, offset + 64 * 1024) } };
        }
      }
    }
    this.finished = (async () => {
      try {
        for await (const frame of gateway.forwardTcp(frames(), { signal: this.controller.signal })) {
          if (this.destroyed) break;
          if (frame.payload.case !== "data") throw new Error("Unexpected OpenShell SSH relay frame");
          const bytes = frame.payload.value;
          for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
            const demand = new Promise<void>(resolve => { this.wakeRead = resolve; });
            if (this.push(Buffer.from(bytes.subarray(offset, offset + 64 * 1024)))) this.wakeRead = undefined;
            else await demand;
            if (this.destroyed) break;
          }
        }
        if (!this.destroyed) this.destroy(new Error("OpenShell SSH relay closed"));
      } catch {
        if (!this.destroyed) this.destroy(new Error("OpenShell SSH relay failed"));
      }
    })();
    if (signal.aborted) this.onAbort();
  }
  _read(): void { this.wakeRead?.(); this.wakeRead = undefined; }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outgoing.write(chunk, callback);
  }
  _final(callback: (error?: Error | null) => void): void { this.outgoing.end(callback); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.signal.removeEventListener("abort", this.onAbort);
    this.controller.abort();
    this.outgoing.destroy();
    this.wakeRead?.();
    this.wakeRead = undefined;
    callback(error);
  }
}

export function verifyHostKey(fingerprint: string, key: Buffer): boolean {
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fingerprint)) return false;
  const expected = Buffer.from(fingerprint.slice(7).replace(/=+$/, ""), "base64");
  const actual = createHash("sha256").update(key).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function callback<T>(
  start: (done: (error: Error | undefined | null, result: T) => void) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new Error("OpenShell SFTP operation aborted")); };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      start((error, result) => {
        cleanup();
        if (error) reject(error); else resolve(result);
      });
    } catch (error) { cleanup(); reject(error); }
  });
}

/** Chunks stay below OpenShell's SFTP packet limits, including packet overhead. */
export function fileOperations(sftp: SFTPWrapper, signal: AbortSignal): Pick<SftpFiles, "readFile" | "writeFile"> {
  const chunkSize = 32 * 1024;
  const request = <T>(start: (done: (error: Error | undefined | null, result: T) => void) => void) => callback(start, signal);
  const open = (path: string, flags: "r" | "w") => request<Buffer>(done => sftp.open(path, flags, done));
  const close = (handle: Buffer) => request<void>(done => sftp.close(handle, error => done(error, undefined)));
  async function withHandle<T>(path: string, flags: "r" | "w", action: (handle: Buffer) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const handle = await open(path, flags);
    let failed = false;
    try { return await action(handle); }
    catch (error) { failed = true; throw error; }
    finally {
      // A dead connection cannot close a handle; preserve the original failure.
      if (!signal.aborted) await close(handle).catch(error => { if (!failed) throw error; });
    }
  }
  return {
    async readFile(path) {
      return withHandle(path, "r", async handle => {
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          signal.throwIfAborted();
          const buffer = Buffer.alloc(chunkSize);
          const count = await request<number>(done => {
            sftp.read(handle, buffer, 0, buffer.length, offset, (error, bytesRead) => done(error, bytesRead));
          });
          if (count === 0) break;
          chunks.push(buffer.subarray(0, count));
          offset += count;
        }
        return Buffer.concat(chunks);
      });
    },
    async writeFile(path, bytes) {
      let parent = "";
      for (const part of posix.dirname(path).split("/").filter(Boolean)) {
        signal.throwIfAborted();
        parent += `/${part}`;
        try { await request<void>(done => sftp.mkdir(parent, error => done(error, undefined))); }
        catch (error) {
          // v3 returns generic FAILURE for mkdir(existing); stat distinguishes
          // a directory race from permissions, missing parents or a plain file.
          const attrs = await request<import("ssh2").Stats>(done => sftp.stat(parent, done)).catch(() => {
            signal.throwIfAborted();
            throw error;
          });
          if (!attrs.isDirectory()) throw error;
        }
      }
      await withHandle(path, "w", async handle => {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          signal.throwIfAborted();
          const chunk = Buffer.from(bytes.subarray(offset, offset + chunkSize));
          await request<void>(done => {
            sftp.write(handle, chunk, 0, chunk.length, offset, error => done(error, undefined));
          });
        }
      });
    },
  };
}

export const openSftp: SftpConnector = async (client, ref, signal) => {
  const gateway = client.raw;
  if (!gateway) throw new Error("OpenShell SDK raw SSH relay methods are required for SFTP");
  signal.throwIfAborted();
  // Validate the UUID again before authorizing a name-addressed SSH session.
  const current = await client.get(ref.name, { workspace: ref.workspace, signal });
  if (current.id !== ref.id || current.workspace !== ref.workspace) throw new Error("OpenShell sandbox identity changed");
  const session = await gateway.createSshSession({
    sandbox: ref.name, workspaceScope: { selection: { case: "workspace", value: ref.workspace } },
  }, { signal });
  let ssh: Client | undefined;
  let sftp: SFTPWrapper | undefined;
  let relay: SshRelay | undefined;
  const stopped = new AbortController();
  const operationSignal = AbortSignal.any([signal, stopped.signal]);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    signal.removeEventListener("abort", onAbort);
    ssh?.removeListener("close", onAbort);
    ssh?.removeListener("error", onAbort);
    sftp?.removeListener("close", onAbort);
    sftp?.removeListener("error", onAbort);
    stopped.abort();
    // One failed local teardown must not prevent token revocation.
    for (const stop of [() => sftp?.end(), () => ssh?.destroy(), () => relay?.destroy()]) {
      try { stop(); } catch { /* Continue releasing the other resources. */ }
    }
    // Revocation must use a fresh deadline, not the cancelled file-operation signal.
    try {
      await gateway.revokeSshSession({ token: session.token, allowMissing: true }, { signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new Error("OpenShell SSH session revocation failed");
    }
  })();
  const onAbort = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (session.sandboxId !== ref.id || !session.token || !session.hostKeyFingerprint) {
      throw new Error("OpenShell SSH session lacks the expected sandbox identity or host key");
    }
    operationSignal.throwIfAborted();
    relay = new SshRelay(gateway, { payload: { case: "init", value: {
      sandbox: ref.name, workspace: ref.workspace, serviceId: `ssh-proxy:${ref.name}`,
      target: { case: "ssh", value: {} }, authorizationToken: session.token,
    } } }, operationSignal);
    ssh = new Client();
    const transport = ssh;
    // Keep asynchronous transport errors observed after the handshake too.
    transport.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const fail = () => { cleanup(); reject(new Error("OpenShell SFTP SSH connection failed")); };
      const ready = () => { cleanup(); resolve(); };
      const cleanup = () => {
        transport.removeListener("ready", ready);
        transport.removeListener("error", fail);
        transport.removeListener("close", fail);
        operationSignal.removeEventListener("abort", fail);
      };
      transport.once("ready", ready).once("error", fail).once("close", fail);
      operationSignal.addEventListener("abort", fail, { once: true });
      transport.connect({
        sock: relay, username: "sandbox", authHandler: ["none"], readyTimeout: 15_000,
        hostVerifier: (key: Buffer) => verifyHostKey(session.hostKeyFingerprint!, key),
      });
      if (operationSignal.aborted) fail();
    });
    transport.on("close", onAbort).on("error", onAbort);
    sftp = await callback<SFTPWrapper>(done => transport.sftp(done), operationSignal);
    operationSignal.throwIfAborted();
    sftp.on("error", () => {});
    sftp.on("close", onAbort).on("error", onAbort);
    return { ...fileOperations(sftp, operationSignal), close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
};
