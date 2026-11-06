import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sandboxProvider } from "../src/index";

it.skipIf(process.env.OMA_OPENSHELL_LIVE !== "1")("executes tools and reattaches through a real Gateway", async () => {
  const ctx = { sessionId: `acceptance-${randomUUID()}`, workdir: "/unused" };
  const sandbox = await sandboxProvider.create(ctx, process.env);
  try {
    expect(await sandbox.exec("printf openshell-ready")).toBe("openshell-ready");
    const bytes = Buffer.from([0, 255, 1, 10]);
    await sandbox.writeFileBytes("acceptance/binary.bin", bytes);
    expect(Buffer.from(await sandbox.readFileBytes("acceptance/binary.bin"))).toEqual(bytes);
    const attached = await sandboxProvider.resume(sandbox.runtimeHandle(), ctx, process.env);
    expect(await attached.status()).toBe("running");
    expect(Buffer.from(await attached.readFileBytes("acceptance/binary.bin"))).toEqual(bytes);
  } finally {
    await sandbox.destroy();
  }
}, 180_000);
