import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return (caught as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const acquireProcessLock = (name: string) => {
  const lockPath = join(tmpdir(), `${name}.lock`);

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          closeSync(fd);
          unlinkSync(lockPath);
        },
      };
    } catch (caught) {
      const error = caught as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") throw caught;

      const existingPid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isFinite(existingPid) && processExists(existingPid)) {
        throw new Error(`rotation worker already running as pid ${existingPid}`);
      }
      unlinkSync(lockPath);
    }
  }
};
