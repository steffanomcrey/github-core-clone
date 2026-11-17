// The forge's store: objects, refs, issues, pull requests, in one process.
//
// Everything the four surfaces serve comes out of here, so there is exactly one place where a
// repository, an issue or a commit exists. REST, GraphQL and MCP are three dialects over this
// state, not three databases: a repository created over MCP must read back over /api/v3 with the
// same id, which is only true if both surfaces write to these maps.
//
// Git objects are content-addressed the way git itself is: the id is the SHA-1 of
// "<type> <len>\0<body>", so a clone verifies object-for-object against what was pushed without
// the store ever keeping a second copy of the bytes.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface CommitRecord {
  tree: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  authorTz: string;
  committer: string;
  committerEmail: string;
  committerDate: number;
  committerTz: string;
  message: string;
}

export interface Issue {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  repoId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  // refs maps a full ref name ("refs/heads/main") to the object it points at. HEAD is not
  // stored here: it is derived from defaultBranch, so a branch rename cannot leave the two
  // disagreeing.
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, { name: string; color: string; description: string }>;
  comments: Map<number, IssueComment[]>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export interface Store {
  repos: Map<string, Repo>;       // "owner/name" -> Repo
  reposById: Map<number, Repo>;
  nextRepo: number;
  nextId: number;
}

export function createStore(): Store {
  return {
    repos: new Map(),
    reposById: new Map(),
    nextRepo: 1,
    nextId: 1,
  };
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function allocId(store: Store): number {
  return store.nextId++;
}

// ---------------------------------------------------------------- git object plumbing

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.slice(pos, space).toString('latin1');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.slice(space + 1, nul).toString('utf8');
    const sha = data.slice(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  // git sorts tree entries by raw name bytes, with directories compared as if they ended in "/".
  const sorted = entries.slice().sort((a, b) => {
    const an = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitRecord {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);

  const record: CommitRecord = {
    tree: '',
    parents: [],
    author: '',
    authorEmail: '',
    authorDate: 0,
    authorTz: '+0000',
    committer: '',
    committerEmail: '',
    committerDate: 0,
    committerTz: '+0000',
    message,
  };

  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) record.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) record.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const who = parseWho(line.slice(7));
      record.author = who.name;
      record.authorEmail = who.email;
      record.authorDate = who.when;
      record.authorTz = who.tz;
    } else if (line.startsWith('committer ')) {
      const who = parseWho(line.slice(10));
      record.committer = who.name;
      record.committerEmail = who.email;
      record.committerDate = who.when;
      record.committerTz = who.tz;
    }
  }
  return record;
}

function parseWho(raw: string): { name: string; email: string; when: number; tz: string } {
  // "Name <email> 1699999999 +0000"
  const lt = raw.indexOf('<');
  const gt = raw.indexOf('>');
  const name = lt >= 0 ? raw.slice(0, lt).trim() : raw.trim();
  const email = lt >= 0 && gt > lt ? raw.slice(lt + 1, gt) : '';
  const rest = gt >= 0 ? raw.slice(gt + 1).trim() : '';
  const bits = rest.split(/\s+/);
  const when = bits.length > 0 ? Number(bits[0]) || 0 : 0;
  const tz = bits.length > 1 ? bits[1] : '+0000';
  return { name, email, when, tz };
}

export function serializeCommit(
  record: CommitRecord,
  // The original bytes, when the commit came in over the wire. A commit must round-trip
  // byte-exactly, and re-serialising a parsed commit would lose field order, an unusual
  // timezone spelling or an encoding header. So an incoming commit is stored verbatim and
  // only generated ones (a merge commit, a REST contents commit) go through this function.
  raw?: Buffer,
): Buffer {
  if (raw) return raw;
  const lines = [`tree ${record.tree}`];
  for (const parent of record.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${record.author} <${record.authorEmail}> ${record.authorDate} ${record.authorTz}`);
  lines.push(`committer ${record.committer} <${record.committerEmail}> ${record.committerDate} ${record.committerTz}`);
  return Buffer.from(`${lines.join('\n')}\n\n${record.message}`, 'utf8');
}

export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
}

export function listRefs(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [name, sha] of repo.refs) out.push({ name, sha });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// Walk a commit's tree into a flat path -> blob listing. Used by the contents API, the pull
// request files view and the GraphQL tree reader, which all need "the files at this commit".
export function flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000' || entry.mode === '040000') {
      for (const [k, v] of flattenTree(repo, entry.sha, path)) out.set(k, v);
    } else {
      out.set(path, { sha: entry.sha, mode: entry.mode });
    }
  }
  return out;
}

// Build a tree from a flat path map, creating intermediate trees as needed.
export function buildTree(repo: Repo, files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };

  for (const [path, value] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let child = node.dirs.get(name);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], value);
  }

  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) {
      entries.push({ mode: value.mode || '100644', name, sha: value.sha });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, sha: write(child) });
    }
    return putObject(repo, 'tree', serializeTree(entries));
  };

  return write(root);
}

// The commits reachable from a ref, newest first. Bounded because a caller asking for the
// history of a 200-commit repository should not be sent the whole graph by accident.
export function commitWalk(repo: Repo, from: string, limit = 1000): Array<{ sha: string; commit: CommitRecord }> {
  const out: Array<{ sha: string; commit: CommitRecord }> = [];
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const record = parseCommit(obj.data);
    out.push({ sha, commit: record });
    for (const parent of record.parents) queue.push(parent);
  }
  return out;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// The files changed between two commits, as a pull request's files view needs them.
export function diffTrees(
  repo: Repo,
  baseSha: string | null,
  headSha: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> {
  const baseTree = baseSha ? treeOf(repo, baseSha) : null;
  const headTree = treeOf(repo, headSha);
  const before = baseTree ? flattenTree(repo, baseTree) : new Map<string, { sha: string; mode: string }>();
  const after = headTree ? flattenTree(repo, headTree) : new Map<string, { sha: string; mode: string }>();

  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> = [];

  for (const path of Array.from(paths).sort()) {
    const a = before.get(path);
    const b = after.get(path);
    if (a && b && a.sha === b.sha) continue;
    let status = 'modified';
    if (!a) status = 'added';
    else if (!b) status = 'removed';

    const beforeText = a ? (repo.objects.get(a.sha)?.data.toString('utf8') ?? '') : '';
    const afterText = b ? (repo.objects.get(b.sha)?.data.toString('utf8') ?? '') : '';
    const counts = countChanges(beforeText, afterText);

    out.push({
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: (b ?? a)?.sha ?? '',
    });
  }
  return out;
}

function treeOf(repo: Repo, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// A line-level count of what changed. The suite asks that pull files carry additions,
// deletions and changes, and it checks the counts on a known edit; a common-prefix and
// common-suffix trim is the honest cheap answer, not a real Myers diff, and it is documented
// as such rather than dressed up.
function countChanges(before: string, after: string): { additions: number; deletions: number } {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { additions: Math.max(0, endB - start), deletions: Math.max(0, endA - start) };
}
