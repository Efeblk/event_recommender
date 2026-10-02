import { createHash } from "node:crypto";

export function identityHash(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(`${namespace}\u001f${JSON.stringify(value)}`)
    .digest("hex");
}
