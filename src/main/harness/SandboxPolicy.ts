/**
 * src/main/harness/SandboxPolicy.ts
 * Preflight authorization and filesystem confinement policy based on DeepSeek Harness 3-tier model.
 * Enforces strict protected root defense (.eval immutable invariant) and symlink confinement.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { SandboxPolicyConfig, PolicyDecision } from '../../shared/harnessContracts.js';

/**
 * Resolves the real canonical path of a target, resolving any symlinks.
 * If the file does not exist yet, resolves the nearest existing ancestor.
 */
function resolveCanonicalPath(targetPath: string): string {
  const absolutePath = path.resolve(targetPath);
  if (fs.existsSync(absolutePath)) {
    try {
      return fs.realpathSync(absolutePath);
    } catch {
      return absolutePath;
    }
  }

  // Walk up to find nearest existing directory
  let current = path.dirname(absolutePath);
  const segments: string[] = [path.basename(absolutePath)];

  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      try {
        const realAncestor = fs.realpathSync(current);
        return path.resolve(realAncestor, ...segments);
      } catch {
        return absolutePath;
      }
    }
    segments.unshift(path.basename(current));
    current = path.dirname(current);
  }

  return absolutePath;
}

/**
 * Checks whether candidatePath is equal to or inside rootPath.
 */
function isPathInside(candidatePath: string, rootPath: string): boolean {
  const rel = path.relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class SandboxPolicy {
  readonly config: SandboxPolicyConfig;
  private readonly normalizedTargetRoot: string;
  private readonly canonicalTargetRoot: string;
  private readonly normalizedReadableRoots: readonly string[];
  private readonly canonicalReadableRoots: readonly string[];
  private readonly normalizedWritableRoots: readonly string[];
  private readonly canonicalWritableRoots: readonly string[];
  private readonly normalizedProtectedRoots: readonly string[];
  private readonly canonicalProtectedRoots: readonly string[];

  constructor(config: SandboxPolicyConfig) {
    this.config = config;
    this.normalizedTargetRoot = path.resolve(config.targetRoot);
    this.canonicalTargetRoot = resolveCanonicalPath(this.normalizedTargetRoot);

    this.normalizedReadableRoots = config.readableRoots.map((r) => path.resolve(r));
    this.canonicalReadableRoots = this.normalizedReadableRoots.map((r) => resolveCanonicalPath(r));

    this.normalizedWritableRoots = config.writableRoots.map((r) => path.resolve(r));
    this.canonicalWritableRoots = this.normalizedWritableRoots.map((r) => resolveCanonicalPath(r));

    // POLICY-01: targetRoot/.eval is ALWAYS an immutable protected root, regardless of config
    const mandatoryEvalRoot = path.resolve(this.normalizedTargetRoot, '.eval');
    const configuredRoots = config.protectedRoots.map((r) => path.resolve(r));
    const allProtectedRoots = Array.from(new Set([mandatoryEvalRoot, ...configuredRoots]));

    this.normalizedProtectedRoots = allProtectedRoots;
    // POLICY-02: Also resolve canonical destinations of protected roots
    this.canonicalProtectedRoots = allProtectedRoots.map((r) => resolveCanonicalPath(r));
  }

  authorizePath(requestedPath: string, operation: 'read' | 'write'): PolicyDecision {
    if (!requestedPath || typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
      return {
        allowed: false,
        reasonCode: 'INVALID_PATH'
      };
    }

    const resolved = path.resolve(requestedPath);
    const canonical = resolveCanonicalPath(requestedPath);

    // 1. Invariant: Protected roots cannot be written to in any mode (including symlink aliases & destinations)
    if (operation === 'write') {
      const isProtected =
        this.normalizedProtectedRoots.some((p) => isPathInside(resolved, p) || isPathInside(canonical, p)) ||
        this.canonicalProtectedRoots.some((p) => isPathInside(resolved, p) || isPathInside(canonical, p));

      if (isProtected) {
        return {
          allowed: false,
          reasonCode: 'PROTECTED_ROOT_VIOLATION',
          resolvedPath: resolved
        };
      }
    }

    // 2. Mode-specific evaluation
    switch (this.config.mode) {
      case 'read-only': {
        if (operation === 'write') {
          return {
            allowed: false,
            reasonCode: 'READ_ONLY_MODE',
            resolvedPath: resolved
          };
        }

        // POLICY-03: Both lexical path and its canonical destination must belong to permitted read roots
        const allowedLexical =
          isPathInside(resolved, this.normalizedTargetRoot) ||
          this.normalizedReadableRoots.some((r) => isPathInside(resolved, r)) ||
          this.normalizedWritableRoots.some((r) => isPathInside(resolved, r));

        const allowedCanonical =
          isPathInside(canonical, this.canonicalTargetRoot) ||
          this.canonicalReadableRoots.some((r) => isPathInside(canonical, r)) ||
          this.canonicalWritableRoots.some((r) => isPathInside(canonical, r));

        if (!allowedLexical || !allowedCanonical) {
          return {
            allowed: false,
            reasonCode: 'OUTSIDE_READ_ROOTS',
            resolvedPath: resolved
          };
        }
        return { allowed: true, resolvedPath: resolved };
      }

      case 'workspace-write': {
        if (operation === 'read') {
          // Permitted read checks also apply
          const allowedLexical =
            isPathInside(resolved, this.normalizedTargetRoot) ||
            this.normalizedReadableRoots.some((r) => isPathInside(resolved, r)) ||
            this.normalizedWritableRoots.some((r) => isPathInside(resolved, r));

          const allowedCanonical =
            isPathInside(canonical, this.canonicalTargetRoot) ||
            this.canonicalReadableRoots.some((r) => isPathInside(canonical, r)) ||
            this.canonicalWritableRoots.some((r) => isPathInside(canonical, r));

          if (!allowedLexical || !allowedCanonical) {
            return {
              allowed: false,
              reasonCode: 'OUTSIDE_READ_ROOTS',
              resolvedPath: resolved
            };
          }
          return { allowed: true, resolvedPath: resolved };
        }

        // Write operation: both resolved and canonical must be within writableRoots / targetRoot
        const isAllowedWrite =
          (isPathInside(resolved, this.normalizedTargetRoot) && isPathInside(canonical, this.canonicalTargetRoot)) ||
          this.normalizedWritableRoots.some((r) => isPathInside(resolved, r)) &&
          this.canonicalWritableRoots.some((r) => isPathInside(canonical, r));

        if (!isAllowedWrite) {
          return {
            allowed: false,
            reasonCode: 'OUTSIDE_WORKSPACE_WRITE',
            resolvedPath: resolved
          };
        }
        return { allowed: true, resolvedPath: resolved };
      }

      case 'danger-full-access': {
        // Protected roots are still strictly blocked (checked in block 1), other paths permitted
        return { allowed: true, resolvedPath: resolved };
      }

      default: {
        return {
          allowed: false,
          reasonCode: 'UNKNOWN_SANDBOX_MODE'
        };
      }
    }
  }
}

export function authorizePath(
  policy: SandboxPolicyConfig,
  requestedPath: string,
  operation: 'read' | 'write'
): PolicyDecision {
  const instance = new SandboxPolicy(policy);
  return instance.authorizePath(requestedPath, operation);
}
