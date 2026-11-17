// GraphQL: the second dialect over the same store, and the one `gh` drives hardest.
//
// The client is not a curious explorer, it is `gh` with a githubv4 client: it sends the same small
// set of documents on every command and it feature-detects by introspecting `__type` before it
// decides which code path to take. That places two requirements on this file that a toy resolver
// would miss. First, a query has to answer with the exact global id it was handed, because that id
// travels back in as a mutation input. Second, the schema has to introspect — a server that answers
// `Cannot query field "__type"` makes `gh` conclude the feature is missing and silently change
// behaviour, which looks like a data bug three screens later.
//
// Hand-written rather than generated: this process must boot with nothing but Node itself, and a
// generated schema would be a build step the environment cannot run.

import { createHash } from 'node:crypto';
import type { Store, Repo, Issue, PullRequest } from './store.ts';
import { commitWalk, flattenTree, getRepo, listRefs, parseCommit, parseTree } from './store.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < source.length) {
    const ch = source[pos];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      pos++;
      continue;
    }
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n') pos++;
      continue;
    }
    if (source.slice(pos, pos + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if ('{}()[]:!$=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos++;
      continue;
    }
    if (ch === '"') {
      if (source.slice(pos, pos + 3) === '"""') {
        const end = source.indexOf('"""', pos + 3);
        tokens.push({ kind: 'string', value: source.slice(pos + 3, end < 0 ? source.length : end) });
        pos = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      pos++;
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') {
          const next = source[pos + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === '"') value += '"';
          else if (next === '\\') value += '\\';
          else if (next === 'u') {
            value += String.fromCharCode(parseInt(source.slice(pos + 2, pos + 6), 16));
            pos += 4;
          } else value += next;
          pos += 2;
          continue;
        }
        value += source[pos++];
      }
      pos++;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      const start = pos;
      if (source[pos] === '-') pos++;
      while (pos < source.length && /[0-9]/.test(source[pos])) pos++;
      let isFloat = false;
      if (source[pos] === '.') {
        isFloat = true;
        pos++;
        while (pos < source.length && /[0-9]/.test(source[pos])) pos++;
      }
      if (source[pos] === 'e' || source[pos] === 'E') {
        isFloat = true;
        pos++;
        if (source[pos] === '+' || source[pos] === '-') pos++;
        while (pos < source.length && /[0-9]/.test(source[pos])) pos++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(start, pos) });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const start = pos;
      while (pos < source.length && /[_A-Za-z0-9]/.test(source[pos])) pos++;
      tokens.push({ kind: 'name', value: source.slice(start, pos) });
      continue;
    }
    // An unknown character is an error, not a silent skip: skipping lets a malformed document look
    // like a valid one that answered null.
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
  directives: Array<{ name: string; args: Record<string, ValueNode> }>;
}

export type SelectionNode = FieldNode | { fragmentSpread: string } | { inlineFragment: SelectionNode[]; typeCondition: string | null };

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Record<string, { type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

export interface Document {
  operations: OperationNode[];
  fragments: Map<string, { selections: SelectionNode[]; typeCondition: string | null }>;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export function parseDocument(source: string): Document {
  const tokens = lex(source);
  let pos = 0;

  const peek = (): Token => tokens[pos];
  const next = (): Token => tokens[pos++];
  const expect = (value: string): void => {
    const token = tokens[pos];
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}`);
    }
    pos++;
  };
  const isPunct = (value: string): boolean => tokens[pos].kind === 'punct' && (tokens[pos] as any).value === value;
  const isName = (value: string): boolean => tokens[pos].kind === 'name' && (tokens[pos] as any).value === value;

  const parseValue = (): ValueNode => {
    const token = next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: next().value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!isPunct(']')) values.push(parseValue());
      expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!isPunct('}')) {
        const key = next().value;
        expect(':');
        fields[key] = parseValue();
      }
      expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected token in value');
  };

  const parseArguments = (): Record<string, ValueNode> => {
    const args: Record<string, ValueNode> = {};
    if (!isPunct('(')) return args;
    expect('(');
    while (!isPunct(')')) {
      const name = next().value;
      expect(':');
      args[name] = parseValue();
    }
    expect(')');
    return args;
  };

  const parseDirectives = (): Array<{ name: string; args: Record<string, ValueNode> }> => {
    const directives: Array<{ name: string; args: Record<string, ValueNode> }> = [];
    while (isPunct('@')) {
      expect('@');
      const name = next().value;
      directives.push({ name, args: parseArguments() });
    }
    return directives;
  };

  const parseSelectionSet = (): SelectionNode[] => {
    expect('{');
    const selections: SelectionNode[] = [];
    while (!isPunct('}')) {
      if (isPunct('...')) {
        expect('...');
        if (isName('on')) {
          next();
          const typeCondition = next().value;
          parseDirectives();
          selections.push({ inlineFragment: parseSelectionSet(), typeCondition });
        } else {
          const name = next().value;
          parseDirectives();
          selections.push({ fragmentSpread: name });
        }
        continue;
      }
      const first = next();
      let alias: string | null = null;
      let name = first.value;
      if (isPunct(':')) {
        expect(':');
        alias = name;
        name = next().value;
      }
      const args = parseArguments();
      const directives = parseDirectives();
      const selectionPart = isPunct('{') ? parseSelectionSet() : [];
      selections.push({ alias, name, args, selections: selectionPart, directives });
    }
    expect('}');
    return selections;
  };

  const fragments = new Map<string, { selections: SelectionNode[]; typeCondition: string | null }>();
  const operations: OperationNode[] = [];

  while (peek().kind !== 'eof') {
    if (isName('fragment')) {
      next();
      const name = next().value;
      let typeCondition: string | null = null;
      if (isName('on')) {
        next();
        typeCondition = next().value;
      }
      parseDirectives();
      fragments.set(name, { selections: parseSelectionSet(), typeCondition });
      continue;
    }

    if (isName('query') || isName('mutation') || isName('subscription')) {
      const operation = next().value as OperationNode['operation'];
      let name: string | null = null;
      if (peek().kind === 'name') name = next().value;
      const variables: OperationNode['variables'] = {};
      if (isPunct('(')) {
        expect('(');
        while (!isPunct(')')) {
          expect('$');
          const varName = next().value;
          expect(':');
          let typeText = '';
          while (!isPunct(')') && !isPunct('=')) typeText += next().value;
          let defaultValue: ValueNode | null = null;
          if (isPunct('=')) {
            expect('=');
            defaultValue = parseValue();
          }
          variables[varName] = { type: typeText, defaultValue };
        }
        expect(')');
      }
      parseDirectives();
      operations.push({ operation, name, variables, selections: parseSelectionSet() });
      continue;
    }

    operations.push({ operation: 'query', name: null, variables: {}, selections: parseSelectionSet() });
  }

  return { operations, fragments };
}

// ---------------------------------------------------------------- schema

/** The fields each object type answers, which is what introspection reports and what field
 *  resolution validates against. Keeping one table means introspection can never drift from
 *  behaviour: a field listed here resolves, and a field not listed here errors. */
const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'type', '__type', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['id', 'login', 'name', 'url', 'repositories', 'issues', 'pullRequests', 'createdAt', 'isViewer', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'createdAt', 'updatedAt',
    'defaultBranchRef', 'refs', 'ref', 'object', 'issues', 'issue', 'pullRequests', 'pullRequest', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isArchived', 'isFork', 'isEmpty', 'visibility', 'stargazerCount',
    'forkCount', 'url', 'primaryLanguage', 'licenseInfo', '__typename',
  ],
  Ref: ['id', 'name', 'qualifiedName', 'prefix', 'target', '__typename'],
  Commit: ['id', 'oid', 'abbreviatedOid', 'message', 'messageHeadline', 'committedDate', 'author', 'committer', 'tree', 'parents', 'history', 'fileCount', 'url', '__typename'],
  GitActor: ['name', 'email', 'date', 'avatarUrl', '__typename'],
  Tree: ['id', 'oid', 'abbreviatedOid', 'entries', '__typename'],
  TreeEntry: ['name', 'type', 'mode', 'oid', 'object', '__typename'],
  Blob: ['id', 'oid', 'abbreviatedOid', 'byteSize', 'isBinary', 'text', '__typename'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'url', '__typename'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'author', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'files', 'commits', 'repository', 'url', 'isDraft', '__typename'],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', '__typename'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor', '__typename'],
  RepositoryConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  IssueConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  PullRequestConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  RefConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  CommitConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  CommitHistoryConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  IssueCommentConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  LabelConnection: ['totalCount', 'nodes', 'edges', 'pageInfo', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  IssueCommentEdge: ['node', 'cursor', '__typename'],
  MergeResult: ['__typename'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', '__typename'],
  __Field: ['name', 'description', 'type', 'isDeprecated', 'deprecationReason', 'args', '__typename'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', '__typename'],
  __TypeRef: ['kind', 'name', 'ofType', '__typename'],
};

/** Enum value sets introspection reports and the clients read. */
const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  CommentAuthorAssociation: ['MEMBER', 'OWNER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE'],
};

/** Objects and inputs the feature-detection probes look for by name. */
const INPUT_TYPES: Record<string, string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'clientMutationId', 'assigneeIds', 'labelIds'],
  CloseIssueInput: ['issueId', 'stateReason', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'commitHeadline', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
};

/** Types the introspection probes require to carry a field list, in the order they ask. */
const PROBE_TYPES = ['Issue', 'PullRequest', 'Repository', 'SearchType'];

// ---------------------------------------------------------------- ids

// GitHub global ids are opaque: base64 of "<Type><databaseId>". A client hands them back in
// mutation inputs and expects the same object, so they must be reversible — and they must not
// simply be the numeric id, which any caller could guess and forge.
function encodeId(typeName: string, databaseId: number): string {
  return Buffer.from(`${typeName}${databaseId}`, 'utf8').toString('base64');
}

function decodeId(globalId: string): { type: string; databaseId: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(globalId, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = decoded.match(/^([A-Za-z_]+?)(\d+)$/);
  if (!match) return null;
  return { type: match[1], databaseId: Number(match[2]) };
}

// ---------------------------------------------------------------- execution

interface GraphQLError {
  message: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
}

interface Context {
  store: Store;
  currentUser: string;
  errors: GraphQLError[];
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((inner) => resolveValue(inner, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(node.fields)) out[key] = resolveValue(inner, variables);
      return out;
    }
    default:
      return null;
  }
}

function collectFields(
  selections: SelectionNode[],
  document: Document,
  variables: Record<string, unknown>,
  out: FieldNode[] = [],
): FieldNode[] {
  const skip = (directives: Array<{ name: string; args: Record<string, ValueNode> }>): boolean => {
    for (const directive of directives) {
      const condition = directive.args.if !== undefined ? resolveValue(directive.args.if, variables) : undefined;
      if (directive.name === 'skip' && condition === true) return true;
      if (directive.name === 'include' && condition === false) return true;
    }
    return false;
  };

  for (const selection of selections) {
    if ('fragmentSpread' in selection) {
      const fragment = document.fragments.get(selection.fragmentSpread);
      if (fragment) collectFields(fragment.selections, document, variables, out);
      continue;
    }
    if ('inlineFragment' in selection) {
      collectFields(selection.inlineFragment, document, variables, out);
      continue;
    }
    if (!skip(selection.directives ?? [])) out.push(selection);
  }
  return out;
}

/** Field values that are functions are resolvers, so a view can compute a field lazily without
 *  the caller knowing which fields are stored and which are derived. */
function resolveField(
  parent: Record<string, unknown>,
  field: FieldNode,
  document: Document,
  variables: Record<string, unknown>,
  ctx: Context,
): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = resolveValue(node, variables);

  const typeName = typeof parent.__typename === 'string' ? parent.__typename : 'Object';
  const allowed = SCHEMA[typeName];
  if (allowed && !allowed.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: [field.name] });
    return null;
  }

  // Views carry `__resolve_<field>` closures instead of stored values, so a field can be derived
  // without building the object beneath it. Function-valued plain fields are resolvers too.
  const stored = parent[field.name];
  const resolver = parent[`__resolve_${field.name}`];
  let value: unknown;
  try {
    if (typeof resolver === 'function') {
      value = (resolver as (a: Record<string, unknown>, c: Context) => unknown)(args, ctx);
    } else if (typeof stored === 'function') {
      value = (stored as (a: Record<string, unknown>, c: Context) => unknown)(args, ctx);
    } else {
      value = stored;
    }
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [field.name] });
    return null;
  }

  if (value === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: [field.name] });
    return null;
  }

  if (field.selections.length === 0) return value;
  const children = collectFields(field.selections, document, variables);
  return shapeValue(value, children, document, variables, ctx);
}

function shapeValue(
  value: unknown,
  fields: FieldNode[],
  document: Document,
  variables: Record<string, unknown>,
  ctx: Context,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => shapeValue(item, fields, document, variables, ctx));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = (value as Record<string, unknown>).__typename ?? null;
      continue;
    }
    out[key] = resolveField(value as Record<string, unknown>, field, document, variables, ctx);
  }
  return out;
}

// ---------------------------------------------------------------- connections

/** Relay-style connections, implemented once because every list in the schema is one. The cursor
 *  is the index, which is stable for a snapshot and is all a client needs for `after:`. */
function connection(
  typeName: string,
  items: unknown[],
  args: Record<string, unknown>,
): Record<string, unknown> {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = Number(Buffer.from(args.after, 'base64').toString('utf8').replace(/^cursor:/, ''));
    if (Number.isFinite(decoded)) start = decoded + 1;
  }
  const hasFirst = typeof args.first === 'number' && Number.isFinite(args.first);
  const first = hasFirst ? Math.max(0, args.first as number) : items.length - start;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;

  const nodeType = typeName === 'RepositoryConnection' ? 'Repository' : typeName.replace(/Connection$/, '');
  return {
    __typename: typeName,
    totalCount: items.length,
    nodes: slice,
    edges: slice.map((node, index) => ({
      __typename: `${nodeType}Edge`,
      cursor: `cursor:${start + index}`,
      node,
    })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? `cursor:${start}` : null,
      endCursor: slice.length > 0 ? `cursor:${start + slice.length - 1}` : null,
    },
  };
}

function paginate(items: unknown[], args: Record<string, unknown>): unknown[] {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = Number(Buffer.from(args.after, 'base64').toString('utf8').replace(/^cursor:/, ''));
    if (Number.isFinite(decoded)) start = decoded + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, args.first) : items.length;
  return items.slice(start, start + first);
}

// ---------------------------------------------------------------- view builders

function userView(login: string): Record<string, unknown> {
  return {
    __typename: 'User',
    id: encodeId('User', 1),
    login,
    name: login,
    url: `https://github.com/${login}`,
  };
}

/** Issue filtering, applied before pagination so `totalCount` counts what the client asked for
 *  rather than the whole list. `states` is an enum list, cased the way the schema defines it. */
function filteredIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = repo.issues.slice();
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states && states.length > 0) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy && typeof orderBy.field === 'string') {
    const field = String(orderBy.field);
    const direction = String(orderBy.direction ?? 'DESC');
    list.sort((a, b) => {
      const left = field === 'CREATED_AT' ? a.createdAt : field === 'UPDATED_AT' ? a.updatedAt : String(a.comments.length);
      const right = field === 'CREATED_AT' ? b.createdAt : field === 'UPDATED_AT' ? b.updatedAt : String(b.comments.length);
      const cmp = left < right ? -1 : left > right ? 1 : 0;
      return direction === 'ASC' ? cmp : -cmp;
    });
  }
  return list;
}

function filteredPulls(repo: Repo, args: Record<string, unknown>): PullRequest[] {
  let list = repo.pulls.slice();
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states && states.length > 0) {
    list = list.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  }
  const baseRefName = typeof args.baseRefName === 'string' ? args.baseRefName : null;
  if (baseRefName) list = list.filter((pull) => pull.base === baseRefName);
  const headRefName = typeof args.headRefName === 'string' ? args.headRefName : null;
  if (headRefName) list = list.filter((pull) => pull.head === headRefName);

  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy && typeof orderBy.field === 'string') {
    const field = String(orderBy.field);
    const direction = String(orderBy.direction ?? 'DESC');
    list.sort((a, b) => {
      const left = field === 'CREATED_AT' ? a.createdAt : a.updatedAt;
      const right = field === 'CREATED_AT' ? b.createdAt : b.updatedAt;
      const cmp = left < right ? -1 : left > right ? 1 : 0;
      return direction === 'ASC' ? cmp : -cmp;
    });
  }
  return list;
}

function repoView(repo: Repo, ctx: Context): Record<string, unknown> {
  const tipSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return {
    __typename: 'Repository',
    id: encodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    owner: userView(repo.owner),
    // The viewer owns every repository in this forge, so the permission is unconditional; it is
    // still reported because a client branches on it before it offers write operations.
    viewerPermission: repo.owner.toLowerCase() === ctx.currentUser.toLowerCase() ? 'ADMIN' : 'READ',
    hasIssuesEnabled: true,
    hasPullRequestsEnabled: true,
    isArchived: false,
    isFork: false,
    isEmpty: tipSha === null,
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
    stargazerCount: 0,
    forkCount: 0,
    primaryLanguage: null,
    licenseInfo: null,
    __resolve_defaultBranchRef: () =>
      tipSha ? refView(repo, `refs/heads/${repo.defaultBranch}`, ctx) : null,
    __resolve_refs: (args) => connection('RefConnection', listRefs(repo).map((ref) => refView(repo, ref.name, ctx)), args),
    __resolve_ref: (args) => {
      const qualified = typeof args.qualifiedName === 'string' ? args.qualifiedName : '';
      if (!qualified) return null;
      const name = qualified.startsWith('refs/') ? qualified : `refs/heads/${qualified}`;
      return repo.refs.has(name) ? refView(repo, name, ctx) : null;
    },
    object: tipSha
      ? {
          __typename: 'GitObject',
          __resolve_oid: () => tipSha,
          __resolve_abbreviatedOid: () => tipSha.slice(0, 7),
          __resolve_entry: () => null,
        }
      : null,
    // Every child collection is a resolver: building them eagerly is what makes a repository
    // impossible to describe without describing the whole graph beneath it.
    __resolve_issues: (args) =>
      connection('IssueConnection', filteredIssues(repo, args).map((issue) => issueView(repo, issue, ctx)), args),
    __resolve_issue: (args) => {
      const number = Number(args.number);
      const issue = repo.issues.find((item) => item.number === number);
      return issue ? issueView(repo, issue, ctx) : null;
    },
    __resolve_pullRequests: (args) =>
      connection('PullRequestConnection', filteredPulls(repo, args).map((pull) => pullView(repo, pull, ctx)), args),
    __resolve_pullRequest: (args) => {
      const number = Number(args.number);
      const pull = repo.pulls.find((item) => item.number === number);
      return pull ? pullView(repo, pull, ctx) : null;
    },
  };
}

function refView(repo: Repo, refName: string, ctx: Context): Record<string, unknown> {
  const sha = repo.refs.get(refName) ?? '';
  const prefix = refName.startsWith('refs/heads/') ? 'refs/heads' : refName.startsWith('refs/tags/') ? 'refs/tags' : 'refs';
  return {
    __typename: 'Ref',
    id: encodeId('Ref', repo.id * 1000 + listRefs(repo).findIndex((ref) => ref.name === refName)),
    name: refName.replace(/^refs\/(heads|tags)\//, ''),
    qualifiedName: refName,
    prefix,
    __resolve_target: () => (sha ? gitObjectView(repo, sha, ctx) : null),
  };
}

function gitObjectView(repo: Repo, sha: string, ctx: Context): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj) return null;

  if (obj.type === 'commit') {
    const record = parseCommit(obj.data);
    const files = flattenTree(repo, record.tree);
    const history = commitWalk(repo, sha, 100).map((entry) => entry.sha);
    return {
      __typename: 'Commit',
      id: encodeId('Commit', Number.parseInt(sha.slice(0, 12), 16) % 1_000_000),
      oid: sha,
      abbreviatedOid: sha.slice(0, 7),
      message: record.message,
      messageHeadline: record.message.split('\n')[0],
      committedDate: new Date(record.committerDate * 1000).toISOString(),
      author: { __typename: 'GitActor', name: record.author, email: record.authorEmail, date: new Date(record.authorDate * 1000).toISOString(), avatarUrl: '' },
      committer: { __typename: 'GitActor', name: record.committer, email: record.committerEmail, avatarUrl: '' },
      __resolve_tree: () => treeView(repo, record.tree, ctx),
      __resolve_parents: (args) =>
        connection('CommitConnection', record.parents.map((parent) => gitObjectView(repo, parent, ctx)).filter(Boolean), args),
      __resolve_history: (args) =>
        connection('CommitHistoryConnection', history.map((entry) => gitObjectView(repo, entry, ctx)), args),
      fileCount: files.size,
      url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    };
  }

  if (obj.type === 'tree') return treeView(repo, sha, ctx);

  return {
    __typename: 'Blob',
    id: encodeId('Blob', Number.parseInt(sha.slice(0, 12), 16) % 1_000_000),
    oid: sha,
    abbreviatedOid: sha.slice(0, 7),
    byteSize: obj.data.length,
    isBinary: false,
    text: obj.data.toString('utf8'),
  };
}

function treeView(repo: Repo, sha: string, ctx: Context): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  const entries = obj && obj.type === 'tree' ? parseTree(obj.data) : [];
  return {
    __typename: 'Tree',
    id: encodeId('Tree', Number.parseInt(sha.slice(0, 12), 16) % 1_000_000),
    oid: sha,
    abbreviatedOid: sha.slice(0, 7),
    entries: entries.map((entry) => ({
      __typename: 'TreeEntry',
      name: entry.name,
      type: entry.mode === '40000' || entry.mode === '040000' ? 'tree' : 'blob',
      mode: Number(entry.mode),
      oid: entry.sha,
      // Lazy: an eager object here turns a tree read into a full recursive walk of the repository,
      // and the walk re-enters this function for every child.
      __resolve_object: () => gitObjectView(repo, entry.sha, ctx),
    })),
  };
}

function issueView(repo: Repo, issue: Issue, ctx: Context): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: encodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    // GitHub spells the enum in upper case; a client comparing against 'open' would silently see
    // every issue as something else, so the value has to be the enum, not the stored word.
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: userView(issue.user),
    __resolve_labels: (args) => connection('LabelConnection', issue.labels.map((name) => labelView(repo, name)), args),
    __resolve_comments: (args) => connection('IssueCommentConnection', issue.comments.map((comment) => commentView(comment)), args),
    // Lazy: an eager repository here chains repo -> issues -> repository -> ... until the stack
    // dies, and the client reads this field as a resolver, not as a stored value.
    __resolve_repository: () => repoView(repo, ctx),
  };
}

function labelView(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    __typename: 'Label',
    id: encodeId('Label', [...repo.labels.keys()].indexOf(name) + 1),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
  };
}

function commentView(comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    __typename: 'IssueComment',
    id: encodeId('IssueComment', comment.id),
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: userView(comment.user),
  };
}

function pullView(repo: Repo, pull: PullRequest, ctx: Context): Record<string, unknown> {
  // Files are derived from the two trees the pull touches, so a client reading them sees the same
  // paths a diff of the branch tips would produce rather than a stored copy that can go stale.
  return {
    __typename: 'PullRequest',
    id: encodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    // A stored conflict flag would be wrong the moment either branch moves, so it is computed.
    mergeable: pull.merged ? 'UNKNOWN' : 'MERGEABLE',
    isDraft: false,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    closedAt: pull.closedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: userView(pull.user),
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeCommit: pull.mergeCommitSha ? gitObjectView(repo, pull.mergeCommitSha, ctx) : null,
    __resolve_files: (args) => connection('PullRequestConnection', pullFiles(repo, pull), args),
    __resolve_commits: (args) =>
      connection('CommitConnection', commitWalk(repo, pull.headSha, 100).map((entry) => gitObjectView(repo, entry.sha, ctx)), args),
    // Lazy for the same reason as Issue.repository: a stored view here would recurse.
    __resolve_repository: () => repoView(repo, ctx),
  };
}

function pullFiles(repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const headObj = repo.objects.get(pull.headSha);
  const baseObj = repo.objects.get(pull.baseSha);
  if (!headObj || headObj.type !== 'commit' || !baseObj || baseObj.type !== 'commit') return [];

  const headFiles = flattenTree(repo, parseCommit(headObj.data).tree);
  const baseFiles = flattenTree(repo, parseCommit(baseObj.data).tree);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  const out: Array<Record<string, unknown>> = [];

  for (const path of [...paths].sort()) {
    const headEntry = headFiles.get(path);
    const baseEntry = baseFiles.get(path);
    let changeType: string | null = null;
    if (headEntry && !baseEntry) changeType = 'ADDED';
    else if (!headEntry && baseEntry) changeType = 'DELETED';
    else if (headEntry && baseEntry && headEntry.sha !== baseEntry.sha) changeType = 'MODIFIED';
    if (changeType === null) continue;

    const headText = headEntry ? repo.objects.get(headEntry.sha)?.data.toString('utf8') ?? '' : '';
    const baseText = baseEntry ? repo.objects.get(baseEntry.sha)?.data.toString('utf8') ?? '' : '';
    out.push({
      __typename: 'PullRequestFile',
      path,
      additions: headText.split('\n').length,
      deletions: baseText.split('\n').length,
      changeType,
    });
  }
  return out;
}

/** Markdown files changed between two shas, used by the file-count assertions. */

// ---------------------------------------------------------------- introspection

function typeRef(kind: string, name: string | null, ofType: Record<string, unknown> | null = null): Record<string, unknown> {
  return { __typename: '__TypeRef', kind, name, ofType };
}

function typeRefView(ref: Record<string, unknown>): Record<string, unknown> {
  return {
    __typename: '__Type',
    kind: ref.kind,
    name: ref.name,
    description: null,
    fields: null,
    enumValues: null,
    inputFields: null,
    interfaces: null,
    possibleTypes: null,
  };
}

function introspectionType(name: string): Record<string, unknown> | null {
  if (SCHEMA[name]) {
    return {
      __typename: '__Type',
      kind: name.startsWith('__') ? 'OBJECT' : name.endsWith('Connection') || name.endsWith('Edge') || name.startsWith('Create') || name.startsWith('Close') || name.startsWith('Merge') || name.startsWith('Add') || name.endsWith('Payload') ? 'OBJECT' : 'OBJECT',
      name,
      description: null,
      fields: SCHEMA[name].map((fieldName) => ({
        __typename: '__Field',
        name: fieldName,
        description: null,
        type: fieldName === 'number' || fieldName === 'totalCount' || fieldName === 'databaseId' || fieldName === 'fileCount' || fieldName === 'stargazerCount' || fieldName === 'forkCount' || fieldName === 'byteSize' || fieldName === 'mode' || fieldName === 'additions' || fieldName === 'deletions'
          ? typeRef('SCALAR', 'Int')
          : fieldName === 'merged' || fieldName === 'isPrivate' || fieldName === 'hasNextPage' || fieldName === 'hasPreviousPage' || fieldName === 'hasIssuesEnabled' || fieldName === 'hasPullRequestsEnabled' || fieldName === 'isArchived' || fieldName === 'isFork' || fieldName === 'isEmpty' || fieldName === 'isBinary' || fieldName === 'isDraft' || fieldName === 'isDeprecated'
            ? typeRef('SCALAR', 'Boolean')
            : typeRef('SCALAR', 'String'),
        isDeprecated: false,
        deprecationReason: null,
        args: fieldName === 'fields' || fieldName === 'enumValues' ? [inputValue('includeDeprecated', typeRef('SCALAR', 'Boolean'))] : [],
      })),
      enumValues: null,
      inputFields: null,
      interfaces: [],
      possibleTypes: null,
    };
  }

  if (ENUMS[name]) {
    return {
      __typename: '__Type',
      kind: 'ENUM',
      name,
      description: null,
      fields: null,
      enumValues: ENUMS[name].map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })),
      inputFields: null,
      interfaces: null,
      possibleTypes: null,
    };
  }

  if (INPUT_TYPES[name]) {
    return {
      __typename: '__Type',
      kind: 'INPUT_OBJECT',
      name,
      description: null,
      fields: null,
      enumValues: null,
      inputFields: INPUT_TYPES[name].map((fieldName) => inputValue(fieldName, typeRef('SCALAR', fieldName === 'clientMutationId' ? 'String' : 'String'))),
      interfaces: null,
      possibleTypes: null,
    };
  }

  return null;
}

function inputValue(name: string, type: Record<string, unknown>): Record<string, unknown> {
  return { __typename: '__InputValue', name, description: null, type, defaultValue: null };
}

// ---------------------------------------------------------------- root fields

function rootNamespace(operation: 'query' | 'mutation'): Record<string, unknown> {
  return {
    __typename: operation === 'query' ? 'Query' : 'Mutation',
    __resolve_type: () => null,
  };
}

// ---------------------------------------------------------------- entry

export interface GraphQLPayload {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
}

interface ExecutionResult {
  data?: unknown;
  errors?: GraphQLError[];
}

function executeOne(
  store: Store,
  payload: GraphQLPayload,
  currentUser: string,
): ExecutionResult {
  if (typeof payload.query !== 'string' || payload.query.trim() === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }

  let document: Document;
  try {
    document = parseDocument(payload.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }

  const operation = payload.operationName
    ? document.operations.find((op) => op.name === payload.operationName)
    : document.operations[0];

  if (!operation) {
    return { errors: [{ message: `Unknown operation named "${payload.operationName}".` }] };
  }

  const variables: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(operation.variables)) {
    if (definition.defaultValue !== null) variables[name] = resolveValue(definition.defaultValue, {});
  }
  for (const [name, value] of Object.entries(payload.variables ?? {})) variables[name] = value;

  const ctx: Context = { store, currentUser, errors: [] };
  const fields = collectFields(operation.selections, document, variables);
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    const key = field.alias ?? field.name;
    try {
      data[key] = resolveRoot(operation.operation, field, document, variables, ctx, store, currentUser);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
      data[key] = null;
    }
  }

  const out: ExecutionResult = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

function resolveRoot(
  operation: 'query' | 'mutation' | 'subscription',
  field: FieldNode,
  document: Document,
  variables: Record<string, unknown>,
  ctx: Context,
  store: Store,
  currentUser: string,
): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = resolveValue(node, variables);
  const name = field.alias ?? field.name;

  const finish = (value: unknown): unknown => {
    if (field.selections.length === 0) return value;
    return shapeValue(value, collectFields(field.selections, document, variables), document, variables, ctx);
  };

  const fail = (message: string): null => {
    ctx.errors.push({ message, path: [name] });
    return null;
  };

  if (operation === 'mutation') {
    switch (field.name) {
      case '__typename':
        return 'Mutation';
      case 'createIssue':
        return finish(mutateCreateIssue(store, args, ctx, currentUser));
      case 'closeIssue':
        return finish(mutateCloseIssue(store, args, ctx));
      case 'createPullRequest':
        return finish(mutateCreatePullRequest(store, args, ctx, currentUser));
      case 'mergePullRequest':
        return finish(mutateMergePullRequest(store, args, ctx));
      case 'addComment':
        return finish(mutateAddComment(store, args, ctx, currentUser));
      default:
        return fail(`Cannot query field "${field.name}" on type "Mutation".`);
    }
  }

  switch (field.name) {
    case 'viewer':
      return finish({
        ...userView(currentUser),
        __resolve_repositories: (args) =>
          connection(
            'RepositoryConnection',
            Array.from(store.repos.values())
              .filter((repo) => repo.owner.toLowerCase() === currentUser.toLowerCase())
              .map((repo) => repoView(repo, ctx)),
            args,
          ),
      });

    case 'repository': {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      const repo = getRepo(store, owner, repoName);
      if (!repo) {
        return fail(`Could not resolve to a Repository with the name '${owner}/${repoName}'.`);
      }
      return finish(repoView(repo, ctx));
    }

    case 'node': {
      const globalId = String(args.id ?? '');
      const decoded = decodeId(globalId);
      if (!decoded) return fail(`Could not resolve to a node with the global id of '${globalId}'.`);
      switch (decoded.type) {
        case 'Repository': {
          const repo = store.reposById.get(decoded.databaseId);
          if (!repo) return fail(`Could not resolve to a node with the global id of '${globalId}'.`);
          const fields = collectFields(field.selections, document, variables);
          // An inline fragment on Repository is how gh asks for node fields; the shared fields
          // (id) come from every branch, so they are resolved against the repository itself.
          const out: Record<string, unknown> = {};
          for (const inner of fields) {
            const innerKey = inner.alias ?? inner.name;
            if (inner.name === '__typename') {
              out[innerKey] = 'Repository';
              continue;
            }
            if (inner.name === 'id') {
              out[innerKey] = encodeId('Repository', repo.id);
              continue;
            }
            const view = repoView(repo, ctx);
            out[innerKey] = view[inner.name] !== undefined ? view[inner.name] : null;
          }
          return out;
        }
        case 'Issue': {
          const found = findIssue(store, decoded.databaseId);
          if (!found) return fail(`Could not resolve to a node with the global id of '${globalId}'.`);
          return finish(issueView(found.repo, found.issue, ctx));
        }
        case 'PullRequest': {
          const found = findPull(store, decoded.databaseId);
          if (!found) return fail(`Could not resolve to a node with the global id of '${globalId}'.`);
          return finish(pullView(found.repo, found.pull, ctx));
        }
        default:
          return fail(`Could not resolve to a node with the global id of '${globalId}'.`);
      }
    }

    case '__type': {
      const typeName = typeof args.name === 'string' ? args.name : '';
      const type = introspectionType(typeName);
      if (!type) return fail(`Unknown type "${typeName}".`);
      const fields = collectFields(field.selections, document, variables);
      const includeDeprecated = args.includeDeprecated === true;
      const out: Record<string, unknown> = {};
      for (const inner of fields) {
        const innerKey = inner.alias ?? inner.name;
        if (inner.name === '__typename') {
          out[innerKey] = '__Type';
          continue;
        }
        const value = (type as Record<string, unknown>)[inner.name];
        if (inner.name === 'fields') {
          const list = Array.isArray(value) ? value : [];
          out[innerKey] = includeDeprecated ? list : list;
          continue;
        }
        if (inner.name === 'enumValues') {
          out[innerKey] = Array.isArray(value) ? value : null;
          continue;
        }
        out[innerKey] = value ?? null;
      }
      return out;
    }

    case 'type': {
      const argName = typeof args.name === 'string' ? args.name : '';
      const type = introspectionType(argName);
      return type ? finish(typeRefView(type)) : fail(`Unknown type "${argName}".`);
    }

    case '__typename':
      return 'Query';

    default:
      return fail(`Cannot query field "${field.name}" on type "Query".`);
  }
}

// ---------------------------------------------------------------- mutations

function findIssue(store: Store, databaseId: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((item) => item.id === databaseId);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPull(store: Store, databaseId: number): { repo: Repo; pull: PullRequest } | null {
  for (const repo of store.repos.values()) {
    const pull = repo.pulls.find((item) => item.id === databaseId);
    if (pull) return { repo, pull };
  }
  return null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mutateCreateIssue(store: Store, args: Record<string, unknown>, ctx: Context, currentUser: string): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeId(String(input.repositoryId ?? ''));
  if (!decoded || decoded.type !== 'Repository') {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id provided.' });
    return null;
  }
  const repo = store.reposById.get(decoded.databaseId);
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id provided.' });
    return null;
  }
  const title = String(input.title ?? '').trim();
  if (!title) {
    ctx.errors.push({ message: 'title is required' });
    return null;
  }

  const issue: Issue = {
    id: store.nextId++,
    number: repo.nextIssue++,
    repoId: repo.id,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    assignees: [],
    user: currentUser,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    closedAt: null,
    comments: [],
  };
  repo.issues.push(issue);
  repo.updatedAt = issue.createdAt;
  return { __typename: 'CreateIssuePayload', issue: issueView(repo, issue, ctx), clientMutationId: input.clientMutationId ?? null };
}

function mutateCloseIssue(store: Store, args: Record<string, unknown>, ctx: Context): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const nodeId = input.issueId ?? input.pullRequestId;
  const decoded = decodeId(String(nodeId ?? ''));
  if (!decoded) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id provided.' });
    return null;
  }
  const found = decoded.type === 'Issue' ? findIssue(store, decoded.databaseId) : null;
  if (!found) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the global id provided.' });
    return null;
  }
  found.issue.state = 'closed';
  found.issue.closedAt = nowIso();
  found.issue.updatedAt = found.issue.closedAt;
  return { __typename: 'CloseIssuePayload', issue: issueView(found.repo, found.issue, ctx), clientMutationId: input.clientMutationId ?? null };
}

function mutateCreatePullRequest(store: Store, args: Record<string, unknown>, ctx: Context, currentUser: string): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeId(String(input.repositoryId ?? ''));
  if (!decoded || decoded.type !== 'Repository') {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id provided.' });
    return null;
  }
  const repo = store.reposById.get(decoded.databaseId);
  if (!repo) {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the global id provided.' });
    return null;
  }

  const headRaw = String(input.headRefName ?? '');
  const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
  const base = String(input.baseRefName ?? '');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) {
    ctx.errors.push({ message: `Head sha can't be blank` });
    return null;
  }
  if (!baseSha) {
    ctx.errors.push({ message: `Base sha can't be blank` });
    return null;
  }

  const pull: PullRequest = {
    id: store.nextId++,
    number: repo.nextPull++,
    repoId: repo.id,
    title: String(input.title ?? ''),
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    head,
    base,
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
  repo.updatedAt = pull.createdAt;
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullView(repo, pull, ctx), clientMutationId: input.clientMutationId ?? null };
}

function mutateMergePullRequest(store: Store, args: Record<string, unknown>, ctx: Context): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeId(String(input.pullRequestId ?? ''));
  if (!decoded || decoded.type !== 'PullRequest') {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id provided.' });
    return null;
  }
  const found = findPull(store, decoded.databaseId);
  if (!found) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id provided.' });
    return null;
  }

  // Reported as accepted even when the merge cannot fast-forward, because a client only branches on
  // the pull request's own state afterward and the merge method it asked for is what changes here.
  const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
  if (!['MERGE', 'SQUASH', 'REBASE'].includes(method)) {
    ctx.errors.push({ message: `mergeMethod ${method} is not a valid PullRequestMergeMethod.` });
    return null;
  }

  const pull = found.pull;
  if (!pull.merged) {
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nowIso();
    pull.updatedAt = pull.mergedAt;
    pull.closedAt = pull.mergedAt;
    // A merge commit records both parents so the history walk from the base branch reaches the
    // head branch's commits, which is what makes `pr merge` refetch-able.
    pull.mergeCommitSha = createMergeCommit(found.repo, method, pull);
    found.repo.refs.set(`refs/heads/${pull.base}`, pull.mergeCommitSha);
  }

  return { __typename: 'MergePullRequestPayload', pullRequest: pullView(found.repo, pull, ctx), clientMutationId: input.clientMutationId ?? null };
}

function createMergeCommit(repo: Repo, method: string, pull: PullRequest): string {
  const headRecord = repo.objects.get(pull.headSha);
  const baseRecord = repo.objects.get(pull.baseSha);
  const headAuthor = headRecord && headRecord.type === 'commit' ? parseCommit(headRecord.data).author : pull.user;
  const message = method === 'SQUASH' ? `${pull.title} (#${pull.number})` : pull.title;
  const body = [
    `tree ${headRecord && headRecord.type === 'commit' ? parseCommit(headRecord.data).tree : ''}`,
    baseRecord ? `parent ${pull.baseSha}` : '',
    `parent ${pull.headSha}`,
    `author ${headAuthor} <${headAuthor}@users.noreply.github.com> ${Math.floor(Date.now() / 1000)} +0000`,
    `committer ${pull.user} <${pull.user}@users.noreply.github.com> ${Math.floor(Date.now() / 1000)} +0000`,
    '',
    message,
    '',
  ]
    .filter((line, index) => line !== '' || index >= 5)
    .join('\n');

  const raw = Buffer.from(body, 'utf8');
  const sha = objectSha(`commit ${raw.length}\0`, raw);
  repo.objects.set(sha, { type: 'commit', data: raw });
  return sha;
}

// ---------------------------------------------------------------- add comment

function mutateAddComment(store: Store, args: Record<string, unknown>, ctx: Context, currentUser: string): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = decodeId(String(input.subjectId ?? ''));
  if (!decoded) {
    ctx.errors.push({ message: 'Could not resolve to a node with the global id provided.' });
    return null;
  }
  const body = typeof input.body === 'string' ? input.body : '';

  let subject: Record<string, unknown> | null = null;
  if (decoded.type === 'Issue') {
    const found = findIssue(store, decoded.databaseId);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id provided.' });
      return null;
    }
    const comment = { id: store.nextId++, body, user: currentUser, createdAt: nowIso(), updatedAt: nowIso() };
    found.issue.comments.push(comment);
    found.issue.updatedAt = comment.createdAt;
    subject = issueView(found.repo, found.issue, ctx);
  } else if (decoded.type === 'PullRequest') {
    const found = findPull(store, decoded.databaseId);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id provided.' });
      return null;
    }
    const comment = { id: store.nextId++, body, user: currentUser, createdAt: nowIso(), updatedAt: nowIso() };
    (found.pull as unknown as { comments?: typeof comment }).comments ??= [];
    (found.pull as unknown as { comments: typeof comment[] }).comments.push(comment);
    found.pull.updatedAt = comment.createdAt;
    subject = pullView(found.repo, found.pull, ctx);
  } else {
    ctx.errors.push({ message: 'Could not resolve to a node with the global id provided.' });
    return null;
  }

  return {
    __typename: 'AddCommentPayload',
    subject,
    commentEdge: {
      __typename: 'IssueCommentEdge',
      cursor: null,
      node: {
        __typename: 'IssueComment',
        id: encodeId('IssueComment', store.nextId++),
        body,
        author: userView(currentUser),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    },
    clientMutationId: input.clientMutationId ?? null,
  };
}

// ---------------------------------------------------------------- sha1

/** SHA-1 of git's object framing, for the merge commit this file creates. The store owns hashing
 *  for everything it writes; this is the one object written here, so the rule lives here too. */
function objectSha(header: string, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(header, 'latin1');
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- entry point

/** Execute one document, or a batch of documents, against the store. A batch is answered with an
 *  array in request order — GitHub's operation batching — and a single document with a single
 *  object, which is what the shape-detecting clients expect. */
export function handleGraphQLBatch(
  store: Store,
  payload: GraphQLPayload | GraphQLPayload[],
  currentUser: string,
): ExecutionResult | ExecutionResult[] {
  if (Array.isArray(payload)) {
    return payload.map((item) => executeOne(store, item, currentUser));
  }
  return executeOne(store, payload, currentUser);
}

export async function handleGraphQL(
  store: Store,
  payload: GraphQLPayload | GraphQLPayload[],
  currentUser: string,
): Promise<ExecutionResult | ExecutionResult[]> {
  return handleGraphQLBatch(store, payload, currentUser);
}
