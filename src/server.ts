import { readdir, stat, readFile, writeFile, realpath } from "node:fs/promises";
import { join, basename, resolve, relative, isAbsolute } from "node:path";

const PORT = parseInt(process.env.PORT || "3150", 10);
const HOST = process.env.HOST || "0.0.0.0";
const isWindows = process.platform === "win32";
const MANAGE_SCRIPT = isWindows
  ? resolve(import.meta.dir, "../bin/tgrep-manage.ps1")
  : resolve(import.meta.dir, "../bin/tgrep-manage.sh");
const CONFIG_PATH = resolve(import.meta.dir, "../config.json");

interface ProjectStatus {
  name: string;
  path: string;
  workspace: string;
  workspaceName: string;
  indexed: boolean;
  running: boolean;
  pid?: number;
  port?: number;
  files?: number;
  trigrams?: number;
  updated?: string;
}

// In-memory status cache to eliminate disk I/O thrashing on frequent polling
let cachedData: { projects: ProjectStatus[]; workspaces: string[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 3000;

function invalidateCache() {
  cachedData = null;
}

async function getWorkspaces(): Promise<string[]> {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
      const valid = parsed.workspaces.filter((w: any) => typeof w === "string" && w.trim().length > 0);
      if (valid.length > 0) return valid;
    }
  } catch {
    // config.json not present or invalid
  }

  const raw = process.env.SOURCE_DIRS || process.env.SOURCE_DIR;
  if (raw) {
    // Windows drive letters (C:\) contain colons, so split only on commas or semicolons
    const separator = isWindows ? /[,;]/ : /[,;:]/;
    const dirs = raw.split(separator).map((d) => d.trim()).filter((d) => d.length > 0);
    if (dirs.length > 0) return dirs;
  }

  return [resolve(import.meta.dir, "../..")];
}

async function saveWorkspaces(workspaces: string[]): Promise<string[]> {
  const validated: string[] = [];
  for (const w of workspaces) {
    if (typeof w === "string" && w.trim()) {
      try {
        const s = await stat(w.trim());
        if (s.isDirectory()) {
          validated.push(w.trim());
        }
      } catch {
        // Skip invalid directories
      }
    }
  }
  const clean = Array.from(new Set(validated));
  await writeFile(CONFIG_PATH, JSON.stringify({ workspaces: clean }, null, 2), "utf-8");
  invalidateCache();
  return clean;
}

// Security: Verify target path is strictly inside configured workspaces
async function isPathWithinWorkspaces(targetPath: string, workspaces: string[]): Promise<boolean> {
  try {
    const realTarget = await realpath(targetPath);
    for (const ws of workspaces) {
      try {
        const realWs = await realpath(ws);
        const rel = relative(realWs, realTarget);
        if (!rel.startsWith("..") && !isAbsolute(rel)) {
          return true;
        }
      } catch {
        // ignore unresolvable workspace
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function getProjectStatus(projectDir: string, workspace: string): Promise<ProjectStatus> {
  const name = basename(projectDir);
  const workspaceName = basename(workspace) || workspace;
  const tgrepDir = join(projectDir, ".tgrep");
  let indexed = false;
  let running = false;
  let pid: number | undefined;
  let port: number | undefined;
  let files: number | undefined;
  let trigrams: number | undefined;
  let updated: string | undefined;

  try {
    const s = await stat(tgrepDir);
    indexed = s.isDirectory();
  } catch {
    indexed = false;
  }

  if (indexed) {
    try {
      const serveJsonContent = await readFile(join(tgrepDir, "serve.json"), "utf-8");
      const parsed = JSON.parse(serveJsonContent);
      if (parsed.pid && typeof parsed.pid === "number" && parsed.pid > 1) {
        try {
          process.kill(parsed.pid, 0);
          // Verify process is actually tgrep to avoid false positives on PID reuse
          let isTgrep = true;
          if (process.platform === "linux") {
            try {
              const comm = await readFile(`/proc/${parsed.pid}/comm`, "utf-8");
              isTgrep = comm.trim().includes("tgrep");
            } catch {
              isTgrep = false;
            }
          }
          if (isTgrep) {
            running = true;
            pid = parsed.pid;
            port = parsed.port;
          } else {
            running = false;
          }
        } catch {
          running = false;
        }
      }
    } catch {
      running = false;
    }

    try {
      const metaContent = await readFile(join(tgrepDir, "meta.json"), "utf-8");
      const meta = JSON.parse(metaContent);
      files = meta.num_files ?? meta.file_count ?? meta.files ?? 0;
      trigrams = meta.num_trigrams ?? meta.trigram_count ?? meta.trigrams ?? 0;
      const ts = meta.updated_at ?? meta.created_at ?? meta.timestamp;
      if (ts) {
        const ms = ts < 10000000000 ? ts * 1000 : ts;
        updated = new Date(ms).toLocaleTimeString();
      }
    } catch {
      // fallback
    }
  }

  return {
    name,
    path: projectDir,
    workspace,
    workspaceName,
    indexed,
    running,
    pid,
    port,
    files,
    trigrams,
    updated,
  };
}

async function listAllProjects(): Promise<{ projects: ProjectStatus[]; workspaces: string[] }> {
  const workspaces = await getWorkspaces();
  const projects: ProjectStatus[] = [];
  const seenPaths = new Set<string>();

  for (const ws of workspaces) {
    try {
      const entries = await readdir(ws, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const fullPath = join(ws, entry.name);
          if (!seenPaths.has(fullPath)) {
            seenPaths.add(fullPath);
            try {
              const status = await getProjectStatus(fullPath, ws);
              projects.push(status);
            } catch (err) {
              console.error(`Error inspecting ${entry.name}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`Could not read workspace directory: ${ws}`, err);
    }
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  return { projects, workspaces };
}

async function getCachedProjects(force = false): Promise<{ projects: ProjectStatus[]; workspaces: string[] }> {
  const now = Date.now();
  if (!force && cachedData && now - cachedData.timestamp < CACHE_TTL_MS) {
    return cachedData;
  }
  const data = await listAllProjects();
  cachedData = { ...data, timestamp: now };
  return cachedData;
}

async function runManageAction(action: "start" | "stop" | "index", projectPath: string) {
  const workspaces = await getWorkspaces();
  const cmd = isWindows
    ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MANAGE_SCRIPT, action, projectPath]
    : [MANAGE_SCRIPT, action, projectPath];

  const proc = Bun.spawn(cmd, {
    env: {
      ...process.env,
      SOURCE_DIRS: workspaces.join(","),
      SOURCE_DIR: workspaces[0] || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  invalidateCache();

  return {
    success: exitCode === 0,
    output: (stdout + "\n" + stderr).trim(),
  };
}

// CSRF & Origin Validation Guard
function isValidOrigin(req: Request): boolean {
  if (req.method === "GET") return true;

  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return false;
  }

  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codebase Index Manager</title>
  <!-- Bulma 1.0.2 Modern CSS Framework -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    :root {
      --bulma-body-background-color: #0b1022;
      --bulma-card-background-color: #141c30;
      --bulma-box-background-color: #141c30;
      --bulma-border: rgba(142, 223, 255, 0.12);
    }
    body {
      background: radial-gradient(circle at top right, #131d3d 0%, #0b1022 60%);
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .custom-box {
      background: #141c30 !important;
      border: 1px solid var(--bulma-border);
      border-radius: 1rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    .stat-box {
      background: #111728 !important;
      border: 1px solid var(--bulma-border);
      border-radius: 0.85rem;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .stat-box:hover {
      transform: translateY(-2px);
      border-color: rgba(142, 223, 255, 0.4);
    }
    .project-card {
      background: #172138 !important;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 0.75rem;
      padding: 1.1rem;
      margin-bottom: 0.85rem;
      transition: all 0.2s ease;
    }
    .project-card:hover {
      background: #1c2844 !important;
      border-color: rgba(142, 223, 255, 0.28);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
    }
    .group-header {
      background: rgba(142, 223, 255, 0.04);
      border-left: 3px solid #3e8ed0;
      border-radius: 0 0.5rem 0.5rem 0;
      padding: 0.5rem 1rem;
      margin: 1.5rem 0 1rem 0;
    }
    .custom-table {
      background: transparent !important;
      color: #e4e7eb !important;
    }
    .custom-table thead th {
      color: #9aa5b8 !important;
      border-bottom: 2px solid var(--bulma-border) !important;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .custom-table tbody tr {
      background: #151e34 !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
      transition: background 0.15s ease;
    }
    .custom-table tbody tr:hover {
      background: #1c2742 !important;
    }
    .custom-table td {
      vertical-align: middle !important;
      border: none !important;
      padding: 0.75rem 0.75rem !important;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .pulse-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: #48c78e;
      animation: pulse-dot 1.4s ease-in-out infinite;
      margin-right: 6px;
    }
    .tag.is-serving {
      background: rgba(72, 199, 142, 0.12) !important;
      color: #48c78e !important;
      border: 1px solid rgba(72, 199, 142, 0.35);
      font-weight: 600;
    }
    .tag.is-idle {
      background: rgba(142, 223, 255, 0.08) !important;
      color: #c9f2ff !important;
      border: 1px solid rgba(142, 223, 255, 0.2);
    }
    .tag.is-unindexed {
      background: rgba(241, 70, 104, 0.1) !important;
      color: #ff859c !important;
      border: 1px solid rgba(241, 70, 104, 0.25);
    }
    .control-input {
      background: #0e1424 !important;
      border: 1px solid var(--bulma-border) !important;
      color: #fff !important;
    }
    .control-input:focus {
      border-color: #3e8ed0 !important;
      box-shadow: 0 0 0 0.125em rgba(62, 142, 208, 0.25) !important;
    }
    .select select {
      background: #0e1424 !important;
      border-color: var(--bulma-border) !important;
      color: #fff !important;
    }
    .modal-card {
      background: #141c30 !important;
      border: 1px solid var(--bulma-border);
      border-radius: 1rem;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
    }
    .modal-card-head, .modal-card-foot {
      background: #101626 !important;
      border-color: var(--bulma-border) !important;
    }
    #toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      z-index: 2000;
      min-width: 320px;
      transform: translateY(120%);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
    }
    #toast.show {
      transform: translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body class="has-text-light">
  <div class="container is-max-desktop py-6 px-4">
    <!-- Navbar / Header -->
    <nav class="level mb-6 pb-4 is-mobile" style="border-bottom: 1px solid rgba(255,255,255,0.08);">
      <div class="level-left">
        <div class="level-item">
          <span class="icon is-large has-text-info mr-2" style="background: rgba(62,142,208,0.15); border-radius: 0.85rem; border: 1px solid rgba(62,142,208,0.3);">
            <i class="fa-solid fa-bolt fa-lg"></i>
          </span>
          <div>
            <h1 class="title is-4 has-text-white mb-1">Codebase Index Manager</h1>
            <p class="subtitle is-7 has-text-grey-light">Microsoft Trigram (<code class="has-text-info">tgrep</code>) Daemon &amp; Multi-Workspace Controller</p>
          </div>
        </div>
      </div>
      <div class="level-right">
        <div class="level-item">
          <div class="buttons">
            <!-- View Mode Switcher -->
            <div class="field has-addons mr-2 mb-0">
              <p class="control">
                <button onclick="setViewMode('cards')" id="btn-view-cards" class="button is-small is-dark is-rounded is-selected" title="Card Grid View">
                  <span class="icon is-small"><i class="fa-solid fa-grip"></i></span>
                  <span class="is-hidden-mobile">Cards</span>
                </button>
              </p>
              <p class="control">
                <button onclick="setViewMode('table')" id="btn-view-table" class="button is-small is-dark is-rounded" title="Compact Table View">
                  <span class="icon is-small"><i class="fa-solid fa-list"></i></span>
                  <span class="is-hidden-mobile">Table</span>
                </button>
              </p>
            </div>
            <!-- Settings Modal Button -->
            <button onclick="openSettings()" class="button is-small is-dark is-rounded mr-2" title="Manage Workspaces (Multipath)">
              <span class="icon is-small has-text-info"><i class="fa-solid fa-gear"></i></span>
              <span class="is-hidden-mobile">Workspaces</span>
            </button>
            <!-- Refresh Button -->
            <button onclick="fetchProjects(true)" class="button is-small is-dark is-rounded" id="refresh-btn" title="Refresh project list">
              <span class="icon is-small"><i class="fa-solid fa-rotate" id="refresh-icon"></i></span>
            </button>
          </div>
        </div>
      </div>
    </nav>

    <!-- Stats Bar (Bulma Columns) -->
    <div class="columns is-mobile mb-6">
      <div class="column">
        <div class="stat-box p-3 has-text-centered">
          <p class="heading has-text-grey is-size-7 mb-1">Workspaces</p>
          <p class="title is-4 has-text-white" id="stat-workspaces">--</p>
        </div>
      </div>
      <div class="column">
        <div class="stat-box p-3 has-text-centered">
          <p class="heading has-text-grey is-size-7 mb-1">Repositories</p>
          <p class="title is-4 has-text-white" id="stat-total">--</p>
        </div>
      </div>
      <div class="column">
        <div class="stat-box p-3 has-text-centered">
          <p class="heading has-text-success is-size-7 mb-1">Live Daemons</p>
          <p class="title is-4 has-text-success" id="stat-running">--</p>
        </div>
      </div>
      <div class="column">
        <div class="stat-box p-3 has-text-centered">
          <p class="heading has-text-info is-size-7 mb-1">Indexed</p>
          <p class="title is-4 has-text-info" id="stat-indexed">--</p>
        </div>
      </div>
    </div>

    <!-- Main Content Container -->
    <div class="custom-box p-5">
      <!-- Toolbar: Search, Sort, Group, Page Size -->
      <div class="level mb-4">
        <div class="level-left">
          <div class="level-item">
            <div class="field mb-0">
              <p class="control has-icons-left has-icons-right">
                <input class="input is-small is-rounded control-input" id="search-input" type="text" placeholder="Filter by name, workspace, or status..." oninput="handleSearch()">
                <span class="icon is-small is-left">
                  <i class="fa-solid fa-magnifying-glass"></i>
                </span>
                <span class="icon is-small is-right is-clickable is-hidden" id="clear-search-btn" onclick="clearSearch()">
                  <i class="fa-solid fa-circle-xmark has-text-grey"></i>
                </span>
              </p>
            </div>
          </div>
        </div>
        <div class="level-right">
          <div class="level-item">
            <div class="field is-grouped is-grouped-multiline mb-0">
              <!-- Group By -->
              <div class="control">
                <div class="select is-small is-rounded">
                  <select id="group-select" onchange="handleFilterChange()">
                    <option value="workspace">Group: Workspace</option>
                    <option value="status">Group: Status</option>
                    <option value="none">Group: Flat List</option>
                  </select>
                </div>
              </div>
              <!-- Sort By -->
              <div class="control">
                <div class="select is-small is-rounded">
                  <select id="sort-select" onchange="handleFilterChange()">
                    <option value="name-asc">Sort: Name (A → Z)</option>
                    <option value="name-desc">Sort: Name (Z → A)</option>
                    <option value="status">Sort: Active First</option>
                    <option value="files-desc">Sort: Files (High → Low)</option>
                    <option value="trigrams-desc">Sort: Trigrams (High → Low)</option>
                  </select>
                </div>
              </div>
              <!-- Page Size -->
              <div class="control">
                <div class="select is-small is-rounded">
                  <select id="pagesize-select" onchange="handlePageSizeChange()">
                    <option value="10">10 / page</option>
                    <option value="25">25 / page</option>
                    <option value="50">50 / page</option>
                    <option value="all">All</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Render Target Area -->
      <div id="projects-container">
        <div class="has-text-centered py-6 has-text-grey">
          <span class="icon is-large"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></span>
          <p class="mt-2">Scanning workspace directories...</p>
        </div>
      </div>

      <!-- Pagination Footer -->
      <nav class="pagination is-small is-centered is-rounded mt-5 pt-3" role="navigation" aria-label="pagination" id="pagination-nav" style="border-top: 1px solid rgba(255,255,255,0.06);">
        <button class="pagination-previous button is-small is-dark" id="page-prev-btn" onclick="goToPage(currentPage - 1)">Previous</button>
        <button class="pagination-next button is-small is-dark" id="page-next-btn" onclick="goToPage(currentPage + 1)">Next</button>
        <ul class="pagination-list" id="pagination-pages"></ul>
      </nav>
      <p class="has-text-centered has-text-grey is-size-7 mt-2" id="pagination-summary"></p>
    </div>

    <!-- Workspace Configuration Modal -->
    <div class="modal" id="settings-modal">
      <div class="modal-background" onclick="closeSettings()"></div>
      <div class="modal-card">
        <header class="modal-card-head">
          <p class="modal-card-title has-text-white is-size-5">
            <span class="icon-text">
              <span class="icon has-text-info mr-2"><i class="fa-solid fa-gear"></i></span>
              <span>Workspace Directories (Multipath)</span>
            </span>
          </p>
          <button class="delete" aria-label="close" onclick="closeSettings()"></button>
        </header>
        <section class="modal-card-body">
          <p class="is-size-7 has-text-grey-light mb-4">
            Configure root directories where your repositories are stored. The manager scans all workspaces simultaneously so AI agents can query any repo.
          </p>

          <div id="modal-workspaces-list" class="mb-4"></div>

          <label class="label has-text-grey is-size-7">Add Workspace Path</label>
          <div class="field has-addons">
            <div class="control is-expanded">
              <input class="input is-small control-input mono" id="new-workspace-input" type="text" placeholder="/path/to/my/projects">
            </div>
            <div class="control">
              <button class="button is-small is-info" onclick="addWorkspacePath()">
                <span class="icon is-small"><i class="fa-solid fa-plus"></i></span>
                <span>Add</span>
              </button>
            </div>
          </div>
          <p class="help has-text-grey is-size-7">Use absolute paths. Relative paths are resolved relative to the tgrep-manager repository.</p>
        </section>
        <footer class="modal-card-foot is-justify-content-flex-end">
          <button class="button is-small is-dark" onclick="closeSettings()">Cancel</button>
          <button class="button is-small is-success" id="save-settings-btn" onclick="saveSettings()">Save &amp; Rescan</button>
        </footer>
      </div>
    </div>

    <!-- Footer -->
    <footer class="has-text-centered mt-6 has-text-grey is-size-7">
      <p>tgrep-manager • Powered by <strong>Microsoft tgrep</strong> &amp; <strong>Bun</strong> • MIT License</p>
    </footer>

    <!-- Toast Notification -->
    <div id="toast" class="notification is-dark">
      <button class="delete" onclick="hideToast()"></button>
      <div class="icon-text">
        <span class="icon" id="toast-icon"><i class="fa-solid fa-info-circle"></i></span>
        <span id="toast-msg">Notification</span>
      </div>
    </div>
  </div>

  <script>
    let allProjects = [];
    let allWorkspaces = [];
    let tempWorkspaces = [];
    let currentPage = 1;
    let viewMode = localStorage.getItem('tgrep_view') || 'cards';
    let pageSize = localStorage.getItem('tgrep_pagesize') || '10';

    document.getElementById('pagesize-select').value = pageSize;
    updateViewButtons();

    // Security: Entity encode all dynamic user content to prevent XSS
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function setViewMode(mode) {
      viewMode = mode;
      localStorage.setItem('tgrep_view', mode);
      updateViewButtons();
      renderCurrentState();
    }

    function updateViewButtons() {
      const btnCards = document.getElementById('btn-view-cards');
      const btnTable = document.getElementById('btn-view-table');
      if (viewMode === 'cards') {
        btnCards.classList.add('is-info', 'is-selected');
        btnTable.classList.remove('is-info', 'is-selected');
      } else {
        btnTable.classList.add('is-info', 'is-selected');
        btnCards.classList.remove('is-info', 'is-selected');
      }
    }

    function showToast(message, type = 'info') {
      const toast = document.getElementById('toast');
      const msg = document.getElementById('toast-msg');
      const icon = document.getElementById('toast-icon');

      msg.innerText = message;
      toast.className = 'notification';

      if (type === 'success') {
        toast.classList.add('is-success');
        icon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
      } else if (type === 'error') {
        toast.classList.add('is-danger');
        icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
      } else {
        toast.classList.add('is-info');
        icon.innerHTML = '<i class="fa-solid fa-circle-info"></i>';
      }

      toast.classList.add('show');
      clearTimeout(window.toastTimer);
      window.toastTimer = setTimeout(hideToast, 3500);
    }

    function hideToast() {
      const toast = document.getElementById('toast');
      toast.classList.remove('show');
    }

    async function fetchProjects(force = false) {
      const icon = document.getElementById('refresh-icon');
      if (icon) icon.classList.add('fa-spin');

      try {
        const res = await fetch('/api/projects' + (force ? '?refresh=1' : ''));
        const data = await res.json();
        allProjects = data.projects || [];
        allWorkspaces = data.workspaces || [];
        renderCurrentState();
      } catch (err) {
        showToast('Failed to fetch projects: ' + err.message, 'error');
      } finally {
        if (icon) icon.classList.remove('fa-spin');
      }
    }

    function handleSearch() {
      const val = document.getElementById('search-input').value;
      const clearBtn = document.getElementById('clear-search-btn');
      if (val) {
        clearBtn.classList.remove('is-hidden');
      } else {
        clearBtn.classList.add('is-hidden');
      }
      currentPage = 1;
      renderCurrentState();
    }

    function clearSearch() {
      document.getElementById('search-input').value = '';
      document.getElementById('clear-search-btn').classList.add('is-hidden');
      currentPage = 1;
      renderCurrentState();
    }

    function handleFilterChange() {
      currentPage = 1;
      renderCurrentState();
    }

    function handlePageSizeChange() {
      pageSize = document.getElementById('pagesize-select').value;
      localStorage.setItem('tgrep_pagesize', pageSize);
      currentPage = 1;
      renderCurrentState();
    }

    function goToPage(page) {
      currentPage = page;
      renderCurrentState();
    }

    function getProcessedProjects() {
      const query = document.getElementById('search-input').value.toLowerCase().trim();
      const sort = document.getElementById('sort-select').value;

      let list = allProjects.slice();

      if (query) {
        list = list.filter(p => {
          const statusStr = p.running ? 'serving running active' : p.indexed ? 'indexed idle' : 'unindexed stopped';
          return p.name.toLowerCase().includes(query) ||
                 p.workspace.toLowerCase().includes(query) ||
                 p.path.toLowerCase().includes(query) ||
                 statusStr.includes(query);
        });
      }

      list.sort((a, b) => {
        if (sort === 'name-asc') return a.name.localeCompare(b.name);
        if (sort === 'name-desc') return b.name.localeCompare(a.name);
        if (sort === 'status') {
          const score = (p) => (p.running ? 2 : p.indexed ? 1 : 0);
          return score(b) - score(a) || a.name.localeCompare(b.name);
        }
        if (sort === 'files-desc') return (b.files || 0) - (a.files || 0);
        if (sort === 'trigrams-desc') return (b.trigrams || 0) - (a.trigrams || 0);
        return 0;
      });

      return list;
    }

    function renderCurrentState() {
      document.getElementById('stat-workspaces').innerText = allWorkspaces.length;
      document.getElementById('stat-total').innerText = allProjects.length;
      document.getElementById('stat-running').innerText = allProjects.filter(p => p.running).length;
      document.getElementById('stat-indexed').innerText = allProjects.filter(p => p.indexed).length;

      const processed = getProcessedProjects();
      const groupMode = document.getElementById('group-select').value;
      const container = document.getElementById('projects-container');

      if (processed.length === 0) {
        container.innerHTML = '<div class="has-text-centered py-6 has-text-grey"><i class="fa-solid fa-magnifying-glass fa-2x mb-3"></i><p>No repositories match your criteria</p></div>';
        updatePagination(0, 1, 10);
        return;
      }

      const limit = pageSize === 'all' ? processed.length : parseInt(pageSize, 10);
      const totalPages = Math.ceil(processed.length / limit);
      if (currentPage > totalPages) currentPage = totalPages || 1;
      const startIndex = (currentPage - 1) * limit;
      const paginated = processed.slice(startIndex, startIndex + limit);

      updatePagination(processed.length, currentPage, limit);

      if (groupMode === 'none') {
        container.innerHTML = viewMode === 'cards' ? renderCards(paginated) : renderTable(paginated);
      } else {
        container.innerHTML = renderGrouped(paginated, groupMode);
      }
    }

    function renderGrouped(items, mode) {
      const groups = {};
      items.forEach(item => {
        const key = mode === 'workspace'
          ? item.workspace
          : item.running ? 'Serving (Live)' : item.indexed ? 'Indexed (Idle)' : 'Not Indexed';
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      });

      let html = '';
      for (const [groupName, groupItems] of Object.entries(groups)) {
        const icon = mode === 'workspace' ? 'fa-folder-tree has-text-info' : 'fa-layer-group has-text-warning';
        html += \`
          <div class="group-header is-flex is-justify-content-between is-align-items-center">
            <span class="icon-text">
              <span class="icon"><i class="fa-solid \${icon}"></i></span>
              <strong class="has-text-light mono is-size-6">\${escapeHtml(groupName)}</strong>
            </span>
            <span class="tag is-dark is-rounded">\${groupItems.length} repos</span>
          </div>
        \`;
        html += viewMode === 'cards' ? renderCards(groupItems) : renderTable(groupItems);
      }
      return html;
    }

    function renderCards(projects) {
      let html = '<div class="project-cards-wrapper">';
      projects.forEach(p => {
        const statusBadge = p.running
          ? \`<span class="tag is-serving is-rounded">
               <span class="pulse-dot"></span> Serving :\${escapeHtml(p.port)} (PID \${escapeHtml(p.pid)})
             </span>\`
          : p.indexed
          ? \`<span class="tag is-idle is-rounded">
               <span class="icon is-small mr-1"><i class="fa-solid fa-check"></i></span> Indexed (Idle)
             </span>\`
          : \`<span class="tag is-unindexed is-rounded">
               <span class="icon is-small mr-1"><i class="fa-solid fa-xmark"></i></span> Not Indexed
             </span>\`;

        const details = p.indexed
          ? \`<div class="tags has-addons are-small mt-2 mb-0">
               <span class="tag is-dark mono"><i class="fa-regular fa-file-code mr-1"></i> \${p.files ? Number(p.files).toLocaleString() : '0'} files</span>
               <span class="tag is-dark mono"><i class="fa-solid fa-hashtag mr-1"></i> \${p.trigrams ? (p.trigrams >= 1000 ? (p.trigrams/1000).toFixed(1) + 'k' : p.trigrams) : '0'} trigrams</span>
               \${p.updated ? \`<span class="tag is-dark is-hidden-mobile"><i class="fa-regular fa-clock mr-1"></i> \${escapeHtml(p.updated)}</span>\` : ''}
             </div>\`
          : \`<p class="is-size-7 has-text-grey mt-1">No trigram index created yet</p>\`;

        const safePath = encodeURIComponent(p.path);

        const startBtn = p.running
          ? \`<button data-action="stop" data-path="\${safePath}" class="button is-small is-danger is-outlined is-rounded">
               <span class="icon is-small"><i class="fa-solid fa-stop"></i></span>
               <span>Stop</span>
             </button>\`
          : \`<button data-action="start" data-path="\${safePath}" class="button is-small is-success is-outlined is-rounded">
               <span class="icon is-small"><i class="fa-solid fa-play"></i></span>
               <span>Start</span>
             </button>\`;

        const indexBtn = \`<button data-action="index" data-path="\${safePath}" class="button is-small is-dark is-rounded mr-2" title="Rebuild trigram index">
               <span class="icon is-small has-text-info"><i class="fa-solid fa-rotate"></i></span>
               <span>\${p.indexed ? 'Re-Index' : 'Index'}</span>
             </button>\`;

        html += \`
          <div class="project-card">
            <div class="level is-mobile mb-0">
              <div class="level-left">
                <div>
                  <div class="is-flex is-align-items-center is-flex-wrap-wrap" style="gap: 0.5rem;">
                    <span class="has-text-weight-bold has-text-white mono is-size-5">\${escapeHtml(p.name)}</span>
                    <span class="tag is-dark is-rounded is-size-7 mono" title="\${escapeHtml(p.path)}"><i class="fa-regular fa-folder mr-1 has-text-grey"></i>\${escapeHtml(p.workspaceName)}</span>
                    \${statusBadge}
                  </div>
                  \${details}
                </div>
              </div>
              <div class="level-right">
                <div class="buttons are-small mb-0">
                  \${indexBtn}
                  \${startBtn}
                </div>
              </div>
            </div>
          </div>
        \`;
      });
      html += '</div>';
      return html;
    }

    function renderTable(projects) {
      let html = \`
        <div class="table-container">
          <table class="table is-fullwidth custom-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Repository</th>
                <th>Workspace</th>
                <th>Port / PID</th>
                <th>Files</th>
                <th>Trigrams</th>
                <th class="has-text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
      \`;

      projects.forEach(p => {
        const statusBadge = p.running
          ? \`<span class="tag is-serving is-rounded is-small"><span class="pulse-dot"></span> Serving</span>\`
          : p.indexed
          ? \`<span class="tag is-idle is-rounded is-small"><i class="fa-solid fa-check mr-1"></i> Idle</span>\`
          : \`<span class="tag is-unindexed is-rounded is-small">Unindexed</span>\`;

        const portPid = p.running ? \`:\${escapeHtml(p.port)} (\${escapeHtml(p.pid)})\` : '-';
        const files = p.files ? Number(p.files).toLocaleString() : '-';
        const trigrams = p.trigrams ? (p.trigrams >= 1000 ? (p.trigrams/1000).toFixed(1) + 'k' : p.trigrams) : '-';
        const safePath = encodeURIComponent(p.path);

        const startBtn = p.running
          ? \`<button data-action="stop" data-path="\${safePath}" class="button is-small is-danger is-outlined is-rounded" title="Stop daemon">
               <span class="icon is-small"><i class="fa-solid fa-stop"></i></span>
             </button>\`
          : \`<button data-action="start" data-path="\${safePath}" class="button is-small is-success is-outlined is-rounded" title="Start daemon">
               <span class="icon is-small"><i class="fa-solid fa-play"></i></span>
             </button>\`;

        const indexBtn = \`<button data-action="index" data-path="\${safePath}" class="button is-small is-dark is-rounded mr-1" title="Rebuild Index">
               <span class="icon is-small has-text-info"><i class="fa-solid fa-rotate"></i></span>
             </button>\`;

        html += \`
          <tr>
            <td>\${statusBadge}</td>
            <td class="mono has-text-weight-semibold has-text-white">\${escapeHtml(p.name)}</td>
            <td class="mono is-size-7 has-text-grey" title="\${escapeHtml(p.path)}">\${escapeHtml(p.workspaceName)}</td>
            <td class="mono is-size-7">\${portPid}</td>
            <td class="mono is-size-7">\${files}</td>
            <td class="mono is-size-7">\${trigrams}</td>
            <td class="has-text-right">
              <div class="buttons are-small is-right mb-0">
                \${indexBtn}
                \${startBtn}
              </div>
            </td>
          </tr>
        \`;
      });

      html += '</tbody></table></div>';
      return html;
    }

    function updatePagination(totalItems, current, limit) {
      const nav = document.getElementById('pagination-nav');
      const pagesContainer = document.getElementById('pagination-pages');
      const summary = document.getElementById('pagination-summary');
      const prevBtn = document.getElementById('page-prev-btn');
      const nextBtn = document.getElementById('page-next-btn');

      if (totalItems <= limit || limit >= 100000) {
        nav.classList.add('is-hidden');
        summary.innerText = \`Showing all \${totalItems} repositories\`;
        return;
      }

      nav.classList.remove('is-hidden');
      const totalPages = Math.ceil(totalItems / limit);
      const from = (current - 1) * limit + 1;
      const to = Math.min(current * limit, totalItems);
      summary.innerText = \`Showing \${from}–\${to} of \${totalItems} repositories\`;

      prevBtn.disabled = current <= 1;
      nextBtn.disabled = current >= totalPages;

      let pagesHtml = '';
      for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= current - 1 && i <= current + 1)) {
          pagesHtml += \`
            <li>
              <a class="pagination-link \${i === current ? 'is-current' : ''}" onclick="goToPage(\${i})">\${i}</a>
            </li>
          \`;
        } else if (i === current - 2 || i === current + 2) {
          pagesHtml += '<li><span class="pagination-ellipsis">&hellip;</span></li>';
        }
      }
      pagesContainer.innerHTML = pagesHtml;
    }

    // Event delegation: intercepts data-action buttons safely without inline quotation injection
    document.getElementById('projects-container').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        const action = btn.getAttribute('data-action');
        const encodedPath = btn.getAttribute('data-path');
        if (action && encodedPath) {
          triggerAction(action, decodeURIComponent(encodedPath));
        }
      }
    });

    async function triggerAction(action, projectPath) {
      showToast(\`Executing \${action}...\`, 'info');
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: JSON.stringify({ action, path: projectPath })
        });
        const result = await res.json();
        if (result.success) {
          showToast(\`Action '\${action}' succeeded!\`, 'success');
        } else {
          showToast(\`Failed: \${result.output || 'Action rejected'}\`, 'error');
        }
        await fetchProjects(true);
      } catch (err) {
        showToast(\`Action failed: \${err.message}\`, 'error');
      }
    }

    function openSettings() {
      tempWorkspaces = [...allWorkspaces];
      renderModalWorkspaces();
      document.getElementById('settings-modal').classList.add('is-active');
    }

    function closeSettings() {
      document.getElementById('settings-modal').classList.remove('is-active');
    }

    function renderModalWorkspaces() {
      const container = document.getElementById('modal-workspaces-list');
      let html = '';
      tempWorkspaces.forEach((ws, index) => {
        html += \`
          <div class="field has-addons mb-2">
            <div class="control is-expanded">
              <input class="input is-small control-input mono" type="text" value="\${escapeHtml(ws)}" readonly>
            </div>
            <div class="control">
              <button class="button is-small is-danger is-outlined" onclick="removeWorkspace(\${index})" \${tempWorkspaces.length <= 1 ? 'disabled title="At least one workspace required"' : ''}>
                <span class="icon is-small"><i class="fa-solid fa-trash"></i></span>
              </button>
            </div>
          </div>
        \`;
      });
      container.innerHTML = html;
    }

    function addWorkspacePath() {
      const input = document.getElementById('new-workspace-input');
      const val = input.value.trim();
      if (!val) return;
      if (tempWorkspaces.includes(val)) {
        showToast('Workspace already added', 'error');
        return;
      }
      tempWorkspaces.push(val);
      input.value = '';
      renderModalWorkspaces();
    }

    function removeWorkspace(index) {
      if (tempWorkspaces.length <= 1) return;
      tempWorkspaces.splice(index, 1);
      renderModalWorkspaces();
    }

    async function saveSettings() {
      const btn = document.getElementById('save-settings-btn');
      btn.classList.add('is-loading');
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: JSON.stringify({ workspaces: tempWorkspaces })
        });
        const result = await res.json();
        if (result.success) {
          showToast('Workspace paths saved successfully!', 'success');
          allWorkspaces = result.workspaces;
          closeSettings();
          await fetchProjects(true);
        } else {
          showToast(\`Failed: \${result.output || 'Validation failed'}\`, 'error');
        }
      } catch (err) {
        showToast('Error saving settings: ' + err.message, 'error');
      } finally {
        btn.classList.remove('is-loading');
      }
    }

    fetchProjects();
    setInterval(fetchProjects, 5000);
  </script>
</body>
</html>`;

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);

    // CSRF Guard for state-changing requests
    if (!isValidOrigin(req)) {
      return Response.json({ success: false, output: "Cross-site request rejected" }, { status: 403 });
    }

    if (url.pathname === "/") {
      return new Response(HTML_CONTENT, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; font-src https://cdnjs.cloudflare.com; img-src 'self' data:; connect-src 'self'",
        },
      });
    }

    if (url.pathname === "/api/projects" && req.method === "GET") {
      const force = url.searchParams.get("refresh") === "1";
      const data = await getCachedProjects(force);
      return Response.json(data);
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      const workspaces = await getWorkspaces();
      return Response.json({ workspaces });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      try {
        if (!req.headers.get("content-type")?.includes("application/json")) {
          return Response.json({ success: false, output: "Content-Type must be application/json" }, { status: 415 });
        }
        const body = await req.json();
        const workspaces = body.workspaces;
        if (!Array.isArray(workspaces)) {
          return Response.json({ success: false, output: "Expected array of workspaces" }, { status: 400 });
        }
        const saved = await saveWorkspaces(workspaces);
        return Response.json({ success: true, workspaces: saved });
      } catch (err: any) {
        return Response.json({ success: false, output: err.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/widget" && req.method === "GET") {
      const data = await getCachedProjects(false);
      const running = data.projects.filter((p) => p.running).length;
      const indexed = data.projects.filter((p) => p.indexed).length;
      return Response.json({
        running,
        indexed,
        total: data.projects.length,
        workspaces: data.workspaces.length,
      });
    }

    if (url.pathname === "/api/action" && req.method === "POST") {
      try {
        if (!req.headers.get("content-type")?.includes("application/json")) {
          return Response.json({ success: false, output: "Content-Type must be application/json" }, { status: 415 });
        }
        const body = await req.json();
        const { action, path, project } = body;
        if (!["start", "stop", "index"].includes(action)) {
          return Response.json({ success: false, output: "Invalid action" }, { status: 400 });
        }

        const workspaces = await getWorkspaces();
        let targetPath = path;

        if (!targetPath && project) {
          for (const ws of workspaces) {
            const p = join(ws, project);
            try {
              const s = await stat(p);
              if (s.isDirectory()) {
                targetPath = p;
                break;
              }
            } catch {
              // continue search
            }
          }
        }

        if (!targetPath) {
          return Response.json({ success: false, output: "Project target path not found" }, { status: 404 });
        }

        // Security: Restrict target path to approved workspaces
        const isAllowed = await isPathWithinWorkspaces(targetPath, workspaces);
        if (!isAllowed) {
          return Response.json(
            { success: false, output: "Forbidden: Target directory is outside configured workspaces" },
            { status: 403 }
          );
        }

        const result = await runManageAction(action, targetPath);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, output: err.message }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Codebase Index Manager running at http://${HOST}:${PORT}`);
