import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { walk, walkSync } from "@nodesecure/fs-walk";
import * as pulumi from "@pulumi/pulumi";

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

export interface RoleFile extends fs.Dirent {
  absoluteFileLocation: string;
}

export function gatherRolesFilesSync(rolePaths: string[]): Record<string, RoleFile> {
  const result: Record<string, RoleFile> = {};
  for (const rolePath of rolePaths) {
    const absoluteRolePath = path.normalize(rolePath);
    for (const [dirent, absoluteFileLocation] of walkSync(rolePath)) {
      if (!dirent.isFile() && !dirent.isSymbolicLink()) {
        continue;
      }
      const key = absoluteFileLocation.replace(path.dirname(absoluteRolePath) + "/", "");
      const roleFile: Partial<RoleFile> = dirent;
      roleFile.absoluteFileLocation = absoluteFileLocation;
      result[key] = roleFile as RoleFile;
    }
  }
  return result;
}

export async function gatherRolesFiles(rolePaths: string[]): Promise<Record<string, RoleFile>> {
  const result: Record<string, RoleFile> = {};
  for (const rolePath of rolePaths) {
    const absoluteRolePath = path.normalize(rolePath);
    for await (const [dirent, absoluteFileLocation] of walk(rolePath)) {
      if (!dirent.isFile() && !dirent.isSymbolicLink()) {
        continue;
      }
      const key = absoluteFileLocation.replace(path.dirname(absoluteRolePath) + "/", "");
      const roleFile: Partial<RoleFile> = dirent;
      roleFile.absoluteFileLocation = absoluteFileLocation;
      result[key] = roleFile as RoleFile;
    }
  }
  return result;
}

export function concatCommands(commands: (pulumi.Input<string> | undefined)[]): pulumi.Output<string> {
  return pulumi.all(commands).apply((commands) => {
    let result = "";
    for (const command of commands) {
      if (command === undefined) {
        continue;
      }
      result += command;
      if (!command.endsWith("\n")) {
        result += "\n";
      }
    }
    return result;
  });
}
