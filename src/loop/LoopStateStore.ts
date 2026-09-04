import * as fs from "node:fs";
import * as path from "node:path";
import { LoopError } from "../errors.js";
import type { LoopState } from "../engine.js";

export class FileLock {
  private lockPath: string;
  private fd: number | null = null;

  constructor(filePath: string) {
    this.lockPath = filePath + ".lock";
  }

  acquire(): void {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      this.fd = fs.openSync(this.lockPath, "wx");
    } catch (err: unknown) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") {
        throw new LoopError(
          "STATE_CONFLICT",
          "state",
          `Active run locked by another process: ${this.lockPath}`
        );
      }
      throw err;
    }
  }

  release(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
        fs.unlinkSync(this.lockPath);
      } catch {
        // Ignore cleanup errors
      }
      this.fd = null;
    }
  }
}

export interface LoopStateStore {
  read(): Promise<LoopState>;
  update(
    mutate: (current: LoopState) => LoopState | Promise<LoopState>
  ): Promise<LoopState>;
}

export class JsonFileLoopStateStore implements LoopStateStore {
  readonly stateFilePath: string;

  constructor(stateFilePath: string) {
    const resolved = path.resolve(stateFilePath);
    const evalDir = path.resolve(".eval");
    if (resolved === evalDir || resolved.startsWith(evalDir + path.sep)) {
      throw new LoopError(
        "CONFIG_INVALID",
        "configuration",
        "Security invariant violation: State file cannot be located in .eval/"
      );
    }
    this.stateFilePath = resolved;
  }

  async read(): Promise<LoopState> {
    if (!fs.existsSync(this.stateFilePath)) {
      throw new LoopError(
        "STATE_INVALID",
        "state",
        `No state file found at: ${this.stateFilePath}`
      );
    }
    try {
      const content = fs.readFileSync(this.stateFilePath, "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1) {
        throw new LoopError(
          "STATE_INVALID",
          "state",
          `Invalid state file schema at ${this.stateFilePath}`
        );
      }
      return parsed as LoopState;
    } catch (err: unknown) {
      if (err instanceof LoopError) {
        throw err;
      }
      throw new LoopError(
        "STATE_INVALID",
        "state",
        `Failed to parse state file at ${this.stateFilePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async update(
    mutate: (current: LoopState) => LoopState | Promise<LoopState>
  ): Promise<LoopState> {
    const lock = new FileLock(this.stateFilePath);
    lock.acquire();
    try {
      const current = await this.read();
      const updated = await mutate(current);

      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const tmpFile = `${this.stateFilePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      const serialized = JSON.stringify(updated, null, 2) + "\n";
      fs.writeFileSync(tmpFile, serialized, "utf-8");

      try {
        fs.renameSync(tmpFile, this.stateFilePath);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          ((err as { code?: string }).code === "EPERM" ||
            (err as { code?: string }).code === "EBUSY")
        ) {
          fs.copyFileSync(tmpFile, this.stateFilePath);
          try {
            fs.unlinkSync(tmpFile);
          } catch {}
        } else {
          throw err;
        }
      }

      return updated;
    } finally {
      lock.release();
    }
  }
}
