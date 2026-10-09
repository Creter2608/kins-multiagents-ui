/**
 * src/main/sandbox/workspace-paths.ts
 * Bidirectional path translation between host workspace and container sandbox.
 * Enforces strict root confinement and rejects directory traversal or sibling-prefix escapes.
 */

import path from 'node:path';

export interface WorkspacePaths {
  readonly hostRoot: string;
  readonly containerRoot: '/workspace';
}

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * Normalizes and checks if candidate is strictly inside or equal to root.
 * Guarantees that sibling prefixes like "workspace-ui-other" and drive mismatches are rejected.
 */
function isContained(candidate: string, root: string): boolean {
  const p = isWindowsPath(root) ? path.win32 : path;
  const normCandidate = p.normalize(p.resolve(candidate));
  const normRoot = p.normalize(p.resolve(root));

  // Check root drive / prefix match
  if (p.parse(normCandidate).root.toLowerCase() !== p.parse(normRoot).root.toLowerCase()) {
    return false;
  }

  const relative = p.relative(normRoot, normCandidate);
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}

/**
 * Translates a host absolute/relative path into a container '/workspace/...' path.
 * Throws if the path escapes the host root, attempts traversal, or uses ambiguous UNC/device paths.
 */
export function toContainerPath(hostPath: string, paths: WorkspacePaths): string {
  if (!hostPath || typeof hostPath !== 'string') {
    throw new Error('Invalid hostPath: must be a non-empty string.');
  }

  // Reject UNC and device paths
  if (hostPath.startsWith('\\\\') || hostPath.startsWith('//')) {
    throw new Error(`Ambiguous UNC or device path rejected: '${hostPath}'.`);
  }

  const p = isWindowsPath(paths.hostRoot) ? path.win32 : path;
  const normHostPath = p.normalize(p.resolve(hostPath));
  const normHostRoot = p.normalize(p.resolve(paths.hostRoot));

  if (!isContained(normHostPath, normHostRoot)) {
    throw new Error(`Path escape rejected: '${hostPath}' is outside host root '${paths.hostRoot}'.`);
  }

  const rel = p.relative(normHostRoot, normHostPath);
  if (rel === '') {
    return paths.containerRoot;
  }

  // Convert Windows backslashes to Posix forward slashes
  const posixRel = rel.split(/[\\/]+/).join('/');
  return `${paths.containerRoot}/${posixRel}`;
}

/**
 * Translates a container '/workspace/...' path into a host absolute path.
 * Throws if the path is outside '/workspace' or attempts directory traversal.
 */
export function toHostPath(containerPath: string, paths: WorkspacePaths): string {
  if (!containerPath || typeof containerPath !== 'string') {
    throw new Error('Invalid containerPath: must be a non-empty string.');
  }

  const prefix = paths.containerRoot;
  if (containerPath !== prefix && !containerPath.startsWith(`${prefix}/`)) {
    throw new Error(`Path escape rejected: '${containerPath}' is outside container root '${prefix}'.`);
  }

  const rel = containerPath.slice(prefix.length).replace(/^\/+/, '');
  const normalizedRel = path.posix.normalize(rel);
  if (normalizedRel.startsWith('..') || path.posix.isAbsolute(normalizedRel)) {
    throw new Error(`Path traversal rejected: '${containerPath}'.`);
  }

  const p = isWindowsPath(paths.hostRoot) ? path.win32 : path;
  const hostSegments = normalizedRel ? normalizedRel.split('/') : [];
  return p.resolve(paths.hostRoot, ...hostSegments);
}
