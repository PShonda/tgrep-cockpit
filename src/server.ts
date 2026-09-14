import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename, resolve } from "node:path";

const SOURCE_DIR = process.env.SOURCE_DIR || resolve(import.meta.dir, "../..");
const PORT = parseInt(process.env.PORT || "3150", 10);
const isWindows = process.platform === "win32";
const MANAGE_SCRIPT = isWindows
  ? resolve(import.meta.dir, "../bin/tgrep-manage.ps1")
  : resolve(import.meta.dir, "../bin/tgrep-manage.sh");

interface ProjectStatus {
  name: string;
  path: string;
  indexed: boolean;
  running: boolean;
  pid?: number;
  port?: number;
  files?: number;
  trigrams?: number;
  updated?: string;
}

async function getProjectStatus(projectDir: string): Promise<ProjectStatus> {
  const name = basename(projectDir);
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
      if (parsed.pid) {
        try {
          process.kill(parsed.pid, 0);
          running = true;
          pid = parsed.pid;
          port = parsed.port;
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
    indexed,
    running,
    pid,
    port,
    files,
    trigrams,
    updated,
  };
}

async function listAllProjects(): Promise<ProjectStatus[]> {
  try {
    const entries = await readdir(SOURCE_DIR, { withFileTypes: true });
    const projects: ProjectStatus[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const fullPath = join(SOURCE_DIR, entry.name);
        try {
          const status = await getProjectStatus(fullPath);
          projects.push(status);
        } catch (err) {
          console.error(`Error inspecting ${entry.name}:`, err);
        }
      }
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  } catch (err) {
    console.error("Failed to read SOURCE_DIR:", SOURCE_DIR, err);
    return [];
  }
}

async function runManageAction(action: "start" | "stop" | "index", projectPath: string) {
  const cmd = isWindows
    ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MANAGE_SCRIPT, action, projectPath]
    : [MANAGE_SCRIPT, action, projectPath];

  const proc = Bun.spawn(cmd, {
    env: { ...process.env, SOURCE_DIR },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    success: exitCode === 0,
    output: (stdout + "\n" + stderr).trim(),
  };
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
      --bulma-card-background-color: #151d32;
      --bulma-box-background-color: #151d32;
      --bulma-border: rgba(142, 223, 255, 0.15);
    }
    body {
      background: radial-gradient(circle at top right, #131d3d 0%, #0b1022 60%);
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .custom-box {
      background: #151d32 !important;
      border: 1px solid var(--bulma-border);
      border-radius: 1rem;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    .stat-box {
      background: #12192c !important;
      border: 1px solid var(--bulma-border);
      border-radius: 0.85rem;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .stat-box:hover {
      transform: translateY(-2px);
      border-color: rgba(142, 223, 255, 0.4);
    }
    .project-card {
      background: #18233c !important;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 0.75rem;
      padding: 1.1rem;
      margin-bottom: 0.85rem;
      transition: all 0.2s ease;
    }
    .project-card:hover {
      background: #1c2946 !important;
      border-color: rgba(142, 223, 255, 0.28);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
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
    #toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      z-index: 1000;
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
            <p class="subtitle is-7 has-text-grey-light">Microsoft Trigram (<code class="has-text-info">tgrep</code>) Daemon & Multi-Repo Controller</p>
          </div>
        </div>
      </div>
      <div class="level-right">
        <div class="level-item">
          <div class="buttons">
            <button onclick="fetchProjects()" class="button is-small is-dark is-rounded mr-2" id="refresh-btn">
              <span class="icon is-small"><i class="fa-solid fa-rotate" id="refresh-icon"></i></span>
              <span>Refresh</span>
            </button>
            <a href="javascript:history.back()" class="button is-small is-info is-outlined is-rounded">
              <span class="icon is-small"><i class="fa-solid fa-arrow-left"></i></span>
              <span>Back</span>
            </a>
          </div>
        </div>
      </div>
    </nav>

    <!-- Stats Bar (Bulma Level) -->
    <div class="columns is-mobile mb-6">
      <div class="column">
        <div class="stat-box p-4 has-text-centered">
          <p class="heading has-text-grey">Repositories</p>
          <p class="title is-4 has-text-white mt-1" id="stat-total">--</p>
        </div>
      </div>
      <div class="column">
        <div class="stat-box p-4 has-text-centered">
          <p class="heading has-text-success">Live Daemons</p>
          <p class="title is-4 has-text-success mt-1" id="stat-running">--</p>
        </div>
      </div>
      <div class="column">
        <div class="stat-box p-4 has-text-centered">
          <p class="heading has-text-info">Indexed</p>
          <p class="title is-4 has-text-info mt-1" id="stat-indexed">--</p>
        </div>
      </div>
    </div>

    <!-- Main Content Box -->
    <div class="custom-box p-5">
      <div class="level is-mobile mb-4">
        <div class="level-left">
          <div class="level-item">
            <h2 class="title is-5 has-text-white mb-0">
              <span class="icon-text">
                <span class="icon has-text-grey"><i class="fa-solid fa-folder-tree"></i></span>
                <span>Discovered Projects</span>
              </span>
            </h2>
          </div>
        </div>
        <div class="level-right">
          <div class="level-item">
            <div class="field">
              <p class="control has-icons-left">
                <input class="input is-small is-rounded is-dark" id="search-input" type="text" placeholder="Filter repositories..." oninput="filterProjects()">
                <span class="icon is-small is-left">
                  <i class="fa-solid fa-magnifying-glass"></i>
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div id="projects-container">
        <div class="has-text-centered py-6 has-text-grey">
          <span class="icon is-large"><i class="fa-solid fa-spinner fa-spin fa-2x"></i></span>
          <p class="mt-2">Scanning workspace directories...</p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="has-text-centered mt-6 has-text-grey is-size-7">
      <p>tgrep-manager • Powered by <strong>Microsoft tgrep</strong> &amp; <strong>Bun</strong> • MIT License</p>
    </footer>

    <!-- Toast Notification (Bulma Notification) -->
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

    async function fetchProjects() {
      const icon = document.getElementById('refresh-icon');
      if (icon) icon.classList.add('fa-spin');

      try {
        const res = await fetch('/api/projects');
        allProjects = await res.json();
        renderProjects(allProjects);
      } catch (err) {
        showToast('Failed to fetch projects: ' + err.message, 'error');
      } finally {
        if (icon) icon.classList.remove('fa-spin');
      }
    }

    function filterProjects() {
      const query = document.getElementById('search-input').value.toLowerCase();
      const filtered = allProjects.filter(p => p.name.toLowerCase().includes(query));
      renderProjects(filtered);
    }

    function renderProjects(projects) {
      const container = document.getElementById('projects-container');
      const statTotal = document.getElementById('stat-total');
      const statRunning = document.getElementById('stat-running');
      const statIndexed = document.getElementById('stat-indexed');

      statTotal.innerText = allProjects.length;
      statRunning.innerText = allProjects.filter(p => p.running).length;
      statIndexed.innerText = allProjects.filter(p => p.indexed).length;

      if (projects.length === 0) {
        container.innerHTML = '<div class="has-text-centered py-6 has-text-grey">No repositories match your filter</div>';
        return;
      }

      let html = '';
      projects.forEach(p => {
        const statusBadge = p.running
          ? \`<span class="tag is-serving is-rounded">
               <span class="pulse-dot"></span> Serving :\${p.port} (PID \${p.pid})
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
               <span class="tag is-dark"><i class="fa-regular fa-file-code mr-1"></i> \${p.files ? Number(p.files).toLocaleString() : '0'} files</span>
               <span class="tag is-dark"><i class="fa-solid fa-hashtag mr-1"></i> \${p.trigrams ? (p.trigrams >= 1000 ? (p.trigrams/1000).toFixed(1) + 'k' : p.trigrams) : '0'} trigrams</span>
               \${p.updated ? \`<span class="tag is-dark is-hidden-mobile"><i class="fa-regular fa-clock mr-1"></i> \${p.updated}</span>\` : ''}
             </div>\`
          : \`<p class="is-size-7 has-text-grey mt-1">No trigram index yet</p>\`;

        const startBtn = p.running
          ? \`<button onclick="triggerAction('stop', '\${p.name}')" class="button is-small is-danger is-outlined is-rounded">
               <span class="icon is-small"><i class="fa-solid fa-stop"></i></span>
               <span>Stop</span>
             </button>\`
          : \`<button onclick="triggerAction('start', '\${p.name}')" class="button is-small is-success is-outlined is-rounded">
               <span class="icon is-small"><i class="fa-solid fa-play"></i></span>
               <span>Start</span>
             </button>\`;

        const indexBtn = \`<button onclick="triggerAction('index', '\${p.name}')" class="button is-small is-dark is-rounded mr-2">
               <span class="icon is-small has-text-info"><i class="fa-solid fa-rotate"></i></span>
               <span>\${p.indexed ? 'Re-Index' : 'Index'}</span>
             </button>\`;

        html += \`
          <div class="project-card">
            <div class="level is-mobile mb-0">
              <div class="level-left">
                <div>
                  <div class="is-flex is-align-items-center">
                    <span class="has-text-weight-bold has-text-white is-family-monospace mr-3 is-size-5">\${p.name}</span>
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

      container.innerHTML = html;
    }

    async function triggerAction(action, projectName) {
      showToast(\`Executing \${action} on \${projectName}...\`, 'info');
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, project: projectName })
        });
        const result = await res.json();
        if (result.success) {
          showToast(\`\${action} on \${projectName} completed successfully!\`, 'success');
        } else {
          showToast(\`Failed: \${result.output || 'Unknown error'}\`, 'error');
        }
        await fetchProjects();
      } catch (err) {
        showToast(\`Action failed: \${err.message}\`, 'error');
      }
    }

    fetchProjects();
    setInterval(fetchProjects, 5000);
  </script>
</body>
</html>`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/projects" && req.method === "GET") {
      const projects = await listAllProjects();
      return Response.json(projects);
    }

    if (url.pathname === "/api/widget" && req.method === "GET") {
      const projects = await listAllProjects();
      const running = projects.filter((p) => p.running).length;
      const indexed = projects.filter((p) => p.indexed).length;
      return Response.json({
        running,
        indexed,
        total: projects.length,
      });
    }

    if (url.pathname === "/api/action" && req.method === "POST") {
      try {
        const body = await req.json();
        const { action, project } = body;
        if (!["start", "stop", "index"].includes(action) || !project) {
          return Response.json({ success: false, output: "Invalid parameters" }, { status: 400 });
        }

        const projectPath = join(SOURCE_DIR, project);
        const result = await runManageAction(action, projectPath);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, output: err.message }, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Codebase Index Manager running at http://0.0.0.0:${PORT}`);
