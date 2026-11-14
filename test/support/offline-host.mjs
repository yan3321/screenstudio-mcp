import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Protocol fixtures exercise the real server, but never launch host processes.
for (const method of ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]) {
  childProcess[method] = () => {
    throw new Error(`Offline protocol fixture refuses child_process.${method}.`);
  };
}
syncBuiltinESMExports();
