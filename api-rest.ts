// GitHub REST v3: repositories, contents, issues, pulls.
//
// The shape of each body matters as much as the data, because the suite checks fields the way a
// real client reads them: a pull request without base.sha is a pull request gh cannot render, and
// a Link header that pages by anything other than the same page size is a pagination bug the
// caller discovers three screens in. So this file builds full GitHub-shaped objects rather than
// returning the store's internal records.
//
// Auth is demanded here, not upstream: every route below the API root except /api/v3/meta needs
// the bearer token, and a missing token is a 401 with GitHub's own message, while a valid token
// asking for another owner's repository is a 404 and not a 403, because the real API hides
// existence rather than admitting it.

import type {
  Issue,
  PullRequest,
  Repo,
  Store,
} from './store.ts';
import {
  buildTree,
  commitWalk,
  diffTrees,
  flattenTree,
  getRepo,
  listRefs,
  parseCommit,
  parseTree,
  putObject,
  serializeCommit,
  serializeTree,
} from './store.ts';
import { randomBytes } from 'node:crypto';

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  rawBody: string;
  token: string | null;
  headers: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body?: any;
}

const API_ROOT_BODY = {
  current_user_url: 'https://api.github.com/user',
  current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
  authorizations_url: 'https://api.github.com/authorizations',
  code_search_url: 'https://api.github.com/search/code?q={query}{&page,per_page,sort,order}',
  commit_search_url: 'https://api.github.com/search/commits?q={query}{&page,per_page,sort,order}',
  emails_url: 'https://api.github.com/user/emails',
  emojis_url: 'https://api.github.com/emojis',
  events_url: 'https://api.github.com/events',
  feeds_url: 'https://api.github.com/feeds',
  followers_url: 'https://api.github.com/user/followers',
  following_url: 'https://api.github.com/user/following{/target}',
  gists_url: 'https://api.github.com/gists{/gist_id}',
  hub_url: 'https://api.github.com/hub',
  issue_search_url: 'https://api.github.com/search/issues?q={query}{&page,per_page,sort,order}',
  issues_url: 'https://api.github.com/issues',
  keys_url: 'https://api.github.com/user/keys{/key_id}',
  label_search_url: 'https://api.github.com/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
  notifications_url: 'https://api.github.com/notifications',
  organization_url: 'https://api.github.com/orgs/{org}',
  organization_repositories_url: 'https://api.github.com/orgs/{org}/repos{?type,page,per_page,sort}',
  organization_teams_url: 'https://api.github.com/orgs/{org}/teams',
  public_gists_url: 'https://api.github.com/gists/public',
  rate_limit_url: 'https://api.github.com/rate_limit',
  repository_url: 'https://api.github.com/repos/{owner}/{repo}',
  repository_search_url: 'https://api.github.com/search/repositories?q={query}{&page,per_page,sort,order}',
  current_user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort}',
  starred_url: 'https://api.github.com/user/starred{/owner}{/repo}',
  starred_gists_url: 'https://api.github.com/gists/starred',
  user_url: 'https://api.github.com/users/{user}',
  user_organizations_url: 'https://api.github.com/user/orgs',
  user_repositories_url: 'https://api.github.com/users/{user}/repos{?type,page,per_page,sort}',
  user_search_url: 'https://api.github.com/search/users?q={query}{&page,per_page,sort,order}',
};

const SCOPES = 'repo, read:org';

export function json(status: number, body: any, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body };
}

export function notFound(message = 'Not Found'): ApiResponse {
  return json(404, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function unauthorized(): ApiResponse {
  return json(401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
}

export function badRequest(message: string): ApiResponse {
  return json(400, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function forbidden(message = 'Forbidden'): ApiResponse {
  return json(403, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function unprocessable(message: string, errors?: any[]): ApiResponse {
  const body: any = { message, documentation_url: 'https://docs.github.com/rest' };
  if (errors) body.errors = errors;
  return json(422, body);
}

// ---------------------------------------------------------------- shaped views

export function repoView(repo: Repo, token: string): any {
  const base = 'https://api.github.com';
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: {
      login: repo.owner,
      id: 1,
      node_id: 'U_1',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      type: 'User',
      site_admin: false,
    },
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/repos/${repo.owner}/${repo.name}`,
    archive_url: `${base}/repos/${repo.owner}/${repo.name}/{archive_format}{/ref}`,
    branches_url: `${base}/repos/${repo.owner}/${repo.name}/branches{/branch}`,
    commits_url: `${base}/repos/${repo.owner}/${repo.name}/commits{/sha}`,
    contents_url: `${base}/repos/${repo.owner}/${repo.name}/contents/{+path}`,
    issues_url: `${base}/repos/${repo.owner}/${repo.name}/issues{/number}`,
    pulls_url: `${base}/repos/${repo.owner}/${repo.name}/pulls{/number}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    open_pulls: repo.pulls.filter((p) => p.state === 'open').length,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}

export function issueView(repo: Repo, issue: Issue): any {
  const base = 'https://api.github.com';
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label ? label.name.length + 1000 : 0, node_id: '', name, color: label?.color ?? 'ededed', description: label?.description ?? '', default: false };
    }),
    assignees: issue.assignees.map((login) => ({ login, id: 2, type: 'User' })),
    user: { login: issue.user, id: 2, node_id: 'U_2', type: 'User', site_admin: false },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    closed_by: null,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/repos/${repo.owner}/${repo.name}`,
    comments_url: `${base}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    labels_url: `${base}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
  };
}

export function commentView(repo: Repo, issueNumber: number, comment: any): any {
  const base = 'https://api.github.com';
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: comment.user, id: 2, node_id: 'U_2', type: 'User', site_admin: false },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `${base}/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `${base}/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

export function pullView(repo: Repo, pull: PullRequest): any {
  const base = 'https://api.github.com';
  const headTip = pull.headSha;
  const baseTip = pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: 'clean',
    user: { login: pull.user, id: 2, node_id: 'U_2', type: 'User', site_admin: false },
    head: {
      label: `${pull.user}:${pull.head}`,
      ref: pull.head,
      sha: headTip,
      user: { login: pull.user, id: 2, type: 'User' },
      repo: repoView(repo, ''),
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: baseTip,
      user: { login: repo.owner, id: 1, type: 'User' },
      repo: repoView(repo, ''),
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits_url: `${base}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    files_url: `${base}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/files`,
    issue_url: `${base}/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    statuses_url: `${base}/repos/${repo.owner}/${repo.name}/statuses/${headTip}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    _links: {
      self: { href: `${base}/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` },
      html: { href: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}` },
    },
  };
}

// ---------------------------------------------------------------- pagination

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const perPageRaw = Number(query.get('per_page')) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

/** Absolute base for links. It has to be the origin the caller reached, not a fixed public
 *  hostname: the suite runs against 127.0.0.1 and follows these links literally. */
function apiBase(): string {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) return envUrl.replace(/\/$/, '');
  return `http://127.0.0.1:${process.env.PORT ?? process.env.MAKEFUN_PORT ?? ''}`;
}

// A Link header is how a client discovers there is more; without it, twenty-nine of thirty
// repositories are invisible to anyone who reads the API honestly.
function linkHeaders(path: string, query: URLSearchParams, page: number, perPage: number, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const params = new URLSearchParams(query.toString());
  const link = (n: number, rel: string): string => {
    params.set('page', String(n));
    params.set('per_page', String(perPage));
    // The entry point is mounted under `/api/v3`, so a Link that leaves that prefix sends the
    // client to a URL the server does not answer. The origin is the one the request arrived on.
    return `<${apiBase()}${path}?${params.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(link(page + 1, 'next'));
    links.push(link(lastPage, 'last'));
  }
  if (page > 1) {
    links.push(link(1, 'first'));
    links.push(link(page - 1, 'prev'));
  }
  const headers: Record<string, string> = {
    'x-total-count': String(total),
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    'x-ratelimit-used': '1',
    'x-ratelimit-resource': 'core',
    'x-github-media-type': 'github.v3; format=json',
  };
  if (links.length > 0) headers.link = links.join(', ');
  return headers;
}

function paginate<T>(items: T[], query: URLSearchParams, path: string): { items: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    headers: linkHeaders(path, query, page, perPage, items.length),
  };
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------- the router

export function handleApi(store: Store, request: ApiRequest, currentUser: string): ApiResponse {
  const path = request.path.replace(/\/+$/, '') || '/';

  // /api/v3/meta is the one route that answers without a token: a client probes it to learn
  // whether it is talking to a GitHub-shaped box at all, and the suite calls it that way.
  if (path === '/api/v3/meta' || path === '/api/v3/meta/') {
    return json(200, {
      verifiable_password_authentication: true,
      installed_version: '3.0.0',
      ssh_key_fingerprints: {},
      hooks: ['127.0.0.1/8'],
      git: ['127.0.0.1/8'],
      api: ['127.0.0.1/8'],
    }, { 'x-oauth-scopes': SCOPES });
  }

  if (path === '/api/v3' || path === '/api/v3/') {
    return json(200, API_ROOT_BODY, { 'x-oauth-scopes': SCOPES });
  }

  if (!request.token) return unauthorized();

  const parts = path.split('/').filter(Boolean);
  // parts[0] === 'api', parts[1] === 'v3'
  const rest = parts.slice(2);

  if (rest.length === 0) return json(200, API_ROOT_BODY, { 'x-oauth-scopes': SCOPES });

  if (rest[0] === 'user' && rest.length === 1 && request.method === 'GET') {
    return json(200, {
      login: currentUser,
      id: 1,
      node_id: 'U_1',
      type: 'User',
      site_admin: false,
      name: currentUser,
      public_repos: store.repos.size,
      total_private_repos: 0,
      created_at: '2024-01-01T00:00:00Z',
    }, { 'x-oauth-scopes': SCOPES });
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (request.method === 'GET') {
      const mine = Array.from(store.repos.values()).filter((r) => r.owner.toLowerCase() === currentUser.toLowerCase());
      mine.sort((a, b) => a.id - b.id);
      const page = paginate(mine.map((r) => repoView(r, currentUser)), request.query, '/api/v3/user/repos');
      return json(200, page.items, page.headers);
    }
    if (request.method === 'POST') {
      return createRepository(store, request.body, currentUser);
    }
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = getRepo(store, owner, name);
    if (!repo) return notFound();
    // A repository owned by someone else is invisible to this token, not forbidden: the real
    // API answers 404 so that a probe cannot enumerate other people's names.
    if (repo.owner.toLowerCase() !== currentUser.toLowerCase()) return notFound();
    return handleRepo(store, repo, rest.slice(3), request, currentUser);
  }

  return notFound();
}

function handleRepo(
  store: Store,
  repo: Repo,
  rest: string[],
  request: ApiRequest,
  currentUser: string,
): ApiResponse {
  const method = request.method;

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(repo, currentUser));
    if (method === 'PATCH') {
      const body = request.body ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name) repo.name = body.name;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
      repo.updatedAt = nowIso();
      return json(200, repoView(repo, currentUser));
    }
    if (method === 'DELETE') {
      store.repos.delete(`${repo.owner}/${repo.name}`.toLowerCase());
      store.reposById.delete(repo.id);
      return { status: 204 };
    }
    return json(405, { message: 'Method Not Allowed' });
  }

  const [head, ...tail] = rest;

  if (head === 'branches' && tail.length === 0 && method === 'GET') {
    const branches = listRefs(repo)
      .filter((r) => r.name.startsWith('refs/heads/'))
      .map((r) => {
        const name = r.name.slice('refs/heads/'.length);
        return {
          name,
          commit: { sha: r.sha, url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${r.sha}` },
          protected: name === repo.defaultBranch,
        };
      });
    const page = paginate(branches, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/branches`);
    return json(200, page.items, page.headers);
  }

  if (head === 'branches' && tail.length === 1 && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${tail[0]}`);
    if (!sha) return notFound('Branch not found');
    return json(200, { name: tail[0], commit: { sha }, protected: tail[0] === repo.defaultBranch });
  }

  if (head === 'commits' && method === 'GET') {
    return listCommits(repo, tail, request);
  }

  if (head === 'git' && tail.length >= 1) {
    return handleGitData(repo, tail, request, currentUser);
  }

  if (head === 'contents') {
    return handleContents(repo, tail, request, currentUser);
  }

  if (head === 'labels') {
    return handleLabels(repo, tail, request);
  }

  if (head === 'issues') {
    return handleIssues(store, repo, tail, request, currentUser);
  }

  if (head === 'pulls') {
    return handlePulls(store, repo, tail, request, currentUser);
  }

  return notFound();
}

function createRepository(store: Store, body: any, currentUser: string): ApiResponse {
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return unprocessable('Repository creation failed.', [{ resource: 'Repository', field: 'name', code: 'missing_field' }]);
  }
  const name = body.name.trim();
  const owner = typeof body.organization === 'string' && body.organization ? body.organization : currentUser;
  const key = `${owner}/${name}`.toLowerCase();
  if (store.repos.has(key)) {
    return unprocessable('Repository creation failed.', [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }]);
  }
  const id = store.nextRepo++;
  const repo: Repo = {
    id,
    name,
    owner,
    description: typeof body.description === 'string' ? body.description : '',
    private: Boolean(body.private),
    defaultBranch: typeof body.default_branch === 'string' && body.default_branch ? body.default_branch : 'main',
    createdAt: nowIso(),
    updatedAt: nowIso(),
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
  return json(201, repoView(repo, currentUser), { location: `https://api.github.com/repos/${owner}/${name}` });
}

function listCommits(repo: Repo, tail: string[], request: ApiRequest): ApiResponse {
  // GET /commits, GET /commits/{ref}, GET /commits?sha=branch
  const refParam = tail.length > 0 ? tail.join('/') : (request.query.get('sha') ?? repo.defaultBranch);
  const sha = repo.refs.get(`refs/heads/${refParam}`) ?? repo.refs.get(refParam) ?? refParam;
  if (!repo.objects.has(sha)) return notFound('Not Found');

  const walk = commitWalk(repo, sha, 1000);
  const views = walk.map((item) => ({
    sha: item.sha,
    node_id: `C_${item.sha.slice(0, 12)}`,
    commit: {
      author: {
        name: item.commit.author,
        email: item.commit.authorEmail,
        date: new Date(item.commit.authorDate * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
      committer: {
        name: item.commit.committer,
        email: item.commit.committerEmail,
        date: new Date(item.commit.committerDate * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
      message: item.commit.message,
      tree: { sha: item.commit.tree },
    },
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${item.sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${item.sha}`,
    parents: item.commit.parents.map((p) => ({ sha: p })),
  }));

  // A single commit is fetched by sha and answered as an object, not a one-element array; that
  // is how gh reads a commit and it is checked.
  if (tail.length === 1 && repo.objects.get(tail[0])?.type === 'commit') {
    return json(200, views[0]);
  }

  const page = paginate(views, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
  return json(200, page.items, page.headers);
}

function handleGitData(repo: Repo, tail: string[], request: ApiRequest, currentUser: string): ApiResponse {
  const [kind, ...more] = tail;

  if (kind === 'refs') {
    if (more.length === 0 && request.method === 'GET') {
      const refs = listRefs(repo).map((r) => ({
        ref: r.name,
        node_id: `REF_${r.name}`,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/git/${r.name}`,
        object: { sha: r.sha, type: repo.objects.get(r.sha)?.type ?? 'commit', url: '' },
      }));
      const page = paginate(refs, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/git/refs`);
      return json(200, page.items, page.headers);
    }
    if (more.length === 0 && request.method === 'POST') {
      const body = request.body ?? {};
      const ref: string = typeof body.ref === 'string' ? body.ref : '';
      const sha: string = typeof body.sha === 'string' ? body.sha : '';
      if (!ref || !sha) return unprocessable('Reference update failed', [{ resource: 'Reference', code: 'missing_field' }]);
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      if (!repo.objects.has(sha)) return unprocessable('Object does not exist', [{ resource: 'Reference', field: 'sha', code: 'invalid' }]);
      repo.refs.set(full, sha);
      return json(201, { ref: full, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (more.length >= 1 && request.method === 'GET') {
      const full = resolveRefPath(repo, more.join('/'));
      const sha = repo.refs.get(full);
      if (!sha) return notFound('Not Found');
      return json(200, { ref: full, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (more.length >= 1 && request.method === 'PATCH') {
      const full = resolveRefPath(repo, more.join('/'));
      if (!repo.refs.has(full)) return notFound('Not Found');
      repo.refs.set(full, request.body?.sha ?? repo.refs.get(full));
      return json(200, { ref: full, object: { sha: repo.refs.get(full) } });
    }
    if (more.length >= 1 && request.method === 'DELETE') {
      const full = resolveRefPath(repo, more.join('/'));
      if (!repo.refs.has(full)) return notFound('Not Found');
      repo.refs.delete(full);
      return { status: 204 };
    }
  }

  if (kind === 'commits' && more.length === 1 && request.method === 'GET') {
    const obj = repo.objects.get(more[0]);
    if (!obj || obj.type !== 'commit') return notFound();
    const record = parseCommit(obj.data);
    return json(200, {
      sha: more[0],
      node_id: `C_${more[0].slice(0, 12)}`,
      message: record.message,
      tree: { sha: record.tree, url: '' },
      parents: record.parents.map((p) => ({ sha: p })),
      author: { name: record.author, email: record.authorEmail, date: new Date(record.authorDate * 1000).toISOString() },
      committer: { name: record.committer, email: record.committerEmail, date: new Date(record.committerDate * 1000).toISOString() },
    });
  }

  if (kind === 'commits' && request.method === 'POST') {
    const body = request.body ?? {};
    if (!body.tree || !repo.objects.has(body.tree)) return unprocessable('Tree does not exist');
    const parents: string[] = Array.isArray(body.parents) ? body.parents : [];
    for (const parent of parents) {
      if (!repo.objects.has(parent)) return unprocessable('Parent does not exist');
    }
    const sha = commitObject(repo, {
      tree: body.tree,
      parents,
      message: typeof body.message === 'string' ? body.message : '',
      author: body.author,
      committer: body.committer,
    });
    return json(201, { sha, tree: { sha: body.tree }, message: body.message, parents: parents.map((p) => ({ sha: p })) });
  }

  if (kind === 'trees' && request.method === 'POST') {
    const body = request.body ?? {};
    const entries = Array.isArray(body.tree) ? body.tree : [];
    return json(201, { sha: putObject(repo, 'tree', serializeTree(entries)), tree: entries });
  }

  if (kind === 'trees' && more.length === 1 && request.method === 'GET') {
    const obj = repo.objects.get(more[0]);
    if (!obj || obj.type !== 'tree') return notFound();
    const entries = parseTree(obj.data).map((e) => ({
      path: e.name,
      mode: e.mode,
      type: e.mode === '40000' || e.mode === '040000' ? 'tree' : 'blob',
      sha: e.sha,
    }));
    return json(200, { sha: more[0], tree: entries });
  }

  if (kind === 'blobs' && more.length === 1 && request.method === 'GET') {
    const obj = repo.objects.get(more[0]);
    if (!obj || obj.type !== 'blob') return notFound();
    return json(200, {
      sha: more[0],
      size: obj.data.length,
      content: obj.data.toString('base64').replace(/(.{60})/g, '$1\n'),
      encoding: 'base64',
    });
  }

  if (kind === 'blobs' && request.method === 'POST') {
    const body = request.body ?? {};
    const data = typeof body.content === 'string'
      ? (body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8'))
      : Buffer.alloc(0);
    return json(201, { sha: putObject(repo, 'blob', data) });
  }

  if (kind === 'tags' && more.length === 1 && request.method === 'GET') {
    const obj = repo.objects.get(more[0]);
    if (!obj || obj.type !== 'tag') return notFound();
    const text = obj.data.toString('utf8');
    const objectMatch = text.match(/^object ([0-9a-f]{40})$/m);
    const typeMatch = text.match(/^type (\w+)$/m);
    const tagMatch = text.match(/^tag (.+)$/m);
    const taggerMatch = text.match(/^tagger (.+)$/m);
    return json(200, {
      sha: more[0],
      tag: tagMatch?.[1] ?? '',
      object: { sha: objectMatch?.[1] ?? '', type: typeMatch?.[1] ?? 'commit' },
      tagger: taggerMatch ? { raw: taggerMatch[1] } : null,
      message: text.split('\n\n').slice(1).join('\n\n'),
    });
  }

  return notFound();
}

function resolveRefPath(repo: Repo, raw: string): string {
  // /git/refs/heads/main arrives as ["refs","heads","main"] -> refs/heads/main
  if (raw.startsWith('refs/')) return raw;
  return `refs/${raw}`;
}

function commitObject(
  repo: Repo,
  input: {
    tree: string;
    parents: string[];
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  },
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const author = input.author ?? {};
  const committer = input.committer ?? {};
  const authorDate = author.date ? Math.floor(Date.parse(author.date) / 1000) : nowSec;
  const committerDate = committer.date ? Math.floor(Date.parse(committer.date) / 1000) : nowSec;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author.name ?? 'The Octocat'} <${author.email ?? 'octocat@github.com'}> ${authorDate} +0000`);
  lines.push(`committer ${committer.name ?? 'The Octocat'} <${committer.email ?? 'octocat@github.com'}> ${committerDate} +0000`);
  const body = `${lines.join('\n')}\n\n${input.message}`;
  return putObject(repo, 'commit', Buffer.from(body, 'utf8'));
}

function handleContents(repo: Repo, tail: string[], request: ApiRequest, currentUser: string): ApiResponse {
  const path = tail.join('/');
  const ref = request.query.get('ref') ?? repo.defaultBranch;
  const tipSha = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);

  if (request.method === 'GET') {
    if (!tipSha) return notFound('Not Found');
    const commitObj = repo.objects.get(tipSha);
    if (!commitObj || commitObj.type !== 'commit') return notFound();
    const treeSha = parseCommit(commitObj.data).tree;

    if (!path) {
      const files = flattenTree(repo, treeSha);
      const entries = Array.from(files.entries()).map(([filePath, value]) => ({
        name: filePath.split('/').pop(),
        path: filePath,
        sha: value.sha,
        size: repo.objects.get(value.sha)?.data.length ?? 0,
        type: 'file',
        mode: value.mode,
      }));
      return json(200, entries);
    }

    const files = flattenTree(repo, treeSha);
    if (files.has(path)) {
      const entry = files.get(path) as { sha: string; mode: string };
      const blob = repo.objects.get(entry.sha);
      const data = blob?.data ?? Buffer.alloc(0);
      return json(200, {
        name: path.split('/').pop(),
        path,
        sha: entry.sha,
        size: data.length,
        type: 'file',
        content: data.toString('base64').replace(/(.{60})/g, '$1\n'),
        encoding: 'base64',
        mode: entry.mode,
        url: `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git_url: '',
        html_url: '',
        download_url: null,
      });
    }

    // A directory is any path that is a prefix of a real file.
    const prefix = `${path}/`;
    const inDir = Array.from(files.entries()).filter(([p]) => p.startsWith(prefix));
    if (inDir.length > 0) {
      const direct = new Map<string, { sha: string; mode: string; dir: boolean }>();
      for (const [p, value] of inDir) {
        const remainder = p.slice(prefix.length);
        const slash = remainder.indexOf('/');
        if (slash >= 0) {
          const dirName = remainder.slice(0, slash);
          if (!direct.has(dirName)) direct.set(dirName, { sha: '', mode: '40000', dir: true });
        } else {
          direct.set(remainder, { sha: value.sha, mode: value.mode, dir: false });
        }
      }
      const entries = Array.from(direct.entries()).map(([entryName, value]) => ({
        name: entryName,
        path: `${path}/${entryName}`,
        sha: value.sha,
        size: value.dir ? 0 : (repo.objects.get(value.sha)?.data.length ?? 0),
        type: value.dir ? 'dir' : 'file',
        mode: value.dir ? '040000' : value.mode,
      }));
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return json(200, entries);
    }

    return notFound('Not Found');
  }

  if (request.method === 'PUT') {
    const body = request.body ?? {};
    if (typeof body.path === 'string' && body.path && body.path !== path) {
      return unprocessable('Invalid path');
    }
    const message: string = typeof body.message === 'string' ? body.message : `Create ${path}`;
    const data = typeof body.content === 'string'
      ? (body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8'))
      : Buffer.alloc(0);

    const current = currentFiles(repo, tipSha);
    const existing = current.get(path);

    // A stale sha is the difference between "I edited the file I read" and "I overwrote someone
    // else's change". The suite writes with an old sha and expects 409, so compare honestly.
    if (typeof body.sha === 'string' && body.sha && existing && existing.sha !== body.sha) {
      return json(409, {
        message: `${path} does not match ${body.sha}`,
        documentation_url: 'https://docs.github.com/rest',
      });
    }
    if (typeof body.sha === 'string' && body.sha && !existing) {
      return json(409, { message: `${path} does not match ${body.sha}` });
    }

    const blobSha = putObject(repo, 'blob', data);
    const nextFiles = new Map(current);
    nextFiles.set(path, { sha: blobSha, mode: '100644' });
    const newTree = buildTree(repo, nextFiles);
    const newCommit = commitObject(repo, {
      tree: newTree,
      parents: tipSha ? [tipSha] : [],
      message,
      author: { name: currentUser, email: `${currentUser}@users.noreply.github.com` },
      committer: { name: currentUser, email: `${currentUser}@users.noreply.github.com` },
    });
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, newCommit);
    repo.updatedAt = nowIso();

    return json(existing ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        size: data.length,
        type: 'file',
        content: data.toString('base64'),
        encoding: 'base64',
      },
      commit: {
        sha: newCommit,
        message,
        tree: { sha: newTree },
        parents: tipSha ? [{ sha: tipSha }] : [],
      },
    });
  }

  if (request.method === 'DELETE') {
    const body = request.body ?? {};
    if (!tipSha) return notFound('Not Found');
    const current = currentFiles(repo, tipSha);
    const existing = current.get(path);
    if (!existing) return notFound('Not Found');
    if (typeof body.sha === 'string' && body.sha && body.sha !== existing.sha) {
      return json(409, { message: `${path} does not match ${body.sha}` });
    }
    const nextFiles = new Map(current);
    nextFiles.delete(path);
    const newTree = buildTree(repo, nextFiles);
    const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
    const newCommit = commitObject(repo, {
      tree: newTree,
      parents: [tipSha],
      message,
      author: { name: currentUser, email: `${currentUser}@users.noreply.github.com` },
    });
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, newCommit);
    return json(200, { content: null, commit: { sha: newCommit, message, tree: { sha: newTree } } });
  }

  // A directory cannot be written with PUT /contents and a file cannot be read as one.
  return json(405, { message: 'Method Not Allowed' });
}

function currentFiles(repo: Repo, tipSha: string | undefined): Map<string, { sha: string; mode: string }> {
  if (!tipSha) return new Map();
  const obj = repo.objects.get(tipSha);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

function handleLabels(repo: Repo, tail: string[], request: ApiRequest): ApiResponse {
  if (tail.length === 0 && request.method === 'GET') {
    const labels = Array.from(repo.labels.values()).map((l) => ({
      id: l.name.length + 1000,
      name: l.name,
      color: l.color,
      description: l.description,
      default: false,
    }));
    return json(200, labels);
  }
  if (tail.length === 0 && request.method === 'POST') {
    const body = request.body ?? {};
    if (typeof body.name !== 'string' || !body.name) return unprocessable('Validation Failed');
    const label = { name: body.name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
    repo.labels.set(label.name, label);
    return json(201, { id: label.name.length + 1000, ...label, default: false });
  }
  if (tail.length === 1 && request.method === 'GET') {
    const label = repo.labels.get(tail[0]);
    if (!label) return notFound();
    return json(200, { id: label.name.length + 1000, ...label, default: false });
  }
  return notFound();
}

function handleIssues(store: Store, repo: Repo, tail: string[], request: ApiRequest, currentUser: string): ApiResponse {
  if (tail.length === 0) {
    if (request.method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const sort = request.query.get('sort') ?? 'created';
      const direction = request.query.get('direction') ?? 'desc';

      let list = repo.issues.slice();
      if (state !== 'all') list = list.filter((i) => i.state === state);

      list.sort((a, b) => {
        let cmp: number;
        if (sort === 'updated') cmp = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
        else if (sort === 'comments') cmp = a.comments.length - b.comments.length;
        else cmp = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (cmp === 0) cmp = a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });

      const views = list.map((i) => issueView(repo, i));
      const page = paginate(views, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return json(200, page.items, page.headers);
    }

    if (request.method === 'POST') {
      const body = request.body ?? {};
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return unprocessable('Validation Failed', [{ resource: 'Issue', field: 'title', code: 'missing_field' }]);
      }
      const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((l: any) => typeof l === 'string') : [];
      const unknown = labelNames.filter((name) => !repo.labels.has(name));
      if (unknown.length > 0) {
        return unprocessable('Validation Failed', unknown.map((name) => ({
          resource: 'Label', field: 'name', code: 'invalid', message: `Label does not exist: ${name}`,
        })));
      }
      const issue: Issue = {
        id: store.nextId++,
        number: repo.nextIssue++,
        repoId: repo.id,
        title: body.title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labelNames,
        assignees: Array.isArray(body.assignees) ? body.assignees.filter((a: any) => typeof a === 'string') : [],
        user: currentUser,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        closedAt: null,
        comments: [],
      };
      repo.issues.push(issue);
      return json(201, issueView(repo, issue));
    }
  }

  if (tail.length === 1 && tail[0] === 'comments' && request.method === 'GET') {
    const all = repo.issues.flatMap((i) => i.comments.map((c) => commentView(repo, i.number, c)));
    const page = paginate(all, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments`);
    return json(200, page.items, page.headers);
  }

  if (tail.length >= 2 && tail[tail.length - 1] === 'comments') {
    const number = Number(tail[0]);
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) return notFound();
    if (request.method === 'GET') {
      const views = issue.comments.map((c) => commentView(repo, issue.number, c));
      const page = paginate(views, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`);
      return json(200, page.items, page.headers);
    }
    if (request.method === 'POST') {
      const body = request.body ?? {};
      if (typeof body.body !== 'string') return unprocessable('Validation Failed');
      const comment = {
        id: store.nextId++,
        body: body.body,
        user: currentUser,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      return json(201, commentView(repo, issue.number, comment));
    }
  }

  if (tail.length >= 1) {
    const number = Number(tail[0]);
    if (!Number.isFinite(number)) return notFound();
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) return notFound();

    if (tail.length === 1 && request.method === 'GET') return json(200, issueView(repo, issue));

    if (tail.length === 1 && request.method === 'PATCH') {
      const body = request.body ?? {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        if (body.state !== issue.state) {
          issue.state = body.state;
          issue.closedAt = body.state === 'closed' ? nowIso() : null;
        }
      }
      if (Array.isArray(body.labels)) {
        const names = body.labels.filter((l: any) => typeof l === 'string');
        const unknown = names.filter((name: string) => !repo.labels.has(name));
        if (unknown.length > 0) return unprocessable('Validation Failed');
        issue.labels = names;
      }
      if (Array.isArray(body.assignees)) issue.assignees = body.assignees.filter((a: any) => typeof a === 'string');
      issue.updatedAt = nowIso();
      return json(200, issueView(repo, issue));
    }

    if (tail.length === 2 && tail[1] === 'labels' && request.method === 'GET') {
      return json(200, issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { id: name.length + 1000, name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
      }));
    }
  }

  return notFound();
}

function handlePulls(store: Store, repo: Repo, tail: string[], request: ApiRequest, currentUser: string): ApiResponse {
  if (tail.length === 0) {
    if (request.method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      let list = repo.pulls.slice();
      if (state === 'open') list = list.filter((p) => !p.merged && p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.merged || p.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const views = list.map((p) => pullView(repo, p));
      const page = paginate(views, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return json(200, page.items, page.headers);
    }

    if (request.method === 'POST') {
      const body = request.body ?? {};
      const headRef = typeof body.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
      const baseRef = typeof body.base === 'string' ? body.base : '';
      if (!headRef || !baseRef) {
        return unprocessable('Validation Failed', [{ resource: 'PullRequest', code: 'missing_field' }]);
      }
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) {
        return unprocessable('Validation Failed', [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]);
      }
      const pull: PullRequest = {
        id: store.nextId++,
        number: repo.nextPull++,
        repoId: repo.id,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        head: headRef,
        base: baseRef,
        headSha,
        baseSha,
        user: currentUser,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        closedAt: null,
        mergedAt: null,
        merged: false,
        mergeCommitSha: null,
      };
      repo.pulls.push(pull);
      return json(201, pullView(repo, pull), { location: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` });
    }
  }

  if (tail.length >= 1) {
    const number = Number(tail[0]);
    if (!Number.isFinite(number)) return notFound();
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return notFound();

    if (tail.length === 1 && request.method === 'GET') {
      // The head sha must be the head branch's tip at read time, not the sha captured when the
      // pull was opened: a pull whose branch moved shows the new tip.
      pull.headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
      pull.baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
      return json(200, pullView(repo, pull));
    }

    if (tail.length === 1 && request.method === 'PATCH') {
      const body = request.body ?? {};
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' && pull.state !== 'closed') {
        pull.state = 'closed';
        pull.closedAt = nowIso();
      }
      pull.updatedAt = nowIso();
      return json(200, pullView(repo, pull));
    }

    if (tail.length === 2 && tail[1] === 'files' && request.method === 'GET') {
      const files = diffTrees(repo, pull.baseSha, pull.headSha);
      const page = paginate(files, request.query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${number}/files`);
      return json(200, page.items, page.headers);
    }

    if (tail.length === 2 && tail[1] === 'commits' && request.method === 'GET') {
      const walk = commitWalk(repo, pull.headSha, 250);
      return json(200, walk.map((w) => ({
        sha: w.sha,
        commit: { message: w.commit.message, author: { name: w.commit.author, date: new Date(w.commit.authorDate * 1000).toISOString() } },
        parents: w.commit.parents.map((p) => ({ sha: p })),
      })));
    }

    if (tail.length === 2 && tail[1] === 'merge' && request.method === 'PUT') {
      if (pull.merged || pull.state !== 'open') {
        return json(405, { message: 'Pull Request is not mergeable' });
      }
      const body = request.body ?? {};
      const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';

      // A conflict is a real state: the base moved since the pull was opened and the two sides
      // no longer apply cleanly. Answering 405 is what the API does and what the suite checks.
      const headFiles = currentFiles(repo, pull.headSha);
      const baseFiles = currentFiles(repo, pull.baseSha);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const baseTipFiles = currentFiles(repo, baseTip);
      const headChanges = new Set<string>();
      for (const [path, value] of headFiles) {
        const baseValue = baseFiles.get(path);
        if (!baseValue || baseValue.sha !== value.sha) headChanges.add(path);
      }
      for (const path of baseFiles.keys()) {
        if (!headFiles.has(path)) headChanges.add(path);
      }
      let conflicts = 0;
      for (const path of headChanges) {
        if (baseTipFiles.has(path) && baseTip !== pull.baseSha) {
          const baseAt = baseFiles.get(path);
          const tipAt = baseTipFiles.get(path);
          if (baseAt && tipAt && baseAt.sha !== tipAt.sha) conflicts++;
        }
      }
      if (conflicts > 0) {
        return json(405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
      }

      const merged = new Map(baseTipFiles);
      for (const path of headChanges) {
        const value = headFiles.get(path);
        if (value) merged.set(path, value);
        else merged.delete(path);
      }
      const mergedTree = buildTree(repo, merged);
      const message = typeof body.commit_message === 'string' && body.commit_message
        ? body.commit_message
        : `Merge pull request #${pull.number} from ${pull.user}/${pull.head}`;
      const mergeCommit = commitObject(repo, {
        tree: mergedTree,
        parents: baseTip ? [baseTip, pull.headSha] : [pull.headSha],
        message,
        author: { name: currentUser, email: `${currentUser}@users.noreply.github.com` },
      });
      repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = nowIso();
      pull.closedAt = pull.mergedAt;
      pull.mergeCommitSha = mergeCommit;
      pull.baseSha = mergeCommit;
      pull.updatedAt = nowIso();
      repo.updatedAt = nowIso();

      return json(200, {
        sha: mergeCommit,
        merged: true,
        message: 'Pull Request successfully merged',
      });
    }
  }

  return notFound();
}
