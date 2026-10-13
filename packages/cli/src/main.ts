#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import type { Agent, AgentStatus, EnvScopeInfo, Sandbox, UpdateStatus, UpdateTarget } from '@cocoon/protocol';
import { attach } from './attach.ts';
import { CocoonApiError, CocoonClient } from './client.ts';
import { parseAssignments, readStdin, scopeFrom } from './env.ts';

const program = new Command('cocoon')
  .description('Control a CoCoon server (cocoond)')
  .option('--url <url>', 'server URL', process.env.COCOON_URL ?? 'http://127.0.0.1:7420')
  .option('--token <token>', 'API token (or COCOON_TOKEN)', process.env.COCOON_TOKEN)
  .option('--lang <lang>', 'language for server messages: de | en', process.env.COCOON_LANG)
  .option('--json', 'print raw JSON');

const client = () => {
  const { url, token, lang } = program.opts<{ url: string; token?: string; lang?: string }>();
  if (!token) throw new Error('missing token: set COCOON_TOKEN or pass --token');
  return new CocoonClient(url, token, lang);
};
const asJson = () => program.opts<{ json?: boolean }>().json;
const print = (value: unknown, pretty?: () => void) => (asJson() || !pretty ? console.log(JSON.stringify(value, null, 2)) : pretty());

const sandboxTable = (rows: Sandbox[]) =>
  console.table(rows.map((s) => ({ id: s.id, name: s.name, status: s.status, image: s.image, network: s.network, repo: s.repo?.url ?? '' })));
const agentTable = (rows: Agent[]) =>
  console.table(rows.map((a) => ({ id: a.id, sandbox: a.sandboxId, kind: a.kind, status: a.status, exit: a.exitCode ?? '', since: a.statusChangedAt })));

program.command('info').action(async () => print(await client().call('system.info')));

// ── sandboxes ────────────────────────────────────────────────────────────────
const sandbox = program.command('sandbox').alias('sb').description('manage sandboxes');

/** "--repo url[#ref][=folder]", repeatable. */
const collectRepo = (value: string, previous: string[] = []) => [...previous, value];
function parseRepos(specs: string[] | undefined, ref?: string): { url: string; ref?: string; path?: string }[] | undefined {
  if (!specs?.length) return undefined;
  return specs.map((spec) => {
    // "=folder" at the end (not part of a URL query string like "?a=b").
    const eq = spec.lastIndexOf('=');
    const hasFolder = eq > 0 && !spec.slice(0, eq).includes('?') && /^[\w.-]+(\/[\w.-]+)*$/.test(spec.slice(eq + 1));
    const [rest, path] = hasFolder ? [spec.slice(0, eq), spec.slice(eq + 1)] : [spec, undefined];
    const [url = '', specRef] = rest.split('#');
    return { url, ref: specRef ?? (specs.length === 1 ? ref : undefined), path };
  });
}

sandbox
  .command('create')
  .option('--name <name>')
  .option('--image <image>')
  .option('--repo <url[#ref][=folder]>', 'git repository to clone; repeat for several (each gets its own folder)', collectRepo)
  .option('--ref <ref>', 'branch / tag / commit to check out (single repository)')
  .option('--service <id>', 'shared service to attach (repeatable; default: services set to all sandboxes)', collectRepo)
  .addOption(new Option('--network <mode>').choices(['none', 'egress', 'open']))
  .option('--runtime <runtime>', 'OCI runtime, e.g. runsc (gVisor) or kata-fc (Firecracker)')
  .option('--cpus <n>', 'CPU limit', Number)
  .option('--memory <mb>', 'memory limit in MB', Number)
  .action(async (o) => {
    const result = await client().call('sandbox.create', {
      name: o.name,
      image: o.image,
      repos: parseRepos(o.repo, o.ref),
      services: o.service,
      network: o.network,
      runtime: o.runtime,
      resources: o.cpus || o.memory ? { cpus: o.cpus, memoryMb: o.memory } : undefined,
    });
    print(result, () => sandboxTable([result]));
  });

sandbox.command('ls').action(async () => {
  const rows = await client().call('sandbox.list');
  print(rows, () => sandboxTable(rows));
});
sandbox.command('get <sandboxId>').action(async (sandboxId) => print(await client().call('sandbox.get', { sandboxId })));
sandbox.command('start <sandboxId>').action(async (sandboxId) => print(await client().call('sandbox.start', { sandboxId })));
sandbox.command('stop <sandboxId>').action(async (sandboxId) => print(await client().call('sandbox.stop', { sandboxId })));
sandbox.command('rm <sandboxId>').action(async (sandboxId) => print(await client().call('sandbox.delete', { sandboxId })));

sandbox
  .command('exec <sandboxId> <command...>')
  .option('--timeout <ms>', 'timeout in ms', Number)
  .action(async (sandboxId, command: string[], o) => {
    const res = await client().call('sandbox.exec', { sandboxId, command, timeoutMs: o.timeout });
    if (asJson()) return print(res);
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
    process.exitCode = res.exitCode;
  });

sandbox
  .command('diff <sandboxId>')
  .description('export workspace changes since baseline as a git patch (apply with `git apply`)')
  .option('-o, --out <file>', 'write patch to file instead of stdout')
  .option('--repo <folder>', 'only this repository (default: all, with folder-prefixed paths)')
  .action(async (sandboxId, o) => {
    const { patch, files } = await client().call('sandbox.diff', { sandboxId, repo: o.repo });
    if (o.out) {
      writeFileSync(o.out, patch);
      console.error(`wrote ${files.length} changed file(s) to ${o.out}`);
    } else if (asJson()) print({ patch, files });
    else process.stdout.write(patch);
  });

sandbox
  .command('apply <sandboxId> <patchFile>')
  .description('apply a git patch to a repository in the sandbox')
  .option('--repo <folder>', 'repository folder (required with several repositories)')
  .action(async (sandboxId, patchFile, o) => print(await client().call('sandbox.apply_patch', { sandboxId, patch: readFileSync(patchFile, 'utf8'), repo: o.repo })));

const repo = program.command('repo').description('repositories in a sandbox');
repo.command('ls <sandboxId>').action(async (sandboxId) => {
  const rows = await client().call('git.repos', { sandboxId });
  print(rows, () => console.table(rows.map((r) => ({ folder: r.path || '.', url: r.url ?? '', branch: r.branch, head: r.head, changes: r.changes, error: r.error ?? '' }))));
});
repo
  .command('add <sandboxId> <url>')
  .option('--ref <ref>')
  .option('--folder <folder>', 'folder in the workspace (default: derived from the URL)')
  .action(async (sandboxId, url, o) => print(await client().call('sandbox.add_repo', { sandboxId, url, ref: o.ref, path: o.folder })));
repo.command('rm <sandboxId> <folder>').action(async (sandboxId, folder) => print(await client().call('sandbox.remove_repo', { sandboxId, repo: folder })));

// ── files & git ──────────────────────────────────────────────────────────────
const files = program.command('files').description('browse and edit files in a sandbox');
files.command('ls <sandboxId> [path]').action(async (sandboxId, path = '.') => {
  const res = await client().call('files.list', { sandboxId, path });
  print(res, () => res.entries.forEach((e) => console.log(`${e.type === 'dir' ? 'd' : '-'} ${String(e.size).padStart(10)}  ${e.name}`)));
});
files.command('cat <sandboxId> <path>').action(async (sandboxId, path) => {
  const res = await client().call('files.read', { sandboxId, path });
  asJson() ? print(res) : process.stdout.write(res.encoding === 'base64' ? Buffer.from(res.content, 'base64') : res.content);
});
files
  .command('put <sandboxId> <localFile> <path>')
  .action(async (sandboxId, localFile, path) =>
    print(await client().call('files.write', { sandboxId, path, content: readFileSync(localFile).toString('base64'), encoding: 'base64' })),
  );

const git = program.command('git').description('git operations in a sandbox (use --repo <folder> with several repositories)');
const repoOpt = ['--repo <folder>', 'repository folder (required with several repositories)'] as const;
git.command('status <sandboxId>').option(...repoOpt).action(async (sandboxId, o) => print(await client().call('git.status', { sandboxId, repo: o.repo })));
git
  .command('commit <sandboxId> <message>')
  .option(...repoOpt)
  .action(async (sandboxId, message, o) => print(await client().call('git.commit', { sandboxId, message, repo: o.repo })));
git
  .command('push <sandboxId> <branch>')
  .option(...repoOpt)
  .action(async (sandboxId, branch, o) => print(await client().call('git.push', { sandboxId, branch, repo: o.repo })));
git
  .command('pr <sandboxId> <branch> <title>')
  .option('--body <text>')
  .option('--base <branch>')
  .option(...repoOpt)
  .action(async (sandboxId, branch, title, o) =>
    print(await client().call('git.create_pr', { sandboxId, branch, title, body: o.body, base: o.base, repo: o.repo })),
  );

// ── admin ────────────────────────────────────────────────────────────────────
const secrets = program.command('secrets').description('API keys and other secrets stored on the server');
secrets.command('ls').action(async () => {
  const rows = await client().call('secrets.list');
  print(rows, () => console.table(rows.map((s) => ({ name: s.name, set: s.set, value: s.preview ?? '', source: s.source ?? '' }))));
});
secrets.command('set <name> <value>').action(async (name, value) => print(await client().call('secrets.set', { name, value })));
secrets.command('rm <name>').action(async (name) => print(await client().call('secrets.delete', { name })));

const tokens = program.command('tokens').description('API access tokens');
tokens.command('ls').action(async () => print(await client().call('tokens.list')));
tokens.command('create <name>').action(async (name) => print(await client().call('tokens.create', { name })));
tokens.command('revoke <id>').action(async (id) => print(await client().call('tokens.revoke', { id })));

// ── environment (.env injection) ─────────────────────────────────────────────
const envCmd = program
  .command('env')
  .description('environment variables injected into sandboxes and agents (levels: workspace → repository → sandbox → agent type)');
const scopeOptions = (cmd: Command) =>
  cmd
    .option('--workspace <id>', 'variables of a workspace')
    .option('--repo <url>', 'variables of a repository (any spelling of its URL)')
    .option('--sandbox <id>', 'variables of one sandbox');
const targetOption = new Option('--target <target>', 'env: environment variables of processes · file: .env file in the repository folder · both').choices(['env', 'file', 'both']);

const printScope = (info: EnvScopeInfo) =>
  print(info, () => {
    console.log(`${info.scope} ${info.label}${info.filePath ? `  (file: ${info.filePath})` : ''}`);
    console.table(info.vars.map((v) => ({ name: v.name, value: v.secret ? '••••••••' : (v.value ?? ''), target: v.target, proxy: v.proxyHost ?? '' })));
  });

scopeOptions(
  envCmd
    .command('ls')
    .description('list variables of one level; with --sandbox and --merged the variables the sandbox gets, with their origin')
    .option('--merged', 'show the merged variables of --sandbox')
    .option('--agent <kind>', 'with --merged: include the variables of this agent type'),
).action(async (o) => {
  if (o.merged) {
    if (!o.sandbox) throw new Error('--merged needs --sandbox <id>');
    const res = await client().call('env.resolve', { sandboxId: o.sandbox, agentKind: o.agent });
    return print(res, () => {
      console.table(
        res.vars.map((v) => ({
          name: v.name,
          value: v.secret ? '••••••••' : v.value ?? '',
          from: `${v.origin.scope}:${v.origin.label}`,
          overrides: v.overrides.map((x) => x.scope).join(' < '),
          note: v.skipped ?? '',
        })),
      );
      for (const f of res.files) console.log(`file ${f.folder ? `${f.folder}/` : ''}${f.path}: ${f.status}${f.message ? ` – ${f.message}` : ''}`);
    });
  }
  printScope(await client().call('env.get', scopeFrom(o)));
});

scopeOptions(
  envCmd
    .command('set [assignments...]')
    .description('set NAME=value pairs (values are stored encrypted; use --stdin to keep a value out of the shell history)')
    .addOption(targetOption)
    .option('--stdin', 'read the value of the single NAME from standard input')
    .option('--public', 'not a secret: the value is shown in the UI/API')
    .option('--proxy-host <host>', 'API key for this host: the sandbox only gets a placeholder, the credential proxy adds the value')
    .option('--base-url-env <name>', 'with --proxy-host: variable that receives the proxy base URL (default NAME_BASE_URL)')
    .option('--file-path <path>', 'path of the .env file inside the repository folders (default .env)'),
).action(async (assignments: string[], o) => {
  const base = { target: o.target, secret: o.public ? false : undefined, proxyHost: o.proxyHost, baseUrlEnv: o.baseUrlEnv };
  let vars: { name: string; value?: string }[];
  if (o.stdin) {
    if (assignments.length !== 1 || assignments[0]!.includes('=')) throw new Error('--stdin needs exactly one NAME (without =value)');
    vars = [{ name: assignments[0]!, value: (await readStdin()).replace(/\r?\n$/, '') }];
  } else vars = assignments.length ? parseAssignments(assignments) : [];
  if (!vars.length && o.filePath === undefined) throw new Error('nothing to set: pass NAME=value pairs or --file-path');
  printScope(await client().call('env.set', { ...scopeFrom(o), vars: vars.map((v) => ({ ...v, ...base })), filePath: o.filePath }));
});

scopeOptions(envCmd.command('rm <names...>').description('remove variables')).action(async (names: string[], o) =>
  printScope(await client().call('env.unset', { ...scopeFrom(o), names })),
);

scopeOptions(
  envCmd
    .command('import <file>')
    .description('import a local .env file ("-" = standard input)')
    .addOption(targetOption)
    .option('--public', 'import as non-secret variables')
    .option('--replace', 'remove variables of this level that are not in the file'),
).action(async (file: string, o) => {
  const content = file === '-' ? await readStdin() : readFileSync(file, 'utf8');
  const res = await client().call('env.import', { ...scopeFrom(o), content, target: o.target, secret: o.public ? false : undefined, replace: Boolean(o.replace) });
  print(res, () => {
    console.log(`imported ${res.imported.length} variable(s): ${res.imported.join(', ')}`);
    for (const e of res.errors) console.error(`${file}${e.line ? `:${e.line}` : ''}: ${e.message}`);
  });
});

envCmd
  .command('apply <sandboxId>')
  .description('write the .env files of a running sandbox now (otherwise done when the next agent starts)')
  .action(async (sandboxId) => {
    const res = await client().call('env.apply', { sandboxId });
    print(res, () => res.files.forEach((f) => console.log(`${f.folder ? `${f.folder}/` : ''}${f.path}: ${f.status}${f.message ? ` – ${f.message}` : ''}`)));
  });

// ── workspaces & tasks ───────────────────────────────────────────────────────
const workspaces = program.command('workspace').alias('ws').description('workspaces group sandboxes, agents and tasks');
workspaces.command('ls').action(async () => {
  const rows = await client().call('workspace.list');
  print(rows, () => console.table(rows.map((w) => ({ id: w.id, name: w.name, repo: (w.repos?.map((r) => r.url) ?? (w.repo ? [w.repo.url] : [])).join(', '), mode: w.sandboxMode, autoRun: w.autoRun, parallel: w.maxParallel }))));
});
workspaces
  .command('create <name>')
  .option('--repo <url[#ref][=folder]>', 'repository cloned into task sandboxes; repeat for several', collectRepo)
  .option('--ref <ref>')
  .option('--shared', 'all tasks share one sandbox (default: one sandbox per task)')
  .option('--auto-run', 'start queued tasks automatically')
  .option('--parallel <n>', 'max. parallel tasks with --auto-run', Number)
  .option('--workflow <id>', 'default workflow for new tasks')
  .action(async (name, o) =>
    print(
      await client().call('workspace.create', {
        name,
        repos: parseRepos(o.repo, o.ref),
        sandboxMode: o.shared ? 'shared' : undefined,
        autoRun: o.autoRun,
        maxParallel: o.parallel,
        defaultWorkflowId: o.workflow,
      }),
    ),
  );
workspaces.command('rm <workspaceId>').option('--delete-sandboxes').action(async (workspaceId, o) =>
  print(await client().call('workspace.delete', { workspaceId, deleteSandboxes: Boolean(o.deleteSandboxes) })),
);

const tasks = program.command('task').description('tasks on the board, run by agents or workflows');
tasks.command('ls').option('--workspace <id>').action(async (o) => {
  const rows = await client().call('task.list', { workspaceId: o.workspace });
  print(rows, () =>
    console.table(rows.map((t) => ({ id: t.id, title: t.title, status: t.status + (t.attention ? ' ⚠' : ''), stage: t.workflowId ? `${t.stage + 1} (${t.workflowId})` : (t.agentKind ?? ''), note: t.note ?? '' }))),
  );
});
tasks
  .command('create <workspaceId> <title>')
  .option('-d, --description <text>', 'what the agent should do')
  .option('--agent <kind>', 'agent type')
  .option('--workflow <id>', 'workflow instead of a single agent')
  .option('--priority <p>', 'low | normal | high')
  .option('--after <taskIds>', 'comma-separated tasks that must be done first')
  .option('--queue', 'put it in the queue (auto-run picks it up) instead of the backlog')
  .option('--start', 'start it right away')
  .action(async (workspaceId, title, o) => {
    const c = client();
    const task = await c.call('task.create', {
      workspaceId,
      title,
      description: o.description,
      agentKind: o.agent,
      workflowId: o.workflow,
      priority: o.priority,
      dependsOn: o.after ? String(o.after).split(',') : undefined,
      status: o.queue ? 'queued' : 'backlog',
    });
    print(o.start ? await c.call('task.start', { taskId: task.id }) : task);
  });
tasks.command('get <taskId>').action(async (taskId) => print(await client().call('task.get', { taskId })));
tasks.command('start <taskId>').action(async (taskId) => print(await client().call('task.start', { taskId })));
tasks.command('approve <taskId>').action(async (taskId) => print(await client().call('task.approve', { taskId })));
tasks.command('reject <taskId> <feedback>').action(async (taskId, feedback) => print(await client().call('task.reject', { taskId, feedback })));
tasks.command('stop <taskId>').action(async (taskId) => print(await client().call('task.stop', { taskId })));
tasks.command('rm <taskId>').action(async (taskId) => print(await client().call('task.delete', { taskId })));

const providers = program.command('providers').description('custom API providers (own model endpoints or other HTTP APIs)');
providers.command('ls').action(async () => {
  const { providers: all } = await client().call('settings.get');
  print(all, () =>
    console.table(Object.entries(all).map(([id, p]) => ({ id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, secret: p.secret ?? '', model: p.defaultModel ?? '' }))),
  );
});
providers
  .command('add <id> <kind> <baseUrl>')
  .description('add or replace a provider (kind: anthropic | openai | http)')
  .option('--label <label>')
  .option('--key <apiKey>', 'API key (stored as secret)')
  .option('--secret <name>', 'secret name for the key (default <ID>_API_KEY)')
  .option('--auth <mode>', 'bearer | x-api-key | header | none')
  .option('--header <name>', 'header name for --auth header')
  .option('--model <model>', 'default model')
  .action(async (id, kind, baseUrl, o) => {
    const c = client();
    const secret = o.secret ?? (o.key ? `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY` : undefined);
    if (o.key && secret) await c.call('secrets.set', { name: secret, value: o.key });
    const { providers: all } = await c.call('settings.get');
    const provider = { label: o.label ?? id, kind, baseUrl, secret, auth: o.auth ?? (o.key ? 'bearer' : 'none'), authHeader: o.header, models: [], defaultModel: o.model };
    await c.call('settings.update', { providers: { ...all, [id]: provider } });
    print(await c.call('providers.test', { id }));
  });
providers.command('test <id>').action(async (id) => print(await client().call('providers.test', { id })));
providers.command('rm <id>').action(async (id) => {
  const c = client();
  const { providers: all } = await c.call('settings.get');
  delete all[id];
  print(await c.call('settings.update', { providers: all }).then(() => ({ ok: true })));
});
const services = program.command('services').description('shared services for all sandboxes (databases, mocks)');
services.command('ls').action(async () => {
  const all = await client().call('services.list');
  print(all, () =>
    console.table(all.map((s) => ({ id: s.id, kind: s.kind, mode: s.mode, status: s.status, version: s.version ?? '', attach: s.attach, sandboxes: s.sandboxes.length, error: s.error ?? '' }))),
  );
});
services
  .command('add <kind>')
  .description('add a service (kind: postgres | mysql | mongodb | redis | wiremock | mailpit); default: started by CoCoon')
  .option('--id <id>')
  .option('--image <image>', 'container image (managed)')
  .option('--external <host:port>', 'connect to an existing server instead')
  .option('--admin-user <user>')
  .option('--admin-password <password>')
  .option('--tls')
  .option('--manual', 'do not attach to every sandbox automatically')
  .action(async (kind, o) => {
    const [host, port] = o.external ? String(o.external).split(/:(?=\d+$)/) : [];
    print(
      await client().call('services.add', {
        kind,
        id: o.id,
        mode: o.external ? 'external' : 'managed',
        image: o.image,
        host,
        port: port ? Number(port) : undefined,
        adminUser: o.adminUser,
        adminPassword: o.adminPassword,
        tls: o.tls,
        attach: o.manual ? 'manual' : 'all',
      }),
    );
  });
services
  .command('rm <id>')
  .option('--delete-data', 'also delete the data volume')
  .action(async (id, o) => print(await client().call('services.remove', { serviceId: id, deleteData: Boolean(o.deleteData) })));
for (const action of ['start', 'stop', 'test', 'credentials'] as const) {
  services.command(`${action} <id>`).action(async (id) => print(await client().call(`services.${action}`, { serviceId: id })));
}
services.command('connections <sandbox-id>').action(async (sandboxId) => print(await client().call('services.connections', { sandboxId })));
for (const action of ['attach', 'detach', 'reset'] as const) {
  services.command(`${action} <sandbox-id> <service-id>`).action(async (sandboxId, serviceId) => print(await client().call(`services.${action}`, { sandboxId, serviceId })));
}


program.command('settings').description('show server settings').action(async () => print(await client().call('settings.get')));
program
  .command('setup')
  .description('show the first-time setup checklist')
  .action(async () => {
    const res = await client().call('system.setup_status');
    print(res, () => res.steps.forEach((s) => console.log(`${s.done ? '✔' : '✘'} ${s.title}${s.detail ? `  (${s.detail})` : ''}`)));
  });

// ── ports ────────────────────────────────────────────────────────────────────
const ports = program.command('ports').description('servers in a sandbox: open them as a preview or share them on the network');
ports
  .command('ls <sandbox-id>')
  .description('detected and opened ports')
  .action(async (sandboxId) => {
    const list = await client().call('ports.list', { sandboxId });
    print(list, () =>
      console.table(
        list.map((p) => ({
          port: p.port,
          listening: p.listening ? (p.address === 'loopback' ? 'yes (localhost only)' : 'yes') : 'no',
          opened: p.opened?.mode ?? '',
          url: p.opened?.url ?? '',
        })),
      ),
    );
  });
ports
  .command('open <sandbox-id> <port>')
  .description('open a port as a preview (default) or share it on the network, and print the link')
  .option('--shared', 'reachable for everyone on the network, without login')
  .option('--name <name>', 'label shown in the UI')
  .action(async (sandboxId, port, o: { shared?: boolean; name?: string }) => {
    const c = client();
    const opened = await c.call('ports.open', { sandboxId, port: Number(port), mode: o.shared ? 'shared' : 'preview', name: o.name });
    const link = o.shared ? undefined : await c.call('ports.preview_link', { sandboxId, port: Number(port) });
    print({ ...opened, previewLink: link?.url }, () => console.log(opened.opened?.url ?? `Preview (one-time link, valid 2 minutes): ${link?.url}`));
  });
ports
  .command('close <sandbox-id> <port>')
  .action(async (sandboxId, port) => print(await client().call('ports.close', { sandboxId, port: Number(port) })));

// ── updates ──────────────────────────────────────────────────────────────────
const UPDATE_TARGETS: UpdateTarget[] = ['cocoon', 'tools', 'images'];
const updateTable = (s: UpdateStatus) => {
  const c = s.cocoon;
  const cocoonNote = c.blocked ? `blocked: ${c.blocked}` : c.error ?? (c.behind ? `${c.behind} new commit(s)` : '');
  console.table([
    { part: 'CoCoon', installed: `${c.version} (${c.commit ?? '?'})`, latest: c.latestCommit ? `${c.latestVersion ?? '?'} (${c.latestCommit})` : '', state: c.state, note: cocoonNote },
    ...s.tools.map((tool) => ({ part: tool.label, installed: tool.installed ?? '', latest: tool.latest ?? '', state: tool.state, note: tool.error ?? '' })),
    ...s.images.map((img) => ({ part: `${img.kind} image`, installed: img.ref, latest: img.base ?? '', state: img.state, note: img.reason ?? '' })),
  ]);
  console.log(s.available.length ? `Updates available: ${s.available.join(', ')}  →  cocoon update apply` : 'Everything is up to date.');
  if (s.restartRequired) console.log(s.canRestart ? 'CoCoon restarts to finish the update.' : 'Restart CoCoon to finish the update.');
};

const update = program.command('update').description('check for and install updates of CoCoon, the agent CLIs and the images');
update
  .command('check', { isDefault: true })
  .description('check whether everything is up to date')
  .action(async () => {
    const res = await client().call('update.status', { refresh: true });
    print(res, () => updateTable(res));
  });
update
  .command('apply [targets...]')
  .description(`update ${UPDATE_TARGETS.join(' | ')} (default: everything outdated) and wait until done`)
  .option('--no-wait', 'return right away')
  .action(async (targets: string[], o: { wait: boolean }) => {
    const unknown = targets.filter((x) => !UPDATE_TARGETS.includes(x as UpdateTarget));
    if (unknown.length) throw new Error(`unknown update target(s): ${unknown.join(', ')} (use ${UPDATE_TARGETS.join(', ')})`);
    const c = client();
    const started = await c.call('update.apply', { targets: targets.length ? (targets as UpdateTarget[]) : undefined });
    if (!started.targets.length) return print(started, () => console.log('Everything is up to date.'));
    if (!o.wait) return print(started, () => console.log(`Updating ${started.targets.join(', ')} …`));
    if (!asJson()) console.log(`Updating ${started.targets.join(', ')} … (this can take a few minutes)`);
    // Poll until done; during a restart the server is briefly unreachable.
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await c.call('update.status', {}).catch(() => undefined);
      if (status && !status.running && !status.restarting) return print(status, () => updateTable(status));
    }
  });
program
  .command('restart')
  .description('restart the server (when it runs under its supervisor, e.g. "pnpm start")')
  .action(async () => print(await client().call('system.restart'), () => console.log('CoCoon is restarting …')));

// ── agents ───────────────────────────────────────────────────────────────────
const agent = program.command('agent').alias('ag').description('manage agents running in sandboxes');

agent
  .command('spawn <sandboxId> <kind> [args...]')
  .option('-p, --prompt <text>', 'initial task for the agent')
  .option('--provider <ids>', 'comma-separated API provider ids (overrides the agent type)')
  .option('--model <model>', 'model name (overrides the agent type / provider default)')
  .action(async (sandboxId, kind, args: string[], o) => {
    const providers = o.provider ? String(o.provider).split(',') : undefined;
    const result = await client().call('agent.spawn', { sandboxId, kind, prompt: o.prompt, args, providers, model: o.model });
    print(result, () => agentTable([result]));
  });

agent
  .command('ls')
  .option('--sandbox <sandboxId>')
  .action(async (o) => {
    const rows = await client().call('agent.list', { sandboxId: o.sandbox });
    print(rows, () => agentTable(rows));
  });

agent.command('get <agentId>').action(async (agentId) => print(await client().call('agent.get', { agentId })));

agent
  .command('read <agentId>')
  .option('-n, --lines <n>', 'scrollback lines', Number, 200)
  .action(async (agentId, o) => {
    const { text } = await client().call('agent.read', { agentId, lines: o.lines });
    asJson() ? print({ text }) : process.stdout.write(text);
  });

agent
  .command('send <agentId> <text>')
  .option('--no-submit', 'do not press Enter afterwards')
  .action(async (agentId, text, o) => print(await client().call('agent.send_input', { agentId, text, submit: o.submit })));

agent
  .command('keys <agentId> <keys...>')
  .description('send tmux key names, e.g. Escape, C-c, Enter, Down')
  .action(async (agentId, keys: string[]) => print(await client().call('agent.send_keys', { agentId, keys })));

agent
  .command('wait <agentId>')
  .option('--until <statuses>', 'comma-separated statuses', 'done,blocked,exited')
  .option('--timeout <ms>', 'timeout in ms', Number, 300_000)
  .action(async (agentId, o) => {
    const until = String(o.until).split(',') as AgentStatus[];
    const res = await client().call('agent.wait', { agentId, until, timeoutMs: o.timeout });
    print(res, () => console.log(res.timedOut ? `timed out (status: ${res.agent.status})` : res.agent.status));
    if (res.timedOut) process.exitCode = 2;
  });

agent.command('kill <agentId>').action(async (agentId) => print(await client().call('agent.kill', { agentId })));

program
  .command('attach <agentId>')
  .description('open an interactive terminal to an agent (detach: Ctrl-b d)')
  .action(async (agentId) => attach(client(), agentId));

program
  .command('events')
  .description('stream live events')
  .option('--sandbox <sandboxId>')
  .option('--agent <agentId>')
  .action(
    (o) =>
      new Promise<void>((resolve) => {
        client().subscribe(
          { sandboxId: o.sandbox, agentId: o.agent },
          (event) => console.log(JSON.stringify(event)),
          () => resolve(),
        );
      }),
  );

program
  .command('rpc <method> [params]')
  .description('call any API method with raw JSON params')
  .action(async (method, params) => print(await client().raw(method, params ? JSON.parse(params) : {})));

program.parseAsync().catch((err: unknown) => {
  if (err instanceof CocoonApiError) {
    console.error(`error: ${err.message}`);
    if (err.error.details) console.error(JSON.stringify(err.error.details, null, 2));
  } else console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
