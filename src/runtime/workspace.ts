import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Resolve `input` to an absolute path guaranteed to live inside `workspaceRoot`.
 *
 * Uses realpath to defeat symlink escapes. For paths that don't yet exist
 * (common for writes), walks up to the nearest existing ancestor and realpaths
 * that, then re-appends the missing tail — so creating a new file in an
 * existing directory works, but a symlinked ancestor still gets resolved.
 *
 * Throws if the resolved path falls outside `workspaceRoot`.
 */
export async function resolveWithinWorkspace(
  workspaceRoot: string,
  input: string,
): Promise<string> {
  const root = await realpath(workspaceRoot);
  const abs = isAbsolute(input) ? input : resolve(root, input);
  const resolved = await realpathOrParent(abs);
  const rel = relative(root, resolved);
  if (rel === "" ) return resolved;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${input}`);
  }
  return resolved;
}

async function realpathOrParent(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) throw new Error(`Cannot resolve path: ${abs}`);
    const parentReal = await realpathOrParent(parent);
    return join(parentReal, basename(abs));
  }
}
