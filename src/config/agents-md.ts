import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const FILENAMES = ["AGENTS.md", "CLAUDE.md"];

/**
 * Resolve the AGENTS.md file(s) relevant to `startDir`, walking up to `root`.
 *
 * The convention is to stitch all matching files from `root` down to `startDir`,
 * so more specific (deeper) instructions override/augment less specific ones.
 * Returns a single string with `### <relative-path>` headers between sections,
 * or `null` if no AGENTS.md is found anywhere in the chain.
 */
export async function loadAgentsMd(root: string, startDir?: string): Promise<string | null> {
  const absRoot = resolve(root);
  const absStart = resolve(startDir ?? root);
  const chain: string[] = [];

  let dir = absStart;
  while (true) {
    for (const name of FILENAMES) {
      const candidate = join(dir, name);
      try {
        await access(candidate);
        const body = await readFile(candidate, "utf8");
        const rel = relative(absRoot, candidate) || name;
        chain.push(`### ${rel}\n\n${body.trim()}`);
        break;
      } catch {
        // not here
      }
    }
    if (dir === absRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (!isWithin(absRoot, parent)) break;
    dir = parent;
  }

  if (chain.length === 0) return null;
  return chain.reverse().join("\n\n");
}

function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}
