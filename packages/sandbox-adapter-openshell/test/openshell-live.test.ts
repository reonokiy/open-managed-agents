import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sandboxProvider } from "../src/index";

it.skipIf(process.env.OMA_OPENSHELL_LIVE !== "1")("executes tools and reattaches through a real Gateway", async () => {
  const ctx = { sessionId: `acceptance-${randomUUID()}`, workdir: "/unused" };
  const sandbox = await sandboxProvider.create(ctx, process.env);
  try {
    expect(await sandbox.exec("printf openshell-ready")).toBe("openshell-ready");
    const bytes = Buffer.alloc(180_001);
    for (let i = 0; i < bytes.length; ++i) bytes[i] = i % 256;
    await sandbox.writeFileBytes("acceptance/binary.bin", bytes);
    expect(Buffer.from(await sandbox.readFileBytes("acceptance/binary.bin"))).toEqual(bytes);
    await sandbox.exec("printf 'from-exec' > /workspace/acceptance/from-exec.txt");
    expect(await sandbox.readFile("/workspace/acceptance/from-exec.txt")).toBe("from-exec");
    await sandbox.writeFile("/workspace/acceptance/from-sftp.txt", "from-sftp\n");
    expect(await sandbox.exec("IFS= read -r value < /workspace/acceptance/from-sftp.txt; printf '%s' \"$value\"")).toBe("from-sftp");
    const attached = await sandboxProvider.resume(sandbox.runtimeHandle(), ctx, process.env);
    expect(await attached.status()).toBe("running");
    expect(Buffer.from(await attached.readFileBytes("acceptance/binary.bin"))).toEqual(bytes);
  } finally {
    await sandbox.destroy();
  }
}, 180_000);
