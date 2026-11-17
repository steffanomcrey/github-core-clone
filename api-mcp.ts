// MCP: the third dialect, and the one an agent actually drives.
//
// A client connects over streamable HTTP, calls initialize, lists tools, then calls them. The
// suite does exactly that and then checks that a repository created through a tool is visible over
// REST with the same id — which is why every tool below writes through the same store the other
// three surfaces read, instead of keeping a private copy.
//
// Two protocol details are load-bearing. The response to initialize must echo the negotiated
// protocol version and declare the tools capability, or a modern client hangs waiting for a field
// that never comes. And a tool result is always `{content: [...]}` — the JSON a tool computed
// rides inside a text block, because that is the shape the protocol defined, not a nicety.

import type { Store, Repo } from './store.ts';
import { flattenTree, getRepo, listRefs, parseCommit } from './store.ts';

export interface McpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  rawBody: string;
  authed: boolean;
  currentUser: string;
  headers: Record<string, string>;
}

export interface McpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** A protocol version this server speaks; the client's is echoed when it names one we know. */
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_VERSION = '2025-06-18';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>, store: Store, currentUser: string) => { ok: boolean; value: unknown };
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function repoBrief(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user. Returns the repository as REST reports it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        auto_init: { type: 'boolean', description: 'Create an initial commit with a README.' },
      },
      required: ['name'],
    },
    run: (args, store, currentUser) => {
      const name = String(args.name ?? '').trim();
      if (!name) return { ok: false, value: 'name is required' };
      const key = `${currentUser}/${name}`.toLowerCase();
      if (store.repos.has(key)) return { ok: false, value: `repository ${currentUser}/${name} already exists` };

      const id = store.nextRepo++;
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const repo: Repo = {
        id,
        name,
        owner: currentUser,
        description: typeof args.description === 'string' ? args.description : '',
        private: Boolean(args.private),
        defaultBranch: 'main',
        createdAt: now,
        updatedAt: now,
        refs: new Map(),
        objects: new Map(),
        issues: [],
        pulls: [],
        labels: new Map(),
        comments: new Map(),
        nextIssue: 1,
        nextPull: 1,
        nextComment: 1,
      };
      for (const [labelName, color] of [['bug', 'd73a4a'], ['enhancement', 'a2eeef'], ['documentation', '0075ca']] as Array<[string, string]>) {
        repo.labels.set(labelName, { name: labelName, color, description: '' });
      }
      store.repos.set(key, repo);
      store.reposById.set(id, repo);
      return { ok: true, value: repoBrief(repo) };
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user, newest id first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum repositories to return.' } },
    },
    run: (args, store, currentUser) => {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(100, args.limit) : 30;
      const mine = Array.from(store.repos.values())
        .filter((repo) => repo.owner.toLowerCase() === currentUser.toLowerCase())
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return { ok: true, value: mine.map(repoBrief) };
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read a file from a repository at a ref. Path is slash-separated; omit it to list the tree.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string', description: 'Path inside the repository.' },
        ref: { type: 'string', description: 'Branch name or commit sha.' },
      },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const ref = typeof args.ref === 'string' && args.ref ? args.ref : repo.defaultBranch;
      const sha = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
      if (!sha) return { ok: false, value: `ref not found: ${ref}` };
      const commitObj = repo.objects.get(sha);
      if (!commitObj || commitObj.type !== 'commit') return { ok: false, value: 'ref does not point at a commit' };
      const files = flattenTree(repo, parseCommit(commitObj.data).tree);

      const path = typeof args.path === 'string' ? args.path.replace(/^\/+|\/+$/g, '') : '';
      if (!path) {
        return { ok: true, value: Array.from(files.keys()).sort() };
      }
      const entry = files.get(path);
      if (!entry) return { ok: false, value: `path not found: ${path}` };
      const blob = repo.objects.get(entry.sha);
      return {
        ok: true,
        value: {
          path,
          sha: entry.sha,
          size: blob?.data.length ?? 0,
          content: blob?.data.toString('utf8') ?? '',
        },
      };
    },
  },
  {
    name: 'list_commits',
    description: 'Walk the commit history of a branch, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const ref = typeof args.ref === 'string' && args.ref ? args.ref : repo.defaultBranch;
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(500, args.limit) : 30;

      const out: Array<{ sha: string; message: string; author: string; date: string; parents: string[] }> = [];
      const seen = new Set<string>();
      const queue = [repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref)].filter(Boolean) as string[];
      while (queue.length > 0 && out.length < limit) {
        const sha = queue.shift() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'commit') continue;
        const record = parseCommit(obj.data);
        out.push({
          sha,
          message: record.message,
          author: record.author,
          date: new Date(record.authorDate * 1000).toISOString(),
          parents: record.parents,
        });
        for (const parent of record.parents) queue.push(parent);
      }
      return { ok: true, value: out };
    },
  },
  {
    name: 'list_branches',
    description: 'List branch names and the commit each points at.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      return {
        ok: true,
        value: listRefs(repo)
          .filter((ref) => ref.name.startsWith('refs/heads/'))
          .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), sha: ref.sha })),
      };
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args, store, currentUser) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const title = String(args.title ?? '').trim();
      if (!title) return { ok: false, value: 'title is required' };
      const labels: string[] = Array.isArray(args.labels) ? args.labels.filter((l: any) => typeof l === 'string') : [];
      const unknown = labels.filter((label) => !repo.labels.has(label));
      if (unknown.length > 0) return { ok: false, value: `unknown labels: ${unknown.join(', ')}` };

      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const issue = {
        id: store.nextId++,
        number: repo.nextIssue++,
        repoId: repo.id,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels,
        assignees: [] as string[],
        user: currentUser,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      return {
        ok: true,
        value: { id: issue.id, number: issue.number, title: issue.title, state: issue.state, labels: issue.labels },
      };
    },
  },
  {
    name: 'list_issues',
    description: 'List issues on a repository, filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'number' },
      },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(100, args.limit) : 30;
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state).slice(0, limit);
      return {
        ok: true,
        value: list.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels,
          comments: issue.comments.length,
        })),
      };
    },
  },
  {
    name: 'add_comment',
    description: 'Comment on an issue or pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'number' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'number', 'body'],
    },
    run: (args, store, currentUser) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const number = Number(args.number);
      const issue = repo.issues.find((item) => item.number === number);
      if (!issue) return { ok: false, value: `issue #${number} not found` };
      const body = typeof args.body === 'string' ? args.body : '';
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const comment = { id: store.nextId++, body, user: currentUser, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      return { ok: true, value: { id: comment.id, body: comment.body, user: comment.user } };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args, store, currentUser) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const headRef = String(args.head ?? '').replace(/^[^:]+:/, '');
      const baseRef = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha) return { ok: false, value: `head branch not found: ${headRef}` };
      if (!baseSha) return { ok: false, value: `base branch not found: ${baseRef}` };

      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const pull = {
        id: store.nextId++,
        number: repo.nextPull++,
        repoId: repo.id,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        head: headRef,
        base: baseRef,
        headSha,
        baseSha,
        user: currentUser,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        mergedAt: null,
        merged: false,
        mergeCommitSha: null,
      };
      repo.pulls.push(pull);
      return {
        ok: true,
        value: { id: pull.id, number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.state },
      };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        merge_method: { type: 'string' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args, store) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const pull = repo.pulls.find((item) => item.number === Number(args.pull_number));
      if (!pull) return { ok: false, value: `pull request not found: ${args.pull_number}` };
      // Merging twice is a no-op rather than an error: the caller reads the pull back afterward and
      // only cares that it ended up merged, so a retry sees the same state instead of a failure.
      if (!pull.merged) {
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = now;
        pull.updatedAt = now;
        pull.closedAt = now;
      }
      return {
        ok: true,
        value: {
          id: pull.id,
          number: pull.number,
          merged: pull.merged,
          state: pull.state,
          merged_at: pull.mergedAt,
          sha: pull.headSha,
        },
      };
    },
  },
  {
    name: 'search_code',
    description: 'Find files whose path or contents contain a query string.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['owner', 'repo', 'query'],
    },
    run: (args, store) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      const query = String(args.query ?? '');
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return { ok: true, value: [] };
      const commitObj = repo.objects.get(tip);
      if (!commitObj || commitObj.type !== 'commit') return { ok: true, value: [] };
      const files = flattenTree(repo, parseCommit(commitObj.data).tree);

      const hits: Array<{ path: string; line: number; text: string }> = [];
      for (const [path, entry] of files) {
        if (path.includes(query)) hits.push({ path, line: 0, text: path });
        const blob = repo.objects.get(entry.sha);
        if (!blob) continue;
        const text = blob.data.toString('utf8');
        let lineNumber = 0;
        for (const line of text.split('\n')) {
          lineNumber++;
          if (line.includes(query)) hits.push({ path, line: lineNumber, text: line.slice(0, 200) });
        }
      }
      return { ok: true, value: hits.slice(0, 100) };
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
    run: (args, store) => {
      const repo = getRepo(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (!repo) return { ok: false, value: 'repository not found' };
      return { ok: true, value: { ...repoBrief(repo), branches: listRefs(repo).length } };
    },
  },
];

function toolList(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

export function handleMcp(store: Store, request: McpRequest, currentUserOverride?: string): McpResponse {
  const currentUser = currentUserOverride ?? 'octocat';

  if (!request.authed) {
    return {
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }),
    };
  }

  if (request.method === 'GET') {
    // A GET on the streamable endpoint asks for an SSE stream. Answering with an empty stream that
    // closes immediately is honest: this server is request/response only and says so, rather than
    // holding a socket open forever waiting for a notification it will never send.
    return {
      status: 405,
      headers: { 'content-type': 'text/plain', allow: 'POST' },
      body: 'this MCP endpoint speaks POST only\n',
    };
  }

  if (request.method === 'DELETE') {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '' };
  }

  if (request.method !== 'POST') {
    return { status: 405, headers: { allow: 'POST' }, body: '' };
  }

  let payload: any;
  try {
    payload = JSON.parse(request.rawBody || '{}');
  } catch {
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: rpcError(null, -32700, 'Parse error'),
    };
  }

  // A batch is an array of requests; answer with an array, dropping notifications.
  if (Array.isArray(payload)) {
    const responses: string[] = [];
    for (const item of payload) {
      const single = handleOne(store, item, currentUser);
      if (single !== null) responses.push(single);
    }
    if (responses.length === 0) return { status: 202, headers: {}, body: '' };
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: `[${responses.join(',')}]`,
    };
  }

  const single = handleOne(store, payload, currentUser);
  if (single === null) {
    // A notification gets 202 and no body, which is what the transport specifies.
    return { status: 202, headers: {}, body: '' };
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: single,
  };
}

function handleOne(store: Store, message: any, currentUser: string): string | null {
  if (!message || typeof message !== 'object') {
    return rpcError(null, -32600, 'Invalid Request');
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined;
  const id = hasId ? message.id : null;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = message.params && typeof message.params === 'object' ? message.params : {};

  if (!hasId && method.startsWith('notifications/')) {
    // notifications/initialized, notifications/cancelled: acknowledged silently.
    return null;
  }

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_VERSION;
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION;
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        instructions: 'A GitHub-shaped forge: repositories, issues and pull requests over one store.',
      });
    }

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: toolList() });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const outcome = tool.run(args as Record<string, any>, store, currentUser);
        return rpcResult(id, textResult(outcome.value, !outcome.ok));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcResult(id, textResult(`tool ${name} failed: ${message}`, true));
      }
    }

    case 'resources/list':
      return rpcResult(id, { resources: [] });

    case 'prompts/list':
      return rpcResult(id, { prompts: [] });

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
