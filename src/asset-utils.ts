import * as crypto from "crypto";
import * as fs from "fs";

import { walk } from "@nodesecure/fs-walk";

export function stringHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function fileHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(path);
    rs.on("error", reject);
    rs.on("data", chunk => hash.update(chunk));
    rs.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function directoryHash(path: string): Promise<string> {
  const hashes: string[] = [];
  for await (const [dirent, absoluteFileLocation] of walk(path)) {
    if (dirent.isFile()) {
      hashes.push(await fileHash(absoluteFileLocation));
    }
  }
  return stringHash(hashes.sort().join(""));
}
