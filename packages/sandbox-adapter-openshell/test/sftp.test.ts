import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Socket } from "node:net";
import { duplexPair } from "node:stream";
import { Server, utils, type Connection } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenShellClientPort, OpenShellRef } from "../src/openshell";
import { openSftp, sftpPath, verifyHostKey, type RelayFrame, type SshGateway } from "../src/sftp";

// Ephemeral SSH host keys stay in memory; no fixture credentials or key files.
const host = utils.generateKeyPairSync("ed25519");
const parsed = utils.parseKey(host.private);
if (parsed instanceof Error) throw new Error("Cannot generate SSH test host key");
const publicKey = parsed.getPublicSSH();
const fingerprint = `SHA256:${createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`;
const ref: OpenShellRef = { id: "uuid-a", name: "sandbox-a", workspace: "agents", phase: "ready", labels: {} };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const files = new Map<string, Buffer>();
  const directories = new Set(["/"]);
  const handles = new Map<string, string>();
  const connections = new Set<Connection>();
  const sizes = { read: [] as number[], write: [] as number[] };
  const route: { sandbox?: string; workspace?: string; ssh?: boolean } = {};
  let closedHandles = 0;
  let rejectWrites = false;
  let stallRead = false;
  let dropOnRead = false;
  let endSftpOnRead = false;
  let rejectSftp = false;
  const code = utils.sftp.STATUS_CODE;
  const server = new Server({ hostKeys: [host.private] }, connection => {
    connections.add(connection);
    connection.on("error", () => {}).on("close", () => connections.delete(connection));
    connection.on("authentication", auth => auth.method === "none" ? auth.accept() : auth.reject());
    connection.on("ready", () => {
      connection.on("session", accept => {
        accept().on("sftp", (acceptSftp, rejectSftpRequest) => {
          if (rejectSftp) { rejectSftpRequest(); return; }
          const stream = acceptSftp();
          stream.on("error", () => {});
          stream.on("OPEN", (id, path, flags) => {
            if (flags & utils.sftp.OPEN_MODE.WRITE) {
              if (path.startsWith("/denied")) { stream.status(id, code.PERMISSION_DENIED); return; }
              if (flags & utils.sftp.OPEN_MODE.TRUNC) files.set(path, Buffer.alloc(0));
            } else if (!files.has(path)) { stream.status(id, code.NO_SUCH_FILE); return; }
            const handle = Buffer.from(String(handles.size + closedHandles + 1));
            handles.set(handle.toString(), path);
            stream.handle(id, handle);
          });
          stream.on("READ", (id, handle, offset, length) => {
            sizes.read.push(length);
            if (dropOnRead && sizes.read.length > 1) { connection.end(); return; }
            if (endSftpOnRead) { stream.end(); return; }
            if (stallRead) return;
            const bytes = files.get(handles.get(handle.toString())!)!;
            if (offset >= bytes.length) stream.status(id, code.EOF);
            else stream.data(id, bytes.subarray(offset, offset + length));
          });
          stream.on("WRITE", (id, handle, offset, bytes) => {
            sizes.write.push(bytes.length);
            if (rejectWrites) { stream.status(id, code.PERMISSION_DENIED); return; }
            const path = handles.get(handle.toString())!;
            const previous = files.get(path) ?? Buffer.alloc(0);
            const result = Buffer.alloc(Math.max(previous.length, offset + bytes.length));
            previous.copy(result);
            bytes.copy(result, offset);
            files.set(path, result);
            stream.status(id, code.OK);
          });
          stream.on("CLOSE", (id, handle) => {
            handles.delete(handle.toString());
            ++closedHandles;
            stream.status(id, code.OK);
          });
          stream.on("MKDIR", (id, path) => {
            if (path.startsWith("/denied")) stream.status(id, code.PERMISSION_DENIED);
            else if (directories.has(path) || files.has(path)) stream.status(id, code.FAILURE);
            else { directories.add(path); stream.status(id, code.OK); }
          });
          stream.on("STAT", (id, path) => {
            if (directories.has(path)) stream.attrs(id, { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 });
            else if (files.has(path)) stream.attrs(id, { mode: 0o100644, size: files.get(path)!.length, uid: 0, gid: 0, atime: 0, mtime: 0 });
            else stream.status(id, code.NO_SUCH_FILE);
          });
        });
      });
    });
  });
  cleanups.push(() => { for (const connection of connections) connection.end(); });
  const minted = new Set<string>();
  const raw: SshGateway = {
    createSshSession: vi.fn(async () => {
      const token = randomUUID();
      minted.add(token);
      return { sandboxId: ref.id, token, hostKeyFingerprint: fingerprint };
    }),
    revokeSshSession: vi.fn(async ({ token }) => { minted.delete(token); }),
    async *forwardTcp(input, { signal }) {
      const iterator = input[Symbol.asyncIterator]();
      const first = (await iterator.next()).value as RelayFrame;
      if (first.payload.case !== "init") throw new Error("Missing relay init");
      const init = first.payload.value;
      if (!minted.has(init.authorizationToken)) throw new Error("Unauthorized test relay");
      Object.assign(route, { sandbox: init.sandbox, workspace: init.workspace, ssh: init.target.case === "ssh" });
      const [wire, socket] = duplexPair();
      wire.on("error", () => {}); socket.on("error", () => {});
      const stop = () => { wire.destroy(); socket.destroy(); };
      signal.addEventListener("abort", stop, { once: true });
      server.injectSocket(socket as Socket);
      const writing = (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          if (next.value.payload.case !== "data") throw new Error("Duplicate relay init");
          if (!wire.write(next.value.payload.value)) await once(wire, "drain", { signal });
        }
        wire.end();
      })().catch(() => {});
      try {
        for await (const chunk of wire) {
          yield { payload: { case: "data" as const, value: Buffer.from(chunk) } };
        }
      } finally {
        signal.removeEventListener("abort", stop);
        stop();
        await writing;
      }
    },
  };
  const client = { get: vi.fn(async () => ref), raw } as unknown as OpenShellClientPort;
  return {
    client, raw, files, directories, handles, sizes, route, minted,
    get closedHandles() { return closedHandles; },
    denyWrites() { rejectWrites = true; },
    stallReads() { stallRead = true; },
    dropReads() { dropOnRead = true; },
    endSftpReads() { endSftpOnRead = true; },
    denySftp() { rejectSftp = true; },
  };
}

describe("OpenShell SFTP path and host identity", () => {
  it.each([
    ["file.txt", "/workspace/file.txt"], ["/workspace/file.txt", "/workspace/file.txt"],
    ["a'b;$(id)/data", "/workspace/a'b;$(id)/data"], ["dir/./file", "/workspace/dir/./file"],
    ["/tmp/data.bin", "/tmp/data.bin"], ["/mnt/memory/file", "/mnt/memory/file"],
    ["../file", "/workspace/../file"], ["/workspace/../tmp/file", "/workspace/../tmp/file"],
    ["/", "/"],
  ])("maps %s to provider path %s", (path, expected) => { expect(sftpPath(path)).toBe(expected); });
  it.each(["", "a\0b"])(
    "rejects invalid paths %s", path => { expect(() => sftpPath(path)).toThrow(); },
  );
  it("pins the raw SSH host key using the Gateway SHA256 fingerprint", () => {
    expect(verifyHostKey(fingerprint, publicKey)).toBe(true);
    expect(verifyHostKey(fingerprint, Buffer.from("different-public-key"))).toBe(false);
    expect(verifyHostKey("MD5:unsupported", publicKey)).toBe(false);
  });
});

describe("SSH/SFTP protocol over Gateway ForwardTcp", () => {
  it("round trips binary files in bounded chunks and releases handles and session", async () => {
    const f = fixture();
    const session = await openSftp(f.client, ref, AbortSignal.timeout(5_000));
    try {
      const bytes = Buffer.alloc(180_001);
      for (let i = 0; i < bytes.length; ++i) bytes[i] = i % 256;
      const path = "/a'b;$(id)/data.bin";
      await session.writeFile(path, bytes);
      expect(Buffer.from(await session.readFile(path))).toEqual(bytes);
      // Existing parent directories take the v3 mkdir FAILURE -> stat path.
      await session.writeFile(path, Buffer.alloc(0));
      expect((await session.readFile(path)).length).toBe(0);
      expect(f.route).toEqual({ sandbox: ref.name, workspace: ref.workspace, ssh: true });
      expect(Math.max(...f.sizes.read, ...f.sizes.write)).toBeLessThanOrEqual(32 * 1024);
      expect(f.handles.size).toBe(0);
      expect(f.closedHandles).toBe(4);
    } finally { await session.close(); }
    expect(f.minted.size).toBe(0);
    expect(f.raw.revokeSshSession).toHaveBeenCalledTimes(1);
    await session.close();
    expect(f.raw.revokeSshSession).toHaveBeenCalledTimes(1);
  });
  it("reports missing files and permissions without falling back to exec", async () => {
    const f = fixture();
    const session = await openSftp(f.client, ref, AbortSignal.timeout(5_000));
    try {
      await expect(session.readFile("/missing")).rejects.toMatchObject({ code: 2 });
      await expect(session.writeFile("/denied/file", Buffer.from("data"))).rejects.toMatchObject({ code: 3 });
      expect(f.handles.size).toBe(0);
    } finally { await session.close(); }
    expect(f.minted.size).toBe(0);
  });
  it("closes the file handle after a remote write error", async () => {
    const f = fixture();
    f.denyWrites();
    const session = await openSftp(f.client, ref, AbortSignal.timeout(5_000));
    try {
      await expect(session.writeFile("/file", Buffer.from("data"))).rejects.toMatchObject({ code: 3 });
      expect(f.handles.size).toBe(0);
      expect(f.closedHandles).toBe(1);
    } finally { await session.close(); }
  });
  it("rejects a parent that is a file rather than suppressing mkdir failures", async () => {
    const f = fixture();
    f.files.set("/parent", Buffer.from("data"));
    const session = await openSftp(f.client, ref, AbortSignal.timeout(5_000));
    try {
      await expect(session.writeFile("/parent/child", Buffer.from("data"))).rejects.toMatchObject({ code: 4 });
    } finally { await session.close(); }
  });
  it("aborts a stalled transfer and revokes with an independent live signal", async () => {
    const f = fixture();
    f.files.set("/file", Buffer.from("data")); f.stallReads();
    const controller = new AbortController();
    const session = await openSftp(f.client, ref, controller.signal);
    const reading = session.readFile("/file");
    const rejected = expect(reading).rejects.toThrow();
    await vi.waitFor(() => expect(f.sizes.read.length).toBe(1));
    controller.abort();
    await rejected;
    await session.close();
    expect(f.minted.size).toBe(0);
    const [, options] = vi.mocked(f.raw.revokeSshSession).mock.calls[0];
    expect(options.signal.aborted).toBe(false);
  });
  it("rejects file reads when the relay disappears instead of returning truncated data", async () => {
    const f = fixture();
    f.files.set("/file", Buffer.alloc(100_000, 1)); f.dropReads();
    const session = await openSftp(f.client, ref, AbortSignal.timeout(5_000));
    try {
      await expect(session.readFile("/file")).rejects.toThrow();
    } finally { await session.close(); }
    expect(f.minted.size).toBe(0);
  });
  it("closes and revokes if the server rejects the SFTP subsystem", async () => {
    const f = fixture(); f.denySftp();
    await expect(openSftp(f.client, ref, AbortSignal.timeout(5_000))).rejects.toThrow();
    expect(f.minted.size).toBe(0);
  });
  it("rejects reads when only the SFTP channel closes while SSH remains connected", async () => {
    const f = fixture();
    f.files.set("/file", Buffer.from("data")); f.endSftpReads();
    const session = await openSftp(f.client, ref, AbortSignal.timeout(5_000));
    try {
      await expect(session.readFile("/file")).rejects.toThrow();
    } finally { await session.close(); }
    expect(f.minted.size).toBe(0);
  });
  it("bounds a stalled SSH handshake by the operation deadline", async () => {
    const f = fixture();
    f.raw.forwardTcp = async function* (_input, { signal }) {
      if (!signal.aborted) await once(signal, "abort");
    };
    await expect(openSftp(f.client, ref, AbortSignal.timeout(20))).rejects.toThrow();
    expect(f.minted.size).toBe(0);
    expect(f.raw.revokeSshSession).toHaveBeenCalledTimes(1);
  });
  it("surfaces revocation failure after tearing down the SSH connection", async () => {
    const f = fixture();
    const session = await openSftp(f.client, ref, AbortSignal.timeout(5_000));
    vi.mocked(f.raw.revokeSshSession).mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(session.close()).rejects.toThrow("OpenShell SSH session revocation failed");
    await expect(session.readFile("/file")).rejects.toThrow();
  });
  it("does not mint sessions after cancellation", async () => {
    const f = fixture();
    await expect(openSftp(f.client, ref, AbortSignal.abort())).rejects.toThrow();
    expect(f.raw.createSshSession).not.toHaveBeenCalled();
  });
  it("fails closed on a mismatched SSH host key and still revokes the session", async () => {
    const f = fixture();
    vi.mocked(f.raw.createSshSession).mockImplementationOnce(async () => {
      const token = randomUUID(); f.minted.add(token);
      return { sandboxId: ref.id, token, hostKeyFingerprint: `SHA256:${Buffer.alloc(32).toString("base64").replace(/=+$/, "")}` };
    });
    await expect(openSftp(f.client, ref, AbortSignal.timeout(5_000))).rejects.toThrow(/SSH connection failed/);
    expect(f.minted.size).toBe(0);
  });
  it.each(["missing-host-key", "wrong-sandbox"])("rejects %s before connecting SSH", async mode => {
    const f = fixture();
    vi.mocked(f.raw.createSshSession).mockImplementationOnce(async () => {
      const token = randomUUID(); f.minted.add(token);
      return {
        sandboxId: mode === "wrong-sandbox" ? "other" : ref.id, token,
        hostKeyFingerprint: mode === "missing-host-key" ? undefined : fingerprint,
      };
    });
    await expect(openSftp(f.client, ref, AbortSignal.timeout(5_000))).rejects.toThrow(/identity or host key/);
    expect(f.minted.size).toBe(0);
    expect(f.route.sandbox).toBeUndefined();
  });
  it("checks the current UUID before minting an SSH session", async () => {
    const f = fixture();
    vi.mocked(f.client.get).mockResolvedValueOnce({ ...ref, id: "replacement" });
    await expect(openSftp(f.client, ref, AbortSignal.timeout(5_000))).rejects.toThrow(/identity changed/);
    expect(f.raw.createSshSession).not.toHaveBeenCalled();
  });
});
