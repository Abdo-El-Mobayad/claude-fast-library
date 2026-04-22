---
description: Manage .claude folder content from your private library
argument-hint:
  [
    natural language instruction - sync,
    push,
    diff,
    add,
    remove,
    create,
    set up,
    etc.,
  ]
---

# /library -- Claude Library Manager

You are the single interface between the user and their claude-library system. The user speaks naturally. You figure out the operation, execute it, and report results.

## How the System Works

A central git repo (`claude-library`) holds all reusable `.claude/` content: skills, agents, commands, hooks, rules, CLAUDE.md files, settings, MCP configs, and arbitrary files. Each project is mapped in `map.json` to receive a specific selection of items. A manifest file in each project tracks what the library owns.

**Key concepts:**

- **Sync** (library to project): copies library items into the project's `.claude/` folder. Library wins.
- **Push** (project to library): sends local edits back. Project wins. Creates a git commit in the library repo.
- **Diff**: compares hashes between project and library without changing anything.
- **Variants**: `name--suffix` convention. `react--strict` in the library deploys as `react` in the project. The manifest tracks the mapping so push sends changes back to the correct variant.
- **Profiles**: named item selections in map.json (e.g., `dev`, `ops`, `starter`). Applied with `--init --profile`.
- **Auto-sync**: the LibraryHook (PostToolUse + UserPromptSubmit) detects edits to managed files and auto-pushes with a 180-second debounce. No manual push needed for routine edits.

### What gets synced

| Category  | Library storage           | Deployed to                  | Type      |
| --------- | ------------------------- | ---------------------------- | --------- |
| skills    | `skills/{name}/`          | `.claude/skills/{name}/`     | directory |
| agents    | `agents/{name}.md`        | `.claude/agents/{name}.md`   | file      |
| commands  | `commands/{name}.md`      | `.claude/commands/{name}.md` | file      |
| hooks     | `hooks/{name}/`           | `.claude/hooks/{name}/`      | directory |
| rules     | `rules/{name}.md`         | `.claude/rules/{name}.md`    | file      |
| claude-md | `claude-mds/{name}.md`    | `CLAUDE.md`                  | file      |
| settings  | `settings/{name}.json`    | `.claude/settings.json`      | file      |
| mcp       | `mcp-configs/{name}.json` | `.mcp.json`                  | file      |
| files     | `files/{name}`            | custom path from map.json    | file      |

Additionally, `master-skill-rules.json` and `master-agent-rules.json` are filtered per-project during sync to produce `skill-rules.json` and `agent-rules.json`.

## Context Gathering

Before executing any operation:

1. Read `.claude/library.json` for: library path, managed items, last sync time, library commit (legacy projects may still have `.library-manifest.json` — both are auto-migrated on next sync)
2. The manifest's `library_path` field tells you where the library repo lives
3. If the manifest is missing AND no library repo exists locally, the user may need initial setup. Check for the "First-Time Setup" triggers below.
4. If the manifest is missing but a library repo exists, suggest `/library seed` or `/library set me up`
5. For operations that need project/profile data, read `{library_path}/map.json`

## Intent Detection and Workflows

Parse `$ARGUMENTS` and match to the appropriate workflow below. The first section covers initial setup (one-time). Everything after covers ongoing usage.

---

## First-Time Setup

### Create My Own Library

**Triggers:** "set up my own library", "create my library", "I want my own library", "let's set up a library", "get started", "first time setup"

**Prerequisites check:**

1. Verify GitHub CLI is authenticated: `gh auth status`
2. If not authenticated, tell the user to run `gh auth login` first and come back

**Workflow:**

1. **Ask the user what to name their private library repo.** Suggest a default like `claude-library`. The repo will be created as `{github-username}/{name}`.

2. **Create the private repo from the public template:**

```bash
gh repo create {name} --template Abdo-El-Mobayad/claude-fast-library --private --clone
```

This gives them their own private copy with sync.mjs, empty category directories, and starter map.json.

3. **Note the local clone path.** The repo is cloned to `./{name}` in the current directory. Store this as `{library_path}` for the remaining steps.

4. **Install the LibraryHook into the current project:**
   - Create `.claude/hooks/LibraryHook/` directory
   - Copy the 3 hook files from `{library_path}/hooks/LibraryHook/`:
     - `library-sync.mjs` (PostToolUse detector)
     - `library-mtime-check.mjs` (UserPromptSubmit mtime scanner)
     - `library-sync-worker.mjs` (180s debounced pusher)
   - Update `.claude/settings.json`:
     - Add to `PostToolUse` hooks array: `{"type": "command", "command": "node .claude/hooks/LibraryHook/library-sync.mjs"}`
     - Add a new `UserPromptSubmit` entry: `{"hooks": [{"type": "command", "command": "node .claude/hooks/LibraryHook/library-mtime-check.mjs"}]}`
   - Add to `.claude/.gitignore` (create if needed): `hooks/LibraryHook/pending-sync.json`

5. **Copy the /library command into the current project:**
   - Copy `{library_path}/commands/library.md` to `.claude/commands/library.md`

6. **Seed the current project into the library:**

```bash
node {library_path}/sync.mjs --seed --name "CLAUDE--{project-name}" --project "{cwd}"
```

This imports the user's existing `.claude/` content (skills, agents, commands, hooks, CLAUDE.md, settings) into the library and creates the project mapping.

7. **Report what was imported** and tell the user:
   - "Your library is set up at `{library_path}` and connected to this project."
   - "Everything in your `.claude/` folder has been imported to the library."
   - "From now on, use `/library` for all library operations."
   - "To add another project: open it in Claude Code and say `/library set me up`"

### Connect Another Project to My Library

**Triggers:** "set me up", "connect to my library", "add this project to the library", "I have a library already"

This is for users who already have a library repo and want to connect a new project.

**Workflow:**

1. Ask where the library repo is cloned locally (or check common paths)
2. Install the LibraryHook (same as step 4 above)
3. Copy the /library command (same as step 5 above)
4. Init with a profile or seed:
   - If the user has existing `.claude/` content to import: seed
   - If starting fresh: `--init --profile` with their preferred profile
5. Sync

---

## Ongoing Usage

### Sync / Pull Latest

**Triggers:** "sync", "update", "pull", "refresh", "get latest"

```bash
node {library_path}/sync.mjs --project "{cwd}"
```

Report items synced and any warnings.

### Sync All Projects

**Triggers:** "sync all", "update everything", "sync everywhere"

```bash
node {library_path}/sync.mjs --all
```

Report per-project results.

---

### Push Changes Back

**Triggers:** "push", "save to library", "send back", "push my changes", "I modified X push it"

**Workflow:**

1. Run diff first to show what changed
2. Show the diff table to the user
3. Ask for confirmation
4. Push with appropriate scope:

```bash
# Specific item
node {library_path}/sync.mjs --push --category {cat} --item {name} --project "{cwd}"

# Entire category
node {library_path}/sync.mjs --push --category {cat} --project "{cwd}"

# Everything changed
node {library_path}/sync.mjs --push --project "{cwd}" --yes
```

**Scope detection from natural language:**

- "push growth-kit" -> `--category skills --item growth-kit`
- "push all skills" -> `--category skills`
- "push everything" -> no filter
- "push the frontend agent" -> `--category agents --item frontend-specialist`

---

### Diff / Status

**Triggers:** "diff", "status", "what's different", "out of sync", "what changed"

```bash
node {library_path}/sync.mjs --diff --project "{cwd}"
```

Output key: `= in-sync`, `* changed`, `! missing`.

### Cross-Project Diff

**Triggers:** "what's different across projects", "compare all projects", "which projects are stale"

Read `map.json` to get all project paths, then run diff on each:

```bash
node {library_path}/sync.mjs --diff --project "{path1}"
node {library_path}/sync.mjs --diff --project "{path2}"
# ... for each project
```

Summarize: which projects are fully in sync, which have changes, which have missing items.

---

### List / Show

**Triggers:** "list", "show", "what do I have", "show everything", "what's available", "what's in the library"

```bash
node {library_path}/sync.mjs --list
```

Shows all items, profiles, projects, and their configurations.

### Library Health Check

**Triggers:** "health", "which items aren't used", "stale projects", "unused items", "cleanup"

**Workflow:**

1. Read `map.json` to get all projects and all items
2. For each item in the library dirs, check if any project maps it
3. Report: items used by 0 projects (orphaned), projects with stale sync times, profiles that reference non-existent items

---

### Add Item to This Project

**Triggers:** "add [item]", "I need [item]", "include [item]", "give me [item]"

**Workflow:**

1. Determine the category. If not specified, scan library directories to find it
2. Run the add:

```bash
# Standard categories
node {library_path}/sync.mjs --add {category} {item} --project "{cwd}"

# Files (requires deploy path)
node {library_path}/sync.mjs --add files {lib-name} {deploy-path} --project "{cwd}"
```

If the item doesn't exist in the library, ask: "That item doesn't exist in the library yet. Want me to create it from the local version?" Then follow the "Create New Library Item" workflow.

### Add Item to Multiple Projects

**Triggers:** "add [item] to all projects", "add [item] everywhere", "add [item] to all dev projects"

**Workflow:**

1. Read `map.json` to find target projects
2. If "all": iterate every project
3. If "all dev projects": iterate projects using the `dev` profile (match by comparing their config against the profile)
4. For each target project:

```bash
node {library_path}/sync.mjs --add {category} {item} --project "{path}"
```

5. Sync each project afterward

---

### Remove Item

**Triggers:** "remove [item]", "drop [item]", "don't need [item]", "uninstall [item]"

1. Confirm with user
2. Run:

```bash
node {library_path}/sync.mjs --remove {category} {item} --project "{cwd}"
```

---

### Create New Library Item

**Triggers:** "I built a new skill called X", "add this to the library", "put X in the library", "create a new [skill/agent/command]"

This is different from "add item to project." This creates a new item IN the library that doesn't exist yet.

**Workflow:**

1. Identify the item: is it a local file/folder the user just built, or something to create from scratch?
2. Copy it to the library:
   - **Directory items** (skills, hooks): `cp -r .claude/{category}/{name} {library_path}/{category}/{name}`
   - **File items** (agents, commands, rules): `cp .claude/{category}/{name}.md {library_path}/{category}/{name}.md`
3. Add it to the current project's mapping in `map.json` (read map, add to the project's array, write map)
4. If the user wants it in a profile too, add to the profile's array in `map.json`
5. If the item has keyword triggers, add entries to `{library_path}/master-skill-rules.json` or `master-agent-rules.json`
6. Run sync to update the manifest:

```bash
node {library_path}/sync.mjs --project "{cwd}"
```

7. Commit the library repo:

```bash
cd {library_path} && git add -A && git commit -m "add {category}/{name}" && git push
```

### Add Item to a Profile

**Triggers:** "add [item] to the dev profile", "include [item] in all new projects"

**Workflow:**

1. Read `map.json`
2. Add the item to the specified profile's category array
3. Write `map.json`
4. Commit:

```bash
cd {library_path} && git add map.json && git commit -m "add {item} to {profile} profile" && git push
```

Note: this only affects future projects initialized with this profile. Existing projects are unchanged unless you also add the item to them individually.

---

### Create Variant

**Triggers:** "create variant", "save as variant", "fork [item]", "customize [item] for this project", "make a project-specific version"

**Workflow:**

1. Identify the item and its current library name from the manifest
2. Determine variant name. Suggest `{name}--{project-slug}` if not provided
3. Copy in the library:
   - **Directory**: `cp -r {library_path}/{category}/{name} {library_path}/{category}/{name}--{variant}`
   - **File**: `cp {library_path}/{category}/{name}.md {library_path}/{category}/{name}--{variant}.md`
4. Update `map.json`: change the project's entry from `"{name}"` to `"{name}--{variant}"`
5. Sync to update manifest
6. Commit the library

---

### Set Up New Project

**Triggers:** "set up [project]", "init", "add this project", "onboard [repo]", "bootstrap [project]"

**Workflow:**

1. Determine if a profile was specified. Default to `dev` if the user says "set up" without specifying
2. If the project path is different from cwd, ask or use the provided path

```bash
# Init with profile
node {library_path}/sync.mjs --init --profile {profile} --project "{project_path}"

# Sync
node {library_path}/sync.mjs --project "{project_path}"
```

3. Remind the user: "The project has a template repo primer at `.claude/rules/repo-primer.md`. Customize it for this project, then run `/library create variant of repo-primer` to save it back."

### Set Up from Another Project

**Triggers:** "set up like [other project]", "copy [project]'s config", "same setup as [project]"

```bash
node {library_path}/sync.mjs --init --from "{source_path}" --project "{cwd}"
node {library_path}/sync.mjs --project "{cwd}"
```

---

### Import / Seed Existing Project

**Triggers:** "seed", "import this project", "import my .claude folder", "add everything here to the library"

**Workflow:**

1. Ask for a name slug if not provided (convention: `CLAUDE--{repo-name}`)
2. Run:

```bash
node {library_path}/sync.mjs --seed --name "{slug}" --project "{cwd}"
```

3. Report what was imported

---

### Create New Profile

**Triggers:** "create a profile", "new profile called X", "make a minimal profile", "save this project's setup as a profile"

**Workflow:**

1. Read `map.json`
2. Build the profile definition:
   - If "save this project's setup as a profile": read the current project's config from map.json and copy it
   - If from scratch: ask the user what to include, or use a minimal default
3. Add to `map.json` under `profiles.{name}`
4. Write `map.json` and commit

Profile structure:

```json
{
  "claude-md": "CLAUDE--{name}",
  "settings": "settings--{name}",
  "skills": [...],
  "agents": [...],
  "commands": [...],
  "hooks": [...],
  "rules": [...],
  "files": {},
  "gitignore-lines": []
}
```

### Edit Profile

**Triggers:** "add X to the dev profile", "remove Y from the ops profile", "update profile"

Read `map.json`, modify the profile's arrays, write back, commit.

---

### Ignore Patterns

**Triggers:** "ignore [folder] in [item]", "exclude [path] from sync", "don't sync [folder]"

**Workflow:**

1. Read `map.json`
2. Add to the top-level `"ignore"` object: `{ "{item-slug}": ["{pattern}", ...] }`
3. Write `map.json` and commit
4. Run sync to propagate the ignore pattern to project manifests

Ignore patterns match against path segments. `profiles` excludes `profiles/`, `profiles/subdir/`, etc.

---

### MCP Config Management

**Triggers:** "set up MCP", "update mcp config", "switch to mac MCP", "copy MCP from [project]"

MCP configs are stored as `mcp-configs/{name}.json` in the library. Platform variants use `mcp--win`, `mcp--mac`, etc.

**Workflow:**

1. To assign: update the project's `"mcp"` field in `map.json` to the desired variant name
2. To create a new variant: copy `.mcp.json` from the project to `{library_path}/mcp-configs/{name}.json`
3. Sync to deploy

**Note:** MCP configs often contain API keys. Warn the user about credential handling. Template variants should use `<your-api-key>` placeholders.

---

### Auto-Sync Status

**Triggers:** "is auto-sync working", "check library hook", "sync status", "pending sync"

**Workflow:**

1. Check if LibraryHook is registered in `.claude/settings.json` (PostToolUse + UserPromptSubmit entries)
2. Read `.claude/hooks/LibraryHook/pending-sync.json`: timestamp > 0 means a worker is waiting
3. Read `.claude/hooks/LibraryHook/logs/library-sync.log` for recent push history
4. Report: hook status (enabled/disabled), pending pushes, last successful push time

### Disable/Enable Auto-Sync

**Triggers:** "disable auto-sync", "turn off library hook", "enable auto-sync", "turn on library hook"

Edit `.claude/settings.json`:

- To disable: remove the LibraryHook entries from `PostToolUse` and `UserPromptSubmit` hooks
- To enable: add them back (PostToolUse: `node .claude/hooks/LibraryHook/library-sync.mjs`, UserPromptSubmit: `node .claude/hooks/LibraryHook/library-mtime-check.mjs`)

---

### Troubleshooting

**Triggers:** "sync isn't working", "push failed", "manifest missing", "library error"

**Diagnostic steps:**

1. Check manifest exists: `.claude/library.json` (or legacy `.claude/.library-manifest.json`)
2. Verify library path is accessible: check `library_path` in manifest
3. Check library repo status: `cd {library_path} && git status`
4. Check for lock files or pending operations
5. Check LibraryHook logs: `.claude/hooks/LibraryHook/logs/library-sync.log`
6. Try a manual diff to verify connectivity: `node {library_path}/sync.mjs --diff --project "{cwd}"`

If manifest is missing entirely, suggest: `/library seed` (to import existing project) or `/library set me up` (fresh init).

---

## Rules

1. **Confirm before destructive operations**: push, remove, variant creation that overwrites
2. **Show tables for diff/list output**: format cleanly with alignment
3. **Always use full absolute paths** when calling sync.mjs to avoid cwd issues
4. **Default library path**: read from manifest first. Fall back to `C:/Github/claude-library`
5. **Every project should have its own repo-primer variant**: never share another project's primer. Use the template profile for new projects until a project-specific primer is created
6. **When editing map.json directly**: always read it fresh, modify, write back. Never assume cached state. Commit and push the library repo after map.json changes
7. **Category detection**: if the user names an item without a category, scan library directories (`skills/`, `agents/`, `commands/`, `hooks/`, `rules/`) to find it. Check both base names and variant names
8. **Variant naming**: suggest `{name}--{project-slug}` convention. The suffix should identify the project or purpose
9. **After any map.json edit**: run sync on affected projects to update manifests
10. **Report clearly**: after every operation, state what happened, what changed, and any follow-up actions needed
