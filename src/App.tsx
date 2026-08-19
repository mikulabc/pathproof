import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardCopy,
  Clock3,
  Cookie,
  ExternalLink,
  Eye,
  EyeOff,
  FileCheck2,
  Globe2,
  LayoutDashboard,
  LayoutGrid,
  List,
  LoaderCircle,
  Maximize2,
  Menu,
  Minimize2,
  MonitorPlay,
  Pencil,
  Pause,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  TestTube2,
  Trash2,
  Upload,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { FormEvent, ReactNode, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HelpButton, type HelpTopic, useHelp, useStartHere } from './help';
import type { BrowserCookie, DashboardProject, PathproofRecording, ProjectDetail, Run, RunEvent, TestDefinition, TestFileAttachment } from './shared';

type Toast = { id: number; tone: 'success' | 'error' | 'info'; message: string };
type ApiErrorBody = { error?: string | { code?: string; message?: string }; message?: string };
type OriginResolution =
  | { status: 'idle' }
  | { status: 'resolving' }
  | { status: 'resolved'; origin: string }
  | { status: 'error'; message: string };

const originResolutionError = 'We couldn’t find a working website for that domain. Check the spelling or paste its full URL.';

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const replayEventTime = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZoneName: 'short',
});
const playbackSpeedOptions = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const cookieExportScript = `(() => {
  const cookies = document.cookie.split(';').flatMap(part => {
    const i = part.indexOf('=');
    if (i < 1) return [];
    return [{
      name: part.slice(0, i).trim(),
      value: part.slice(i + 1).trim(),
      domain: location.hostname,
      path: '/',
      secure: location.protocol === 'https:'
    }];
  });
  const json = JSON.stringify(cookies, null, 2);
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('') + '_' + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
  const domain = location.hostname.replace(/[^a-z0-9.-]+/gi, '_');
  const filename = 'Import_cookie_set_' + domain + '_' + timestamp + '.json';
  const downloadUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const download = document.createElement('a');
  download.href = downloadUrl;
  download.download = filename;
  document.body.appendChild(download);
  download.click();
  download.remove();
  URL.revokeObjectURL(downloadUrl);
  console.log(json);
})();`;

function runDisplayName(run: Run, runs: Run[]): string {
  if (run.name) return run.name;
  if (run.kind === 'discovery') return 'First-run setup';
  const ordered = runs.filter((candidate) => candidate.kind === 'replay')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return `Saved test replay ${Math.max(1, ordered.findIndex((candidate) => candidate.id === run.id) + 1)}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => null) as ApiErrorBody | null;
  const errorMessage = typeof body?.error === 'string' ? body.error : body?.error?.message;
  const errorCode = typeof body?.error === 'object' ? body.error.code : undefined;
  if (!response.ok) throw new ApiRequestError(errorMessage || body?.message || `Request failed (${response.status})`, response.status, errorCode);
  return body as T;
}

function resolvedHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function projectFormError(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error) || !reason.message) return fallback;
  if (/valid absolute url|target hostname|hostname could not|private or reserved network|localhost targets|only http|urls? containing credentials|getaddrinfo|enotfound|dns/i.test(reason.message)) {
    return originResolutionError;
  }
  return reason.message;
}

function useOriginResolver(initialOrigin = '') {
  const [origin, setOriginValue] = useState(initialOrigin);
  const [resolution, setResolution] = useState<OriginResolution>({ status: 'idle' });
  const originRef = useRef(initialOrigin);
  const confirmedRef = useRef<{ input: string; origin: string } | null>(
    initialOrigin ? { input: initialOrigin, origin: initialOrigin } : null,
  );
  const requestSequenceRef = useRef(0);
  const inFlightRef = useRef<{ input: string; promise: Promise<string | null> } | null>(null);

  const setOrigin = useCallback((next: string) => {
    originRef.current = next;
    setOriginValue(next);
    requestSequenceRef.current += 1;
    const confirmed = confirmedRef.current;
    setResolution(confirmed && next.trim() === confirmed.origin
      ? { status: 'resolved', origin: confirmed.origin }
      : { status: 'idle' });
  }, []);

  const resolveOrigin = useCallback(async (value?: string): Promise<string | null> => {
    const input = (value ?? originRef.current).trim();
    if (!input) {
      requestSequenceRef.current += 1;
      setResolution({ status: 'error', message: 'Enter a website domain to continue.' });
      return null;
    }

    const confirmed = confirmedRef.current;
    if (confirmed && (input === confirmed.input || input === confirmed.origin)) {
      if (originRef.current.trim() === input) {
        originRef.current = confirmed.origin;
        setOriginValue(confirmed.origin);
        setResolution({ status: 'resolved', origin: confirmed.origin });
      }
      return confirmed.origin;
    }
    if (inFlightRef.current?.input === input) return inFlightRef.current.promise;

    const requestId = ++requestSequenceRef.current;
    setResolution({ status: 'resolving' });
    const promise = (async () => {
      try {
        const response = await api<{ origin: string }>('/api/origins/resolve', {
          method: 'POST',
          body: JSON.stringify({ input }),
        });
        const canonical = resolvedHttpOrigin(response.origin);
        if (!canonical) throw new Error('The resolver returned an invalid origin.');
        if (requestSequenceRef.current === requestId && originRef.current.trim() === input) {
          confirmedRef.current = { input, origin: canonical };
          originRef.current = canonical;
          setOriginValue(canonical);
          setResolution({ status: 'resolved', origin: canonical });
        }
        return canonical;
      } catch {
        if (requestSequenceRef.current === requestId && originRef.current.trim() === input) {
          setResolution({ status: 'error', message: originResolutionError });
        }
        return null;
      } finally {
        if (inFlightRef.current?.input === input) inFlightRef.current = null;
      }
    })();
    inFlightRef.current = { input, promise };
    return promise;
  }, []);

  return { origin, originRef, resolution, setOrigin, resolveOrigin };
}

async function startSavedRun(testId: string, playbackSpeed = 1): Promise<Run> {
  const init = { method: 'POST', body: JSON.stringify({ playbackSpeed }) } satisfies RequestInit;
  try {
    return unwrapRun(await api<Run | { run: Run }>(`/api/tests/${encodeURIComponent(testId)}/run`, init));
  } catch (reason) {
    // Accept the plural form used by older Pathproof runners during migration.
    if (!(reason instanceof ApiRequestError) || reason.status !== 404) throw reason;
    return unwrapRun(await api<Run | { run: Run }>(`/api/tests/${encodeURIComponent(testId)}/runs`, init));
  }
}

function unwrapProjects(value: DashboardProject[] | { projects: DashboardProject[] }) {
  return Array.isArray(value) ? value : value.projects;
}

async function getDashboard(): Promise<DashboardProject[]> {
  try {
    return unwrapProjects(await api<DashboardProject[] | { projects: DashboardProject[] }>('/api/dashboard'));
  } catch (reason) {
    if (!(reason instanceof ApiRequestError) || reason.status !== 404) throw reason;
    return unwrapProjects(await api<DashboardProject[] | { projects: DashboardProject[] }>('/api/projects'));
  }
}

function unwrapProject(value: ProjectDetail | { detail: ProjectDetail }) {
  return 'detail' in value ? value.detail : value;
}

function unwrapRun(value: Run | { run: Run }) {
  return 'run' in value ? value.run : value;
}

function runFromResponse(value: unknown): Run | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as { run?: Run; id?: string; status?: string };
  if (object.run) return object.run;
  if (object.id && object.status) return object as Run;
  return undefined;
}

function navigate(path: string) {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const handler = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  return path;
}

function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) {
  return <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function App() {
  const path = usePath();
  const [menuOpen, setMenuOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [runnerHealth, setRunnerHealth] = useState<'checking' | 'ready' | 'offline'>('checking');
  const [extensionOpen, setExtensionOpen] = useState(false);
  const projectMatch = path.match(/^\/projects\/([^/]+)$/);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try { await api('/api/health'); if (active) setRunnerHealth('ready'); }
      catch { if (active) setRunnerHealth('offline'); }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, tone, message }]);
    window.setTimeout(() => setToasts((items) => items.filter((toast) => toast.id !== id)), 4200);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => navigate('/')} aria-label="Pathproof dashboard">
          <span className="brand-mark"><ShieldCheck size={19} strokeWidth={2.5} /></span>
          <span>pathproof</span>
        </button>
        <nav className={menuOpen ? 'main-nav is-open' : 'main-nav'} aria-label="Main navigation">
          <button type="button" className={path === '/' ? 'nav-link active' : 'nav-link'} onClick={() => { navigate('/'); setMenuOpen(false); }}>
            <LayoutDashboard size={16} /> Projects
          </button>
        </nav>
        <div className="topbar-actions">
          <button type="button" className="chrome-extension-button" onClick={() => setExtensionOpen(true)}><Puzzle size={16} /><span>Chrome Extension</span></button>
          <HelpButton topic="overview" label="Help" className="global-help" />
          <div className="health-with-help"><span className={`system-health ${runnerHealth}`}><span /> {runnerHealth === 'ready' ? 'Runner ready' : runnerHealth === 'offline' ? 'Runner unavailable' : 'Checking runner'}</span><HelpButton topic="runnerStatus" /></div>
          <IconButton label="Open navigation" onClick={() => setMenuOpen((open) => !open)}><Menu size={20} /></IconButton>
        </div>
      </header>

      <main>
        {projectMatch ? (
          <ProjectWorkspace key={projectMatch[1]} projectId={decodeURIComponent(projectMatch[1])} notify={notify} />
        ) : (
          <Dashboard notify={notify} />
        )}
      </main>
      {extensionOpen && <ChromeExtensionModal onClose={() => setExtensionOpen(false)} />}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast ${toast.tone}`} key={toast.id}>
            {toast.tone === 'success' ? <CheckCircle2 size={18} /> : toast.tone === 'error' ? <AlertCircle size={18} /> : <Activity size={18} />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Dashboard({ notify }: { notify: (message: string, tone?: Toast['tone']) => void }) {
  const startHere = useStartHere();
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [renamingProject, setRenamingProject] = useState<DashboardProject | null>(null);
  const [deletingProjects, setDeletingProjects] = useState<DashboardProject[] | null>(null);
  const [batching, setBatching] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setProjects(await getDashboard());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load projects');
    } finally { if (!quiet) setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [query]);
  useEffect(() => {
    if (!projects.some((project) => project.status === 'running' || project.lastRun?.status === 'running' || project.lastRun?.status === 'queued')) return;
    const timer = window.setInterval(() => void load(true), 1600);
    return () => window.clearInterval(timer);
  }, [projects, load]);

  const shown = useMemo(() => projects.filter((project) =>
    `${project.name} ${project.origin}`.toLowerCase().includes(query.toLowerCase()),
  ), [projects, query]);
  const allShownSelected = shown.length > 0 && shown.every((project) => selected.has(project.id));
  const someShownSelected = shown.some((project) => selected.has(project.id)) && !allShownSelected;
  const running = projects.filter((project) => project.status === 'running' || ['queued', 'running'].includes(project.lastRun?.status || '')).length;
  const readyTests = projects.reduce((total, project) => total + project.readyTests, 0);
  const selectedProjects = useMemo(() => projects.filter((project) => selected.has(project.id)), [projects, selected]);
  const selectedReadyTests = selectedProjects.reduce((total, project) => total + project.readyTests, 0);
  const selectedProjectsBusy = selectedProjects.some((project) => project.status === 'running' || ['queued', 'running'].includes(project.lastRun?.status || ''));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allShownSelected) shown.forEach((project) => next.delete(project.id));
      else shown.forEach((project) => next.add(project.id));
      return next;
    });
  }

  async function runBatch() {
    if (!selected.size || !selectedReadyTests) return;
    setBatching(true);
    try {
      await api('/api/batches', { method: 'POST', body: JSON.stringify({ projectIds: [...selected] }) });
      notify(`${selectedReadyTests} saved ${selectedReadyTests === 1 ? 'test' : 'tests'} queued`, 'success');
      setSelected(new Set());
      await load(true);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not start batch', 'error');
    } finally { setBatching(false); }
  }

  return (
    <div className="page dashboard-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow"><Zap size={13} /> AUTOMATED WEBSITE TESTING</p>
          <h1>Website projects</h1>
          <p>Set up journey(s) with AI or the Chrome Extension once, then rerun the same checks after every release.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={17} /> Add website</button>
      </section>

      {!loading && !error && !startHere.hidden && <GettingStarted projects={projects} readyTests={readyTests} running={running} onHide={startHere.hide} />}

      {loading ? <section className="panel"><LoadingState label="Loading your projects" /></section> : error ? <section className="panel"><ErrorState message={error} retry={() => void load()} /></section> : projects.length > 0 ? <>
        <section className="metrics" aria-label="Workspace summary">
          <Metric icon={<Globe2 size={18} />} value={projects.length} label="Projects" />
          <Metric icon={<FileCheck2 size={18} />} value={readyTests} label="Tests ready to rerun" />
          <Metric icon={<MonitorPlay size={18} />} value={running} label="Running now" pulse={running > 0} />
        </section>

        <section className="panel project-panel">
          <div className="panel-heading-row"><div><h2>Projects</h2><p>Choose one website or select several for a release check.</p></div></div>
          <div className="panel-toolbar">
            <label className="search-field"><Search size={17} /><span className="sr-only">Search projects</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by website or domain" /></label>
            <div className="toolbar-actions">
              {selected.size > 0 && <span className="selection-count">{selected.size} selected · {selectedReadyTests} {selectedReadyTests === 1 ? 'test' : 'tests'} ready</span>}
              <ActionWithHelp topic="runSelected" className="run-selected-action"><button type="button" className="subtle-button" disabled={!selectedReadyTests || batching} onClick={() => void runBatch()}>
                {batching ? <LoaderCircle className="spin" size={16} /> : <Play size={15} fill="currentColor" />} Run selected {selected.size ? `(${selected.size})` : ''}
              </button></ActionWithHelp>
              {selectedProjects.length === 1 && <button type="button" className="subtle-button" onClick={() => setRenamingProject(selectedProjects[0])}><Pencil size={15} /> Rename</button>}
              {selectedProjects.length > 0 && <button type="button" className="danger-button" disabled={selectedProjectsBusy} title={selectedProjectsBusy ? 'Wait for active runs to finish before deleting these projects.' : undefined} onClick={() => setDeletingProjects(selectedProjects)}><Trash2 size={15} /> Delete {selectedProjects.length > 1 ? `(${selectedProjects.length})` : ''}</button>}
              <IconButton label="Refresh projects" onClick={() => void load()}><RefreshCw size={17} /></IconButton>
            </div>
          </div>

          {shown.length > 0 && <div className="mobile-select-all"><Checkbox checked={allShownSelected} indeterminate={someShownSelected} onChange={toggleAll} label="Select all visible projects" /><span>Select all {shown.length} visible {shown.length === 1 ? 'project' : 'projects'}</span></div>}

          {shown.length === 0 ? <EmptyState icon={<Search size={27} />} title="No matching projects" copy="Try a different project name or domain." /> : <>
            <div className="project-table-wrap desktop-project-list">
              <table className="project-table">
                <thead><tr>
                  <th className="check-cell"><Checkbox checked={allShownSelected} indeterminate={someShownSelected} onChange={toggleAll} label="Select all visible projects" /></th>
                  <th><ColumnHelp label="Project" topic="projectColumn" /></th><th><ColumnHelp label="Status" topic="statusColumn" /></th><th><ColumnHelp label="Ready tests" topic="testsColumn" /></th><th><ColumnHelp label="Latest result" topic="lastRunColumn" /></th><th><ColumnHelp label="Progress" topic="progressColumn" /></th><th><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>{shown.map((project) => <ProjectTableRow key={project.id} project={project} selected={selected.has(project.id)} onToggle={() => toggle(project.id)} />)}</tbody>
              </table>
            </div>
            <div className="mobile-project-list" aria-label="Projects">{shown.map((project) => <ProjectMobileCard key={project.id} project={project} selected={selected.has(project.id)} onToggle={() => toggle(project.id)} />)}</div>
          </>}
        </section>
      </> : null}
      {createOpen && <CreateProjectModal onClose={() => setCreateOpen(false)} onCreated={(project) => { setCreateOpen(false); notify('Project created', 'success'); navigate(`/projects/${encodeURIComponent(project.id)}`); }} />}
      {renamingProject && <RenameProjectModal project={renamingProject} onClose={() => setRenamingProject(null)} onSaved={(project) => {
        setProjects((current) => current.map((candidate) => candidate.id === project.id ? { ...candidate, ...project } : candidate));
        setRenamingProject(null);
        notify('Project renamed', 'success');
      }} />}
      {deletingProjects && <DeleteConfirmationModal
        title={deletingProjects.length === 1 ? 'Delete project' : 'Delete selected projects'}
        heading={deletingProjects.length === 1 ? `Delete “${deletingProjects[0].name}”?` : `Delete ${deletingProjects.length} projects?`}
        copy="This permanently removes the selected projects, their imported recordings, automated tests, replay history, and saved frames."
        itemNames={deletingProjects.map((project) => project.name)}
        confirmLabel={deletingProjects.length === 1 ? 'Delete project' : `Delete ${deletingProjects.length} projects`}
        onClose={() => setDeletingProjects(null)}
        onConfirm={async () => {
          const ids = deletingProjects.map((project) => project.id);
          await api<{ deleted: number }>('/api/projects/bulk-delete', { method: 'POST', body: JSON.stringify({ projectIds: ids }) });
          setProjects((current) => current.filter((project) => !ids.includes(project.id)));
          setSelected(new Set());
          setDeletingProjects(null);
          notify(`${ids.length} ${ids.length === 1 ? 'project' : 'projects'} deleted`, 'success');
        }}
      />}
    </div>
  );
}

function GettingStarted({ projects, readyTests, running, onHide }: { projects: DashboardProject[]; readyTests: number; running: number; onHide: () => void }) {
  const current = projects.length === 0 ? 0 : readyTests === 0 ? 1 : 2;
  const nextCopy = current === 0 ? 'Add a website to create its workspace.' : current === 1 ? 'Open a project and choose its important starting pages.' : running > 0 ? 'Your checks are running. You can open a project to watch live.' : '';
  return <section className="getting-started" aria-label="START HERE">
    <div className="guide-intro">
      <span className="guide-kicker"><Sparkles size={15} /> START HERE</span>
      {nextCopy && <p>{nextCopy}</p>}
    </div>
    <ol className="guide-steps">
      <li className={current === 0 ? 'current' : current > 0 ? 'complete' : ''}><span>{current > 0 ? <Check size={15} /> : '1'}</span><div><strong>Add a website</strong><small>Create one workspace per domain.</small></div></li>
      <li className={current === 1 ? 'current' : current > 1 ? 'complete' : ''}><span>{current > 1 ? <Check size={15} /> : '2'}</span><div><strong>Run first-time setup</strong><small>Choose pages and let Pathproof learn safe checks.</small></div></li>
      <li className={current === 2 ? 'current' : ''}><span>3</span><div><strong>Rerun after releases</strong><small>Use the saved plan without AI.</small></div></li>
    </ol>
    <div className="guide-side-actions">{current === 1 && projects[0] && <button type="button" className="guide-action" onClick={() => navigate(`/projects/${encodeURIComponent(projects[0].id)}`)}>Set up the first test <ArrowRight size={16} /></button>}<IconButton label="Hide START HERE" onClick={onHide}><X size={18} /></IconButton></div>
  </section>;
}

function ProjectTableRow({ project, selected, onToggle }: { project: DashboardProject; selected: boolean; onToggle: () => void }) {
  const latest = project.lastRun;
  const active = latest && ['queued', 'running'].includes(latest.status);
  return <tr className={selected ? 'selected-row' : ''}>
    <td className="check-cell"><Checkbox checked={selected} onChange={onToggle} label={`Select ${project.name}`} /></td>
    <td><a className="project-identity" href={`/projects/${encodeURIComponent(project.id)}`} onClick={(event) => { event.preventDefault(); navigate(`/projects/${encodeURIComponent(project.id)}`); }}>
      <span className="project-favicon">{project.name.slice(0, 1).toUpperCase()}</span>
      <span><strong>{project.name}</strong><small>{project.origin.replace(/^https?:\/\//, '')}</small></span>
    </a></td>
    <td><ProjectBadge project={project} /></td>
    <td><strong>{project.readyTests}</strong><span className="muted"> / {project.tests} ready</span></td>
    <td>{project.lastRunAt ? <><span>{dateTime.format(new Date(project.lastRunAt))}</span>{latest && <small className={`run-result ${latest.status}`}>{latest.status}</small>}</> : <span className="muted">Not run yet</span>}</td>
    <td>{active ? <div className="table-progress"><div role="progressbar" aria-label={`${project.name} run progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={latest.progress}><span style={{ width: `${latest.progress}%` }} /></div><small>{latest.progress}% · {latest.currentAction || 'Starting runner'}</small></div> : <span className="muted">—</span>}</td>
    <td><div className="row-actions"><IconButton label={`Open ${project.name}`} onClick={() => navigate(`/projects/${encodeURIComponent(project.id)}`)}><ChevronRight size={18} /></IconButton></div></td>
  </tr>;
}

function ProjectMobileCard({ project, selected, onToggle }: { project: DashboardProject; selected: boolean; onToggle: () => void }) {
  const latest = project.lastRun;
  const active = latest && ['queued', 'running'].includes(latest.status);
  return <article className={`mobile-project-card ${selected ? 'selected' : ''}`}>
    <div className="mobile-project-head"><Checkbox checked={selected} onChange={onToggle} label={`Select ${project.name}`} /><span className="project-favicon">{project.name.slice(0, 1).toUpperCase()}</span><div><strong>{project.name}</strong><small>{project.origin.replace(/^https?:\/\//, '')}</small></div></div>
    <div className="mobile-project-status"><ProjectBadge project={project} /><span>{project.readyTests} of {project.tests} tests ready</span></div>
    <dl><div><dt>Latest result</dt><dd>{latest ? <span className={`mobile-result ${latest.status}`}>{latest.status}</span> : 'Not run yet'}</dd></div><div><dt>Last activity</dt><dd>{project.lastRunAt ? dateTime.format(new Date(project.lastRunAt)) : '—'}</dd></div></dl>
    {active && <div className="table-progress mobile-progress"><div role="progressbar" aria-label={`${project.name} run progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={latest.progress}><span style={{ width: `${latest.progress}%` }} /></div><small>{latest.progress}% · {latest.currentAction || 'Starting runner'}</small></div>}
    <button type="button" className="open-project-button" onClick={() => navigate(`/projects/${encodeURIComponent(project.id)}`)}>Open project <ArrowRight size={16} /></button>
  </article>;
}

function ActionWithHelp({ topic, context, children, className = '' }: { topic: HelpTopic; context?: string; children: ReactNode; className?: string }) {
  return <span className={`action-with-help ${className}`.trim()}>{children}<HelpButton topic={topic} context={context} /></span>;
}

function ColumnHelp({ label, topic }: { label: string; topic: HelpTopic }) {
  return <span className="column-help"><span>{label}</span><HelpButton topic={topic} /></span>;
}

function ProjectWorkspace({ projectId, notify }: { projectId: string; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deletingTests, setDeletingTests] = useState<TestDefinition[] | null>(null);
  const [deletingRuns, setDeletingRuns] = useState<Run[] | null>(null);
  const [selectedTestIds, setSelectedTestIds] = useState<Set<string>>(new Set());
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [recordingView, setRecordingViewState] = useState<'boxed' | 'list'>(() =>
    window.localStorage.getItem('pathproof-recording-view') === 'list' ? 'list' : 'boxed',
  );
  const [renamingRecordingId, setRenamingRecordingId] = useState<string | null>(null);
  const [recordingNameDraft, setRecordingNameDraft] = useState('');
  const [savingRecordingName, setSavingRecordingName] = useState(false);
  const [editingCookiesRecording, setEditingCookiesRecording] = useState<TestDefinition | null>(null);
  const [playbackSpeeds, setPlaybackSpeeds] = useState<Record<string, number>>({});
  const [startingSelectedTests, setStartingSelectedTests] = useState(false);
  const [renamingRunId, setRenamingRunId] = useState<string | null>(null);
  const [runNameDraft, setRunNameDraft] = useState('');
  const [savingRunName, setSavingRunName] = useState(false);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const value = await api<ProjectDetail | { detail: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}`);
      const next = unwrapProject(value);
      setDetail(next);
      setSelectedTestIds((current) => new Set([...current].filter((id) => next.tests.some((test) => test.id === id))));
      setSelectedRunIds((current) => new Set([...current].filter((id) => next.runs.slice(0, 6).some((run) => run.id === id))));
      setError('');
      if (!activeRun) {
        const running = next.runs.find((run) => ['queued', 'running'].includes(run.status));
        if (running) { setActiveRun(running); setPanelOpen(true); }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load project');
    } finally { if (!quiet) setLoading(false); }
  }, [projectId, activeRun]);

  useEffect(() => { void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateRun = useCallback((run: Run) => {
    setActiveRun(run);
    setDetail((current) => current ? { ...current, runs: [run, ...current.runs.filter((item) => item.id !== run.id)] } : current);
  }, []);

  useEffect(() => {
    if (activeRun && !['queued', 'running'].includes(activeRun.status)) void load(true);
  }, [activeRun?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startTest(test: TestDefinition) {
    try {
      const playbackSpeed = playbackSpeeds[test.id] ?? 1;
      const run = await startSavedRun(test.id, playbackSpeed);
      updateRun(run); setPanelOpen(true);
      notify(`Running “${test.name}” at ${playbackSpeed}×`, 'info');
    } catch (reason) { notify(reason instanceof Error ? reason.message : 'Could not start test', 'error'); }
  }

  async function startSelectedTests() {
    if (selectedReadyTests.length === 0) return;
    setStartingSelectedTests(true);
    try {
      const testIds = selectedReadyTests.map((test) => test.id);
      const selectedPlaybackSpeeds = Object.fromEntries(testIds.map((id) => [id, playbackSpeeds[id] ?? 1]));
      const { runs } = await api<{ runs: Run[] }>('/api/runs/bulk', {
        method: 'POST', body: JSON.stringify({ testIds, playbackSpeeds: selectedPlaybackSpeeds }),
      });
      setDetail((current) => current ? {
        ...current,
        runs: [...runs, ...current.runs.filter((run) => !runs.some((started) => started.id === run.id))],
      } : current);
      if (runs[0]) {
        setActiveRun(runs[0]);
        setPanelOpen(true);
      }
      notify(`Queued ${runs.length} selected ${runs.length === 1 ? 'test' : 'tests'}`, 'success');
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not run the selected tests', 'error');
    } finally {
      setStartingSelectedTests(false);
    }
  }

  function setRecordingView(view: 'boxed' | 'list') {
    setRecordingViewState(view);
    window.localStorage.setItem('pathproof-recording-view', view);
  }

  function toggleTest(id: string) {
    setSelectedTestIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleRun(id: string) {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function startRenamingRecording(test: TestDefinition) {
    setRenamingRecordingId(test.id);
    setRecordingNameDraft(test.name);
  }

  function startRenamingRun(run: Run) {
    setRenamingRunId(run.id);
    setRunNameDraft(runDisplayName(run, detail?.runs ?? [run]));
  }

  async function saveRunName(run: Run) {
    const name = runNameDraft.trim();
    if (!name) return;
    if (name === runDisplayName(run, detail?.runs ?? [run])) {
      setRenamingRunId(null);
      return;
    }
    setSavingRunName(true);
    try {
      const updated = await api<Run>(`/api/runs/${encodeURIComponent(run.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      setDetail((current) => current ? { ...current, runs: current.runs.map((item) => item.id === updated.id ? updated : item) } : current);
      setActiveRun((current) => current?.id === updated.id ? updated : current);
      setRenamingRunId(null);
      notify('Run renamed', 'success');
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not rename this run', 'error');
    } finally {
      setSavingRunName(false);
    }
  }

  async function saveRecordingName(test: TestDefinition) {
    const name = recordingNameDraft.trim();
    if (!name || name === test.name) {
      setRenamingRecordingId(null);
      return;
    }
    setSavingRecordingName(true);
    try {
      const updated = await api<TestDefinition>(`/api/tests/${encodeURIComponent(test.id)}`, {
        method: 'PATCH', body: JSON.stringify({ name }),
      });
      setDetail((current) => current ? { ...current, tests: current.tests.map((candidate) => candidate.id === updated.id ? updated : candidate) } : current);
      setRenamingRecordingId(null);
      notify(test.source === 'recording' ? 'Recording renamed' : 'Automated test renamed', 'success');
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : 'Could not rename recording', 'error');
    } finally { setSavingRecordingName(false); }
  }

  if (loading) return <div className="page"><LoadingState label="Opening project workspace" /></div>;
  if (error || !detail) return <div className="page"><button className="back-link" type="button" onClick={() => navigate('/')}><ArrowLeft size={16} /> Projects</button><ErrorState message={error || 'Project not found'} retry={() => void load()} /></div>;

  const lastRun = detail.runs[0];
  const selectedTests = detail.tests.filter((test) => selectedTestIds.has(test.id));
  const selectedReadyTests = selectedTests.filter((test) => Boolean(test.plan));
  const allTestsSelected = detail.tests.length > 0 && selectedTests.length === detail.tests.length;
  const someTestsSelected = selectedTests.length > 0 && !allTestsSelected;
  const selectedTestsBusy = selectedTests.some((test) => detail.runs.some((run) => run.testId === test.id && ['queued', 'running'].includes(run.status)));
  const recentRuns = detail.runs.slice(0, 6);
  const selectedRuns = recentRuns.filter((run) => selectedRunIds.has(run.id));
  const allRunsSelected = recentRuns.length > 0 && selectedRuns.length === recentRuns.length;
  const someRunsSelected = selectedRuns.length > 0 && !allRunsSelected;
  const selectedRunsBusy = selectedRuns.some((run) => ['queued', 'running'].includes(run.status));
  const deletingOnlyRecordings = Boolean(deletingTests?.every((test) => test.source === 'recording'));
  return (
    <div className={`workspace ${panelOpen ? 'with-run-panel' : ''}`}>
      <div className="workspace-main">
        <div className="workspace-topline">
          <button className="back-link" type="button" onClick={() => navigate('/')}><ArrowLeft size={16} /> All projects</button>
          <span className="crumb-divider">/</span><span>{detail.project.name}</span>
        </div>
        <section className="workspace-heading">
          <div className="project-title">
            <span className="large-project-icon">{detail.project.name.slice(0, 1).toUpperCase()}</span>
            <div><h1>{detail.project.name}</h1><a href={detail.project.origin} target="_blank" rel="noreferrer">{detail.project.origin} <ExternalLink size={13} /></a></div>
          </div>
          <div className="workspace-actions">
            <button type="button" className="subtle-button" onClick={() => setEditOpen(true)}><Pencil size={15} /> Edit project</button>
            <ActionWithHelp topic="importRecording"><button type="button" className="subtle-button" onClick={() => setImportOpen(true)}><Upload size={16} /> Import recording</button></ActionWithHelp>
            <button type="button" className="primary-button" onClick={() => setDiscoveryOpen(true)}><Sparkles size={16} /> Create automated test</button>
          </div>
        </section>

        {detail.tests.length > 0 && <section className="mini-stats">
          <div><span>Tests</span><strong>{detail.tests.length}</strong></div>
          <div><span>Ready to rerun</span><strong>{detail.tests.filter((test) => Boolean(test.plan)).length}</strong></div>
          <div><span>Latest result</span><strong>{lastRun ? dateTime.format(new Date(lastRun.createdAt)) : 'Never'}</strong></div>
        </section>}

        <section className="section-block">
          <div className="section-title">
            <div><h2>Automated tests</h2><p>First-run setup learns a safe journey once. Every replay after that uses the saved Playwright plan.</p></div>
            <div className="test-section-controls">
              <span className="count-pill">{detail.tests.length}</span>
              <div className="view-toggle" role="group" aria-label="Test view">
                <button type="button" className={recordingView === 'boxed' ? 'active' : ''} aria-pressed={recordingView === 'boxed'} onClick={() => setRecordingView('boxed')}><LayoutGrid size={15} /> Grid</button>
                <button type="button" className={recordingView === 'list' ? 'active' : ''} aria-pressed={recordingView === 'list'} onClick={() => setRecordingView('list')}><List size={16} /> List</button>
              </div>
            </div>
          </div>
          {detail.tests.length > 0 && <div className="recording-selection-bar">
            <Checkbox
              checked={allTestsSelected}
              indeterminate={someTestsSelected}
              onChange={() => setSelectedTestIds(allTestsSelected ? new Set() : new Set(detail.tests.map((test) => test.id)))}
              label="Select all automated tests"
            />
            <span className="recording-select-label">Select all automated tests</span>
            {selectedTests.length > 0 && <span className="selection-count">{selectedTests.length} selected</span>}
            <div className="recording-selection-actions">
              <button type="button" className="subtle-button compact-run-selected" disabled={selectedReadyTests.length === 0 || selectedTestsBusy || startingSelectedTests} title={selectedTestsBusy ? 'Wait for active runs to finish before starting these tests again.' : selectedTests.length > 0 && selectedReadyTests.length === 0 ? 'The selected tests do not have a saved plan yet.' : undefined} onClick={() => void startSelectedTests()}>{startingSelectedTests ? <LoaderCircle className="spin" size={15} /> : <Play size={15} fill="currentColor" />} {startingSelectedTests ? 'Starting…' : 'Run selected tests'}</button>
              <button type="button" className="danger-button compact-danger" disabled={selectedTests.length === 0 || selectedTestsBusy || startingSelectedTests} title={selectedTestsBusy ? 'Wait for active runs to finish before deleting these tests.' : undefined} onClick={() => setDeletingTests(selectedTests)}><Trash2 size={15} /> Delete selected</button>
            </div>
          </div>}
          {detail.tests.length === 0 ? (
            <EmptyState icon={<TestTube2 size={29} />} title="Next: choose important starting pages" copy="Use Create automated test above. Pathproof will open those pages, explore one linked level, and save a reusable check." />
          ) : <div className={`test-list ${recordingView}-view`}>{detail.tests.map((test) => {
            const activeTestRun = detail.runs.find((run) => run.testId === test.id && ['queued', 'running'].includes(run.status));
            const testRun = activeTestRun ?? detail.runs.find((run) => run.testId === test.id);
            const isRunning = Boolean(activeTestRun);
            const isRecording = test.source === 'recording';
            const isSelected = selectedTestIds.has(test.id);
            const isRenaming = renamingRecordingId === test.id;
            const fixedCookieCount = test.browserState?.cookieHeader?.split(';').filter((part) => part.includes('=')).length ?? 0;
            const recordingCookieCount = (test.browserState?.cookies?.length ?? 0) + fixedCookieCount;
            return <article className={`test-card ${isSelected ? 'selected' : ''}`} key={test.id}>
              <div className="test-selection"><Checkbox checked={isSelected} onChange={() => toggleTest(test.id)} label={`Select test ${test.name}`} /></div>
              <div className={`test-icon ${test.status}`}><FileCheck2 size={20} /></div>
              <div className="test-copy">
                <div className="test-name-row">
                  {isRenaming ? <form className="recording-name-form" onSubmit={(event) => { event.preventDefault(); void saveRecordingName(test); }}>
                    <label className="sr-only" htmlFor={`recording-name-${test.id}`}>{isRecording ? 'Recording name' : 'Automated test name'}</label>
                    <input id={`recording-name-${test.id}`} autoFocus maxLength={120} value={recordingNameDraft} onChange={(event) => setRecordingNameDraft(event.target.value)} />
                    <button type="submit" className="icon-button save-name" aria-label={isRecording ? 'Save recording name' : 'Save automated test name'} disabled={savingRecordingName || !recordingNameDraft.trim()}>{savingRecordingName ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}</button>
                    <button type="button" className="icon-button" aria-label="Cancel renaming" disabled={savingRecordingName} onClick={() => setRenamingRecordingId(null)}><X size={16} /></button>
                  </form> : <h3>{test.name}</h3>}
                  <TestBadge test={test} />{testRun && !isRunning && <span className={`run-status ${testRun.status}`}>Latest: {testRun.status}</span>}
                  {isRecording && <button type="button" className={`recording-cookie-button ${test.recording?.hasCookies ? 'has-cookies' : ''}`} aria-label={`Edit cookies for ${test.name}`} title="Edit replay cookies" disabled={isRunning} onClick={() => setEditingCookiesRecording(test)}><Cookie size={15} /><span>{recordingCookieCount}</span></button>}
                </div>
                <p>{test.seedUrls.length} starting {test.seedUrls.length === 1 ? 'URL' : 'URLs'} <span>·</span> {test.plan?.steps.length || 0} saved steps <span>·</span> <HelpButton topic="breadth" /> {test.coverage}% discovery breadth</p>
                {test.recording && <p className="recording-meta"><span>● Recorded journey</span> · {test.recording.eventCount.toLocaleString()} captured signals · {test.recording.actionCount} replay actions · {Math.round(test.recording.durationMs / 1000)}s</p>}
                <div className="url-chips">{test.seedUrls.slice(0, 2).map((url) => <span key={url}>{url.replace(/^https?:\/\//, '')}</span>)}{test.seedUrls.length > 2 && <span>+{test.seedUrls.length - 2}</span>}</div>
                {activeTestRun && <div className="card-progress"><div role="progressbar" aria-label={`${test.name} run progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={activeTestRun.progress}><span style={{ width: `${activeTestRun.progress}%` }} /></div><small>{activeTestRun.currentAction || 'Preparing browser'} · {activeTestRun.progress}%</small></div>}
              </div>
              <div className="test-actions">
                <div className="test-primary-actions">
                  {test.plan && !isRunning && <label className="playback-speed-control"><span>Speed</span><select aria-label={`Playback speed for ${test.name}`} value={playbackSpeeds[test.id] ?? 1} onChange={(event) => setPlaybackSpeeds((current) => ({ ...current, [test.id]: Number(event.target.value) }))}>{playbackSpeedOptions.map((speed) => <option value={speed} key={speed}>{speed}×</option>)}</select></label>}
                  {test.status === 'discovering' || isRunning ? (
                    <button type="button" className="subtle-button" onClick={() => { if (testRun) { setActiveRun(testRun); setPanelOpen(true); } }}><Eye size={16} /> Watch live</button>
                  ) : test.plan ? (
                    <button type="button" className="run-button" onClick={() => void startTest(test)}><Play size={15} fill="currentColor" /> Run saved test</button>
                  ) : (
                    <button type="button" className="subtle-button" onClick={() => setDiscoveryOpen(true)}><RefreshCw size={15} /> Create replacement</button>
                  )}
                </div>
                <div className="test-secondary-actions">
                  {testRun && !isRunning && <button type="button" className="text-button" onClick={() => { setActiveRun(testRun); setPanelOpen(true); }}>View report <ArrowRight size={14} /></button>}
                  <button type="button" className="icon-button test-entry-icon-action rename-recording-button" aria-label={`Rename ${test.name}`} title="Rename" disabled={isRunning || isRenaming} onClick={() => startRenamingRecording(test)}><Pencil size={15} /></button>
                  <button type="button" className="icon-button test-entry-icon-action delete-test-button" aria-label={`Delete ${test.name}`} disabled={isRunning} title={isRunning ? 'Wait for this run to finish before deleting the test.' : 'Delete'} onClick={() => setDeletingTests([test])}><Trash2 size={15} /></button>
                </div>
              </div>
            </article>;
          })}</div>}
        </section>

        {recentRuns.length > 0 && <section className="section-block runs-section">
          <div className="section-title"><div><h2>Recent runs</h2><p>The six latest setup and replay results for this project.</p></div><span className="count-pill">{recentRuns.length}</span></div>
          <div className="recording-selection-bar run-selection-bar">
            <Checkbox checked={allRunsSelected} indeterminate={someRunsSelected} onChange={() => setSelectedRunIds(allRunsSelected ? new Set() : new Set(recentRuns.map((run) => run.id)))} label="Select all recent runs" />
            <span className="recording-select-label">Select all recent runs</span>
            {selectedRuns.length > 0 && <span className="selection-count">{selectedRuns.length} selected</span>}
            <div className="recording-selection-actions"><button type="button" className="danger-button compact-danger" disabled={selectedRuns.length === 0 || selectedRunsBusy} title={selectedRunsBusy ? 'Wait for active runs to finish before deleting them.' : undefined} onClick={() => setDeletingRuns(selectedRuns)}><Trash2 size={15} /> Delete selected runs</button></div>
          </div>
          <div className="run-list">{recentRuns.map((run) => {
            const runTitle = runDisplayName(run, detail.runs);
            const runActive = ['queued', 'running'].includes(run.status);
            const runSelected = selectedRunIds.has(run.id);
            return <div className={`run-row is-renamable ${runSelected ? 'selected' : ''}`} key={run.id}>
            <div className="run-row-selection"><Checkbox checked={runSelected} onChange={() => toggleRun(run.id)} label={`Select run ${runTitle}`} /></div>
            {renamingRunId === run.id ? <form className="run-name-form" onSubmit={(event) => { event.preventDefault(); void saveRunName(run); }}>
              <RunStatusIcon status={run.status} /><label className="sr-only" htmlFor={`run-name-${run.id}`}>Run name</label><input id={`run-name-${run.id}`} autoFocus maxLength={120} value={runNameDraft} onChange={(event) => setRunNameDraft(event.target.value)} />
              <button type="submit" className="icon-button save-name" aria-label="Save run name" disabled={savingRunName || !runNameDraft.trim()}>{savingRunName ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}</button>
              <button type="button" className="icon-button" aria-label="Cancel renaming run" disabled={savingRunName} onClick={() => setRenamingRunId(null)}><X size={16} /></button>
            </form> : <div className="run-main-button">
              <button type="button" className="run-open-overlay" aria-label={`Open ${runTitle}`} onClick={() => { setActiveRun(run); setPanelOpen(true); }} />
              <RunStatusIcon status={run.status} /><span className="run-copy"><span className="run-title-line"><strong>{runTitle}</strong><button type="button" className="run-rename-button icon-button" aria-label={`Rename ${runTitle}`} title="Rename run" onClick={() => startRenamingRun(run)}><Pencil size={15} /></button><button type="button" className="run-delete-button icon-button" aria-label={`Delete ${runTitle}`} title={runActive ? 'Wait for this run to finish before deleting it.' : 'Delete run'} disabled={runActive} onClick={() => setDeletingRuns([run])}><Trash2 size={14} /></button></span><small>{dateTime.format(new Date(run.createdAt))} · {run.aiUsed ? 'AI-assisted setup' : run.kind === 'discovery' ? 'Local setup' : 'No AI used'}</small></span><span className={`run-status ${run.status}`}>{run.status}</span><ChevronRight size={17} />
            </div>}
          </div>;
          })}</div>
        </section>}
      </div>
      {panelOpen && activeRun && <RunPanel initialRun={activeRun} onRun={updateRun} onClose={() => setPanelOpen(false)} />}
      {editOpen && <EditProjectModal project={detail.project} hasTests={detail.tests.length > 0} onClose={() => setEditOpen(false)} onSaved={(project) => { setDetail((current) => current ? { ...current, project } : current); setEditOpen(false); notify('Project updated', 'success'); }} />}
      {discoveryOpen && <DiscoveryModal project={detail} onClose={() => setDiscoveryOpen(false)} onStarted={(runs) => { setDiscoveryOpen(false); runs.forEach(updateRun); setActiveRun(runs[0]); setPanelOpen(true); notify(`${runs.length} ${runs.length === 1 ? 'automated test' : 'automated tests'} started`, 'success'); void load(true); }} />}
      {importOpen && <ImportRecordingModal project={detail} onClose={() => setImportOpen(false)} onImported={(test) => { setDetail((current) => current ? { ...current, tests: [test, ...current.tests] } : current); setImportOpen(false); notify('Recorded journey imported and ready to run', 'success'); }} />}
      {editingCookiesRecording && <CookieEditorModal test={editingCookiesRecording} onClose={() => setEditingCookiesRecording(null)} onSaved={(updated) => {
        setDetail((current) => current ? { ...current, tests: current.tests.map((test) => test.id === updated.id ? updated : test) } : current);
        setEditingCookiesRecording(null);
        notify('Recording cookies updated', 'success');
      }} />}
      {deletingTests && <DeleteConfirmationModal
        title={deletingTests.length === 1 ? 'Delete' : 'Delete selected tests'}
        heading={deletingTests.length === 1 ? `Delete “${deletingTests[0].name}”?` : `Delete ${deletingTests.length} tests?`}
        copy={deletingOnlyRecordings
          ? deletingTests.length === 1
            ? 'This removes the imported recording, its saved Playwright replay, browser state, and complete run history. The original .pathproof.json file on your computer is not changed.'
            : 'This removes the selected recordings, their saved Playwright replays, browser state, and complete run history. The original .pathproof.json files on your computer are not changed.'
          : 'This removes the selected automated tests, their saved Pathfinder steps, browser state, and complete run history.'}
        itemNames={deletingTests.length > 1 ? deletingTests.map((test) => test.name) : undefined}
        confirmLabel={deletingTests.length === 1 ? 'Delete' : `Delete ${deletingTests.length} tests`}
        onClose={() => setDeletingTests(null)}
        onConfirm={async () => {
          const testIds = deletingTests.map((test) => test.id);
          if (testIds.length === 1) await api(`/api/tests/${encodeURIComponent(testIds[0])}`, { method: 'DELETE' });
          else await api<{ deleted: number }>('/api/tests/bulk-delete', { method: 'POST', body: JSON.stringify({ testIds }) });
          setDetail((current) => current ? {
            ...current,
            tests: current.tests.filter((test) => !testIds.includes(test.id)),
            runs: current.runs.filter((run) => !testIds.includes(run.testId)),
          } : current);
          if (activeRun && testIds.includes(activeRun.testId)) { setPanelOpen(false); setActiveRun(null); }
          setSelectedTestIds(new Set());
          setSelectedRunIds(new Set());
          setDeletingTests(null);
          notify(`${testIds.length} ${testIds.length === 1 ? 'test' : 'tests'} deleted`, 'success');
        }}
      />}
      {deletingRuns && <DeleteConfirmationModal
        title={deletingRuns.length === 1 ? 'Delete run' : 'Delete selected runs'}
        heading={deletingRuns.length === 1 ? `Delete “${runDisplayName(deletingRuns[0], detail.runs)}”?` : `Delete ${deletingRuns.length} runs?`}
        copy="This removes only the selected run history, evidence, and saved browser frame. The automated test and its reusable Pathfinder steps remain available."
        itemNames={deletingRuns.length > 1 ? deletingRuns.map((run) => runDisplayName(run, detail.runs)) : undefined}
        confirmLabel={deletingRuns.length === 1 ? 'Delete run' : `Delete ${deletingRuns.length} runs`}
        onClose={() => setDeletingRuns(null)}
        onConfirm={async () => {
          const runIds = deletingRuns.map((run) => run.id);
          if (runIds.length === 1) await api(`/api/runs/${encodeURIComponent(runIds[0])}`, { method: 'DELETE' });
          else await api<{ deleted: number }>('/api/runs/bulk-delete', { method: 'POST', body: JSON.stringify({ runIds }) });
          setDetail((current) => current ? { ...current, runs: current.runs.filter((run) => !runIds.includes(run.id)) } : current);
          if (activeRun && runIds.includes(activeRun.id)) { setPanelOpen(false); setActiveRun(null); }
          setSelectedRunIds(new Set());
          setDeletingRuns(null);
          notify(`${runIds.length} ${runIds.length === 1 ? 'run' : 'runs'} deleted`, 'success');
        }}
      />}
    </div>
  );
}

function RunPanel({ initialRun, onRun, onClose }: { initialRun: Run; onRun: (run: Run) => void; onClose: () => void }) {
  const [run, setRun] = useState(initialRun);
  const [frameFailed, setFrameFailed] = useState(false);
  const [followLogs, setFollowLogs] = useState(false);
  const [playerExpanded, setPlayerExpanded] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState('');
  const eventsEnd = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const active = ['queued', 'running'].includes(run.status);
  useOverlayFocus(panelRef, () => playerExpanded ? setPlayerExpanded(false) : onClose());

  useEffect(() => { setRun(initialRun); setFrameFailed(false); setFollowLogs(false); setPlayerExpanded(false); setControlError(''); }, [initialRun.id]);
  useEffect(() => { setFrameFailed(false); }, [run.frameVersion]);
  useEffect(() => { setFrameFailed(false); }, [active]);
  useEffect(() => {
    document.body.classList.toggle('replay-expanded', playerExpanded);
    return () => document.body.classList.remove('replay-expanded');
  }, [playerExpanded]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await api<Run | { run: Run }>(`/api/runs/${encodeURIComponent(run.id)}`);
        if (cancelled) return;
        const next = unwrapRun(response);
        setRun(next); onRun(next);
      } catch { /* Keep the last known frame while the runner reconnects. */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1100);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [run.id, active, onRun]);
  useEffect(() => { if (followLogs) eventsEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [run.events.length, followLogs]);

  function toggleFollowLogs() {
    setFollowLogs((following) => {
      const next = !following;
      if (next) window.requestAnimationFrame(() => eventsEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      return next;
    });
  }

  async function controlRun(action: 'pause' | 'resume' | 'stop') {
    setControlBusy(true);
    setControlError('');
    try {
      const updated = await api<Run>(`/api/runs/${encodeURIComponent(run.id)}/control`, { method: 'POST', body: JSON.stringify({ action }) });
      setRun(updated);
      onRun(updated);
    } catch (reason) {
      setControlError(reason instanceof Error ? reason.message : 'Could not control this run.');
    } finally {
      setControlBusy(false);
    }
  }

  async function replayAgain() {
    setControlBusy(true);
    setControlError('');
    try {
      const response = await api<Run | { run: Run }>(`/api/tests/${encodeURIComponent(run.testId)}/run`, { method: 'POST', body: JSON.stringify({ playbackSpeed: run.playbackSpeed ?? 1 }) });
      const next = unwrapRun(response);
      setRun(next);
      onRun(next);
      setFrameFailed(false);
      setFollowLogs(false);
      setPlayerExpanded(false);
    } catch (reason) {
      setControlError(reason instanceof Error ? reason.message : 'Could not replay this test.');
    } finally {
      setControlBusy(false);
    }
  }

  const paused = run.controlState === 'paused';
  const replayReady = !active && run.status === 'passed' && run.progress === 100;
  const viewerStatus = active ? paused ? 'Paused' : 'Watching live' : run.status === 'passed' && run.progress === 100 ? 'Finished' : run.status === 'interrupted' ? 'Stopped' : 'Failed';

  return <aside ref={panelRef} className={`run-panel ${playerExpanded ? 'is-player-expanded' : ''}`} data-overlay role="dialog" aria-modal="true" aria-label={active ? 'Live browser' : 'Run report'} tabIndex={-1}>
    <div className="run-panel-header">
      <div><p className="eyebrow">{active ? <><span className="live-dot" /> {run.kind === 'discovery' ? 'FIRST-RUN SETUP' : 'TEST REPLAY'}</> : run.kind === 'discovery' ? 'SETUP RESULT' : 'REPLAY RESULT'}</p><div className="heading-with-help"><h2>{active ? 'Live browser' : 'Run report'}</h2><HelpButton topic="runPanel" /></div></div>
      <div className="run-panel-header-actions">
        {active && <button type="button" className="run-control-button" disabled={controlBusy} onClick={() => void controlRun(paused ? 'resume' : 'pause')}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? 'Resume' : 'Pause'}</button>}
        {active && <button type="button" className="run-control-button stop" disabled={controlBusy} onClick={() => void controlRun('stop')}><Square size={13} />Stop</button>}
        {replayReady && <button type="button" className="run-control-button replay-again" disabled={controlBusy} onClick={() => void replayAgain()}><RefreshCw size={14} />Re-play again</button>}
        <a className="icon-button" href={`/api/runs/${encodeURIComponent(run.id)}/pathfinder-steps`} download aria-label="Download pathfinder steps" title="Download pathfinder steps"><ArrowDownToLine size={19} /></a>
        <IconButton label="Close run panel" onClick={onClose}><X size={19} /></IconButton>
      </div>
    </div>
    <div className="run-overview">
      {controlError && <p className="run-control-error"><AlertCircle size={14} />{controlError}</p>}
      <div className="progress-heading"><span>{run.currentAction || (active ? 'Starting browser…' : `Run ${run.status}`)}</span><span><strong>{run.progress}%</strong></span></div>
      <div className="large-progress" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.progress}><span style={{ width: `${run.progress}%` }} /></div>
      <div className="run-meta"><span><Bot size={14} /> {run.aiUsed ? 'AI-assisted setup' : run.kind === 'discovery' ? 'Local first-run setup' : `Saved plan · no AI · ${run.playbackSpeed ?? 1}×`} <HelpButton topic="runMode" /></span><span><Clock3 size={14} /> {run.durationMs ? formatDuration(run.durationMs) : 'In progress'}</span></div>
    </div>
    <div className={`browser-frame ${playerExpanded ? 'expanded' : ''}`}>
      <div className="browser-bar"><i /><i /><i /><span><Globe2 size={12} />{run.currentUrl || 'Waiting for navigation'}</span>{active && <b className={`stream-indicator ${paused ? 'paused' : ''}`}><span /> {paused ? 'PAUSED' : 'RUNNING'}</b>}<b className="expanded-progress" aria-hidden={!playerExpanded}>{run.progress}%</b><button type="button" className="replay-expand-button" aria-label={playerExpanded ? 'Exit expanded replay view' : 'Expand replay view in this tab'} aria-pressed={playerExpanded} onClick={() => setPlayerExpanded((expanded) => !expanded)}>{playerExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></div>
      <div className="frame-body">
        {frameFailed ? <div className="frame-placeholder"><MonitorPlay size={34} /><strong>Browser stream unavailable</strong><span>Live actions are still shown below.</span></div> : <img key={active ? `stream-${run.id}` : `frame-${run.frameVersion}`} src={active ? `/api/runs/${encodeURIComponent(run.id)}/stream` : `/api/runs/${encodeURIComponent(run.id)}/frame?v=${run.frameVersion}`} alt={active ? 'Live browser stream' : 'Final browser view'} onError={() => setFrameFailed(true)} />}
        <span className={`watching-badge ${active ? 'live' : 'finished'}`}>{active ? <Eye size={13} /> : run.status === 'passed' ? <Check size={13} /> : <Square size={11} />} {viewerStatus}</span>
      </div>
    </div>
    {!active && <RunSummary run={run} />}
    <div className="event-section">
      <div className="event-heading"><h3>{active ? 'Activity' : 'Checked steps & evidence'}</h3><div className="event-heading-actions"><span>{run.events.length} events</span><button type="button" className={`follow-logs-button ${followLogs ? 'is-following' : ''}`} aria-pressed={followLogs} onClick={toggleFollowLogs}>{followLogs ? <Pause size={13} /> : <ArrowDownToLine size={13} />}{followLogs ? 'Unfollow logs' : 'Follow logs'}</button></div></div>
      <div className="event-list">{run.events.length === 0 ? <p className="waiting-copy"><LoaderCircle className="spin" size={16} /> Runner is getting ready…</p> : run.events.map((event) => <EventRow key={event.id} event={event} />)}<div ref={eventsEnd} /></div>
    </div>
  </aside>;
}

function RunSummary({ run }: { run: Run }) {
  const checkEvents = run.events.filter((event) => !['status', 'warning', 'inspect', 'complete'].includes(event.type));
  const passed = checkEvents.filter((event) => event.status === 'passed').length;
  const explicitFailures = checkEvents.filter((event) => event.status === 'failed');
  const failureEvidence = explicitFailures.length > 0
    ? explicitFailures
    : run.events.filter((event) => event.type === 'complete' && event.status === 'failed').slice(-1);
  const failed = failureEvidence.length;
  return <section className={`run-summary ${run.status}`}>
    <div>{run.status === 'passed' ? <CheckCircle2 size={24} /> : <XCircle size={24} />}<span><strong>{run.status === 'passed' ? 'All saved checks passed' : 'Action needed'}</strong><small>{run.status === 'passed' ? `${passed} recorded checks matched their saved expectations.` : run.error || `${failed} checks did not match the saved result.`}</small></span></div>
    <div className="summary-counts"><span><b>{passed}</b> Passed</span><span><b>{failed}</b> Failed</span></div>
    <a className="copy-summary-button" href={`/api/runs/${encodeURIComponent(run.id)}/logs`} download><ArrowDownToLine size={15} />Download logs</a>
  </section>;
}

function EventRow({ event }: { event: RunEvent }) {
  const eventDate = new Date(event.at);
  return <div className={`event-row ${event.status}`}>
    <span className="event-state">{event.status === 'passed' ? <Check size={13} /> : event.status === 'failed' ? <X size={13} /> : event.status === 'running' ? <LoaderCircle className="spin" size={13} /> : <Circle size={9} />}</span>
    <div><strong>{event.label}</strong>{event.url && <small>{event.url}</small>}{event.expected && <div className="comparison"><span>Expected: {event.expected}</span><span>Actual: {event.actual || '—'}</span></div>}</div>
    <time dateTime={event.at} title={eventDate.toISOString()}>{replayEventTime.format(eventDate)}</time>
  </div>;
}

function RenameProjectModal({ project, onClose, onSaved }: { project: DashboardProject; onClose: () => void; onSaved: (project: ProjectDetail['project']) => void }) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) { setError('Give this project a recognizable name.'); return; }
    if (nextName === project.name) { onClose(); return; }
    setError(''); setSaving(true);
    try {
      const updated = await api<ProjectDetail['project']>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH', body: JSON.stringify({ name: nextName }),
      });
      onSaved(updated);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not rename project.'); }
    finally { setSaving(false); }
  }

  return <Modal onClose={saving ? () => undefined : onClose} title="Rename project">
    <form onSubmit={(event) => void submit(event)}>
      <div className="modal-intro"><span><Pencil size={21} /></span><div><h2>Rename project</h2><p>Use a name that makes this website easy to recognize.</p></div></div>
      <div className="field-group"><div className="field-label-line"><label htmlFor="rename-project-name">Project name</label></div><input id="rename-project-name" ref={nameRef} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} autoComplete="off" /></div>
      <p className="field-hint">The website domain and all saved tests stay unchanged.</p>
      {error && <p className="form-error"><AlertCircle size={15} />{error}</p>}
      <div className="modal-actions"><button type="button" className="ghost-button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save name</button></div>
    </form>
  </Modal>;
}

function CookieEditorModal({ test, onClose, onSaved }: { test: TestDefinition; onClose: () => void; onSaved: (test: TestDefinition) => void }) {
  const [cookies, setCookies] = useState<BrowserCookie[]>(() => (test.browserState?.cookies ?? []).map((cookie) => ({ ...cookie })));
  const [cookieHeader, setCookieHeader] = useState(test.browserState?.cookieHeader ?? '');
  const [showValues, setShowValues] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const initialUrl = new URL(test.seedUrls[0]);

  function updateCookie(index: number, patch: Partial<BrowserCookie>) {
    setCookies((current) => current.map((cookie, position) => position === index ? { ...cookie, ...patch } : cookie));
    setError('');
  }

  function addCookie() {
    setCookies((current) => [...current, {
      name: '', value: '', domain: initialUrl.hostname, path: '/', secure: initialUrl.protocol === 'https:',
    }]);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const invalid = cookies.findIndex((cookie) => !cookie.name.trim() || !cookie.domain.trim());
    if (invalid >= 0) {
      setError(`Cookie ${invalid + 1} needs both a name and domain.`);
      return;
    }
    setSaving(true); setError('');
    try {
      const updated = await api<TestDefinition>(`/api/tests/${encodeURIComponent(test.id)}/cookies`, {
        method: 'PATCH',
        body: JSON.stringify({
          cookies: cookies.map((cookie) => ({
            ...cookie, name: cookie.name.trim(), domain: cookie.domain.trim(), path: cookie.path?.trim() || '/',
          })),
          cookieHeader: cookieHeader.trim(),
        }),
      });
      onSaved(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update recording cookies.');
      setSaving(false);
    }
  }

  return <Modal onClose={saving ? () => undefined : onClose} title="Edit recording cookies" wide>
    <form onSubmit={(event) => void save(event)}>
      <div className="modal-intro cookie-editor-intro"><span><Cookie size={22} /></span><div><h2>Edit replay cookies</h2><p>Update the browser session restored when “{test.name}” runs.</p></div></div>
      <div className="cookie-editor-toolbar">
        <div><strong>Exported cookies</strong><span>{cookies.length} {cookies.length === 1 ? 'cookie' : 'cookies'} attached</span></div>
        <button type="button" className="subtle-button" onClick={() => setShowValues((visible) => !visible)}>{showValues ? <EyeOff size={16} /> : <Eye size={16} />}{showValues ? 'Hide values' : 'Show values'}</button>
      </div>
      {cookies.length > 0 ? <div className="cookie-list-editor">
        {cookies.map((cookie, index) => <div className="cookie-edit-row" key={index}>
          <label><span>Name</span><input value={cookie.name} maxLength={1_000} onChange={(event) => updateCookie(index, { name: event.target.value })} aria-label={`Cookie ${index + 1} name`} autoComplete="off" /></label>
          <label className="cookie-value-field"><span>Value</span><input type={showValues ? 'text' : 'password'} value={cookie.value} maxLength={100_000} onChange={(event) => updateCookie(index, { value: event.target.value })} aria-label={`Cookie ${index + 1} value`} autoComplete="off" /></label>
          <label><span>Domain</span><input value={cookie.domain} maxLength={1_000} onChange={(event) => updateCookie(index, { domain: event.target.value })} aria-label={`Cookie ${index + 1} domain`} autoCapitalize="none" spellCheck={false} /></label>
          <label className="cookie-path-field"><span>Path</span><input value={cookie.path ?? '/'} maxLength={4_000} onChange={(event) => updateCookie(index, { path: event.target.value })} aria-label={`Cookie ${index + 1} path`} autoCapitalize="none" spellCheck={false} /></label>
          <IconButton label={`Remove cookie ${index + 1}`} onClick={() => setCookies((current) => current.filter((_cookie, position) => position !== index))}><Trash2 size={16} /></IconButton>
        </div>)}
      </div> : <div className="cookie-empty"><Cookie size={22} /><span>No exported cookies are attached. Add one or use the fixed header below.</span></div>}
      <button type="button" className="text-button add-cookie-button" onClick={addCookie}><Plus size={15} /> Add cookie</button>
      <div className="field-group"><div className="field-label-line"><label htmlFor="edit-cookie-header">Fixed cookie header <span className="optional">Optional</span></label></div><input id="edit-cookie-header" type={showValues ? 'text' : 'password'} value={cookieHeader} maxLength={200_000} onChange={(event) => { setCookieHeader(event.target.value); setError(''); }} placeholder="session=abc123; tenant=demo" autoComplete="off" /><small className="field-hint">Applied to the recording’s starting URL in addition to exported cookies. Clear it to remove the override.</small></div>
      <div className="cookie-security-note"><ShieldCheck size={17} /><span>Cookie values stay in Pathproof’s local data store. Avoid copying them into source control, screenshots, or support tickets.</span></div>
      {error && <p className="form-error"><AlertCircle size={15} />{error}</p>}
      <div className="modal-actions"><button type="button" className="ghost-button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save cookies</button></div>
    </form>
  </Modal>;
}

function DeleteConfirmationModal({ title, heading, copy, itemNames, confirmLabel, onClose, onConfirm }: {
  title: string;
  heading: string;
  copy: string;
  itemNames?: string[];
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const visibleNames = itemNames?.slice(0, 6) ?? [];

  async function confirm() {
    setDeleting(true); setError('');
    try { await onConfirm(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete this item.'); setDeleting(false); }
  }

  return <Modal onClose={deleting ? () => undefined : onClose} title={title}>
    <div className="modal-intro danger-intro"><span><Trash2 size={21} /></span><div><h2>{heading}</h2><p>This action cannot be undone.</p></div></div>
    <p className="delete-copy">{copy}</p>
    {visibleNames.length > 0 && <ul className="delete-list">{visibleNames.map((name) => <li key={name}>{name}</li>)}{itemNames && itemNames.length > visibleNames.length && <li>and {itemNames.length - visibleNames.length} more</li>}</ul>}
    <div className="delete-warning"><AlertCircle size={17} /><span>Deletion is permanent and cannot be restored from Pathproof.</span></div>
    {error && <p className="form-error"><AlertCircle size={15} />{error}</p>}
    <div className="modal-actions"><button type="button" className="ghost-button" disabled={deleting} onClick={onClose}>Cancel</button><button type="button" className="danger-button" disabled={deleting} onClick={() => void confirm()}>{deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} {deleting ? 'Deleting…' : confirmLabel}</button></div>
  </Modal>;
}

function OriginResolutionMessage({ resolution, id }: { resolution: OriginResolution; id: string }) {
  if (resolution.status === 'idle') return null;
  return <p
    id={id}
    className={`origin-resolution ${resolution.status}`}
    role={resolution.status === 'error' ? 'alert' : 'status'}
  >
    {resolution.status === 'resolving'
      ? <><LoaderCircle className="spin" size={14} /> Checking this website…</>
      : resolution.status === 'resolved'
        ? <><CheckCircle2 size={14} /> Website found: <strong>{resolution.origin}</strong></>
        : <><AlertCircle size={14} /> {resolution.message}</>}
  </p>;
}

function EditProjectModal({ project, hasTests, onClose, onSaved }: { project: ProjectDetail['project']; hasTests: boolean; onClose: () => void; onSaved: (project: ProjectDetail['project']) => void }) {
  const [name, setName] = useState(project.name);
  const { origin, originRef, resolution, setOrigin, resolveOrigin } = useOriginResolver(project.origin);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!name.trim()) { setError('Give this project a recognizable name.'); return; }
    setSaving(true);
    try {
      const normalized = hasTests ? project.origin : await resolveOrigin(originRef.current);
      if (!normalized) return;
      const updated = await api<ProjectDetail['project']>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), ...(!hasTests ? { origin: normalized } : {}) }),
      });
      onSaved(updated);
    } catch (reason) { setError(projectFormError(reason, 'Could not update this project. Please try again.')); }
    finally { setSaving(false); }
  }

  const resolutionId = 'edit-project-domain-resolution';
  return <Modal onClose={saving ? () => undefined : onClose} title="Edit project">
    <form onSubmit={(event) => void submit(event)}>
      <div className="modal-intro"><span><Pencil size={21} /></span><div><h2>Edit project</h2><p>Keep the name and exact website origin accurate.</p></div></div>
      <div className="field-group"><div className="field-label-line"><label htmlFor="edit-project-name">Project name</label></div><input id="edit-project-name" ref={nameRef} value={name} disabled={saving} onChange={(event) => { setName(event.target.value); setError(''); }} autoComplete="off" /></div>
      <div className="field-group"><div className="field-label-line"><label htmlFor="edit-project-domain">Root domain</label><HelpButton topic="projectDomain" /></div><div className={`url-field ${hasTests ? 'is-disabled' : ''} ${resolution.status}`}><Globe2 size={16} /><input id="edit-project-domain" value={origin} onChange={(event) => { setOrigin(event.target.value); setError(''); }} onBlur={(event) => { if (!hasTests && !saving) void resolveOrigin(event.currentTarget.value); }} inputMode="url" autoCapitalize="none" spellCheck={false} disabled={hasTests || saving} aria-busy={resolution.status === 'resolving'} aria-invalid={resolution.status === 'error'} aria-describedby={hasTests || resolution.status === 'idle' ? 'edit-project-domain-hint' : `${resolutionId} edit-project-domain-hint`} /></div></div>
      <p className="field-hint" id="edit-project-domain-hint">{hasTests ? 'The domain is locked because saved tests depend on it. The project name can still be changed.' : 'Type a domain such as example.com. We’ll find its secure, canonical address.'}</p>
      {!hasTests && <OriginResolutionMessage id={resolutionId} resolution={resolution} />}
      {error && <p className="form-error"><AlertCircle size={15} />{error}</p>}
      <div className="modal-actions"><button type="button" className="ghost-button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || !name.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save changes</button></div>
    </form>
  </Modal>;
}

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (project: DashboardProject) => void }) {
  const [name, setName] = useState('');
  const { origin, originRef, resolution, setOrigin, resolveOrigin } = useOriginResolver();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!name.trim()) { setError('Give this project a recognizable name.'); return; }
    setSaving(true);
    try {
      const normalized = await resolveOrigin(originRef.current);
      if (!normalized) return;
      const response = await api<DashboardProject | { project: DashboardProject }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.trim(), origin: normalized }) });
      onCreated('project' in response ? response.project : response);
    } catch (reason) { setError(projectFormError(reason, 'Could not create this project. Please try again.')); }
    finally { setSaving(false); }
  }

  const resolutionId = 'project-domain-resolution';
  return <Modal onClose={saving ? () => undefined : onClose} title="Add a website">
    <form onSubmit={(event) => void submit(event)}>
      <div className="modal-intro"><span><Globe2 size={22} /></span><div><h2>Add a website</h2><p>Create a workspace for its automated journeys.</p></div></div>
      <div className="field-group"><div className="field-label-line"><label htmlFor="project-name">Project name</label></div><input id="project-name" ref={titleRef} value={name} disabled={saving} onChange={(event) => { setName(event.target.value); setError(''); }} placeholder="Marketing website" autoComplete="off" /></div>
      <div className="field-group"><div className="field-label-line"><label htmlFor="project-domain">Root domain</label><HelpButton topic="projectDomain" /></div><div className={`url-field ${resolution.status}`}><Globe2 size={16} /><input id="project-domain" value={origin} onChange={(event) => { setOrigin(event.target.value); setError(''); }} onBlur={(event) => { if (!saving) void resolveOrigin(event.currentTarget.value); }} placeholder="example.com" inputMode="url" autoCapitalize="none" spellCheck={false} disabled={saving} aria-busy={resolution.status === 'resolving'} aria-invalid={resolution.status === 'error'} aria-describedby={resolution.status === 'idle' ? 'project-domain-hint' : `${resolutionId} project-domain-hint`} /></div></div>
      <p className="field-hint" id="project-domain-hint">Type a domain such as example.com. We’ll find its secure, canonical address.</p>
      <OriginResolutionMessage id={resolutionId} resolution={resolution} />
      {error && <p className="form-error"><AlertCircle size={15} />{error}</p>}
      <div className="modal-actions"><button type="button" className="ghost-button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Create project</button></div>
    </form>
  </Modal>;
}

function ImportRecordingModal({ project, onClose, onImported }: { project: ProjectDetail; onClose: () => void; onImported: (test: TestDefinition) => void }) {
  const [recording, setRecording] = useState<PathproofRecording | null>(null);
  const [fileName, setFileName] = useState('');
  const [name, setName] = useState('');
  const [cookieHeader, setCookieHeader] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function selectFile(file?: File) {
    setError(''); setRecording(null);
    if (!file) return;
    if (file.size > 250 * 1024 * 1024) { setError('This recording exceeds the 250 MB import limit. Turn off the compositor stream or network bodies and record again.'); return; }
    try {
      const parsed = JSON.parse(await file.text()) as PathproofRecording;
      if (parsed.format !== 'pathproof-recording' || parsed.version !== 1 || !Array.isArray(parsed.events) || !parsed.target?.initialUrl) {
        throw new Error('This is not a Pathproof recording version 1 file.');
      }
      if (new URL(parsed.target.initialUrl).origin !== new URL(project.project.origin).origin) {
        throw new Error(`This recording starts on ${new URL(parsed.target.initialUrl).origin}, not this project’s domain ${project.project.origin}.`);
      }
      setRecording(parsed); setFileName(file.name); setName(parsed.name || `${project.project.name} recorded journey`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not read this recording file.'); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!recording) { setError('Choose a Pathproof recording file first.'); return; }
    if (!name.trim()) { setError('Give the recorded test a recognizable name.'); return; }
    setSaving(true);
    try {
      const created = await api<TestDefinition>(`/api/projects/${encodeURIComponent(project.project.id)}/recordings`, {
        method: 'POST', body: JSON.stringify({ name: name.trim(), cookieHeader: cookieHeader.trim() || undefined, recording }),
      });
      onImported(created);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not import this recording.'); }
    finally { setSaving(false); }
  }

  return <Modal onClose={onClose} title="Import browser recording" wide>
    <form onSubmit={(event) => void submit(event)}>
      <div className="modal-intro import-intro"><span><Upload size={22} /></span><div><h2>Import browser recording</h2><p>Turn the extension’s event stream into a deterministic Playwright test.</p></div></div>
      <label className={`recording-dropzone ${recording ? 'has-file' : ''}`}>
        <input type="file" accept=".json,.pathproof.json,application/json" onChange={(event) => void selectFile(event.target.files?.[0])} />
        {recording ? <><CheckCircle2 size={28} /><strong>{fileName}</strong><span>{recording.events.length.toLocaleString()} captured signals · {recording.events.filter((item) => item.kind === 'video-frame').length.toLocaleString()} stream frames · {Math.round(recording.durationMs / 1000)} seconds</span><small>Choose another recording</small></> : <><Upload size={29} /><strong>Choose a .pathproof.json recording</strong><span>Up to 250 MB. The file is processed by this local Pathproof server.</span></>}
      </label>
      {recording && <div className="recording-review">
        <div><span>Started at</span><strong>{dateTime.format(new Date(recording.startedAt))}</strong></div>
        <div><span>Final URL</span><strong title={recording.target.finalUrl}>{recording.target.finalUrl.replace(/^https?:\/\//, '')}</strong></div>
        <div><span>Browser state</span><strong>{recording.browser.cookies?.length ? `${recording.browser.cookies.length} cookies included` : 'No cookies included'}</strong></div>
      </div>}
      <div className="field-group"><label htmlFor="recording-test-name">Test name</label><input id="recording-test-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={`${project.project.name} checkout journey`} /></div>
      <div className="field-group"><label htmlFor="cookie-header">Fixed cookie header <span className="optional">Optional</span></label><input id="cookie-header" value={cookieHeader} onChange={(event) => setCookieHeader(event.target.value)} placeholder="session=abc123; tenant=demo" /><small className="field-hint">Overrides or supplements exported cookies. Stored locally; never paste this value into tickets or source control.</small></div>
      <div className="smart-note"><ShieldCheck size={20} /><div><strong>Replay fidelity and safety</strong><p>Viewport, user agent, locale, timezone, cookies and local storage are restored when present. Chrome profiles, installed extensions and protected browser pages cannot be cloned exactly.</p></div></div>
      {error && <p className="form-error"><AlertCircle size={15} />{error}</p>}
      <div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || !recording || !name.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />} Import & create test</button></div>
    </form>
  </Modal>;
}

function DiscoveryModal({ project, onClose, onStarted }: { project: ProjectDetail; onClose: () => void; onStarted: (runs: Run[]) => void }) {
  const [name, setName] = useState(`${project.project.name} regression`);
  const [urls, setUrls] = useState(project.project.origin);
  const [aiInstructions, setAiInstructions] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [cookies, setCookies] = useState<BrowserCookie[]>([]);
  const [cookieHeader, setCookieHeader] = useState('');
  const [showCookieValues, setShowCookieValues] = useState(false);
  const [cookieGuideOpen, setCookieGuideOpen] = useState(false);
  const [cookieCodeCopied, setCookieCodeCopied] = useState(false);
  const [files, setFiles] = useState<TestFileAttachment[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cookieCodeRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const reviewedUrls = useMemo(() => {
    const seen = new Set<string>();
    const projectOrigin = new URL(project.project.origin).origin;
    return urls.split(/\n/).map((value) => value.trim()).filter(Boolean).map((raw) => {
      try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) return { raw, state: 'invalid' as const };
        if (parsed.origin !== projectOrigin) return { raw, state: 'different-origin' as const };
        const normalized = parsed.toString();
        if (seen.has(normalized)) return { raw, state: 'duplicate' as const };
        seen.add(normalized);
        return { raw, normalized, state: 'ready' as const };
      } catch { return { raw, state: 'invalid' as const }; }
    });
  }, [project.project.origin, urls]);
  const validUrls = reviewedUrls.flatMap((item) => item.state === 'ready' ? [item.normalized] : []);
  const projectHost = new URL(project.project.origin).hostname;

  function addCookie() {
    setCookies((current) => [...current, { name: '', value: '', domain: projectHost, path: '/', secure: project.project.origin.startsWith('https:') }]);
    setCookiesOpen(true);
  }

  function updateCookie(index: number, patch: Partial<BrowserCookie>) {
    setCookies((current) => current.map((cookie, position) => position === index ? { ...cookie, ...patch } : cookie));
    setError('');
  }

  async function importCookieSet(file?: File) {
    if (!file) return;
    setError('');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Cookie set must be smaller than 5 MB.');
      const parsed = JSON.parse(await file.text()) as unknown;
      const raw = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies) ? (parsed as { cookies: unknown[] }).cookies : null;
      if (!raw) throw new Error('Choose a JSON cookie array or an object with a cookies array.');
      const imported = raw.flatMap((value): BrowserCookie[] => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        if (typeof item.name !== 'string' || typeof item.value !== 'string') return [];
        const sameSite = typeof item.sameSite === 'string' && ['Strict', 'Lax', 'None', 'no_restriction', 'lax', 'strict', 'unspecified'].includes(item.sameSite) ? item.sameSite as BrowserCookie['sameSite'] : undefined;
        const expires = typeof item.expires === 'number' ? item.expires : typeof item.expirationDate === 'number' ? item.expirationDate : undefined;
        return [{ name: item.name, value: item.value, domain: typeof item.domain === 'string' ? item.domain : projectHost, path: typeof item.path === 'string' ? item.path : '/', expires, httpOnly: Boolean(item.httpOnly), secure: Boolean(item.secure), sameSite }];
      });
      if (!imported.length) throw new Error('The cookie set does not contain any usable name/value cookies.');
      setCookies(imported);
      setCookiesOpen(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not import this cookie set.');
    }
  }

  async function attachFiles(selected?: FileList | null) {
    if (!selected?.length) return;
    setError('');
    try {
      const incoming = Array.from(selected);
      if (files.length + incoming.length > 5) throw new Error('Attach no more than 5 test files.');
      if (incoming.some((file) => file.size > 5 * 1024 * 1024)) throw new Error('Each test file must be 5 MB or smaller.');
      if (files.reduce((total, file) => total + file.size, 0) + incoming.reduce((total, file) => total + file.size, 0) > 15 * 1024 * 1024) throw new Error('Attached files must be 15 MB or smaller in total.');
      const encoded = await Promise.all(incoming.map(async (file): Promise<TestFileAttachment> => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 32_768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
        return { name: file.name, mimeType: file.type || 'application/octet-stream', dataBase64: btoa(chunks.join('')), size: file.size };
      }));
      setFiles((current) => [...current, ...encoded]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not attach these files.');
    }
  }

  async function copyCookieCode() {
    setError('');
    try {
      await navigator.clipboard.writeText(cookieExportScript);
      setCookieCodeCopied(true);
    } catch {
      cookieCodeRef.current?.focus();
      cookieCodeRef.current?.select();
      const copied = document.execCommand('copy');
      setCookieCodeCopied(copied);
      if (!copied) setError('Could not access the clipboard. Select the JS code and copy it manually.');
    }
  }

  function nameForUrl(url: string, index: number): string {
    if (validUrls.length === 1) return name.trim();
    const parsed = new URL(url);
    const pageLabel = `${parsed.pathname || '/'}${parsed.search}`;
    const suffix = ` — ${index + 1}: ${pageLabel}`;
    return `${name.trim().slice(0, Math.max(1, 120 - suffix.length))}${suffix}`.slice(0, 120);
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!name.trim()) { setError('Give the test a recognizable name'); return; }
    if (!validUrls.length) { setError('Add at least one complete URL from this project’s domain'); return; }
    if (!aiInstructions.trim()) { setError('Describe what AI should do on each starting URL'); return; }
    const invalidCookie = cookies.findIndex((cookie) => {
      const domain = cookie.domain.trim().replace(/^\./, '');
      return !cookie.name.trim() || !domain || !(projectHost === domain || projectHost.endsWith(`.${domain}`));
    });
    if (invalidCookie >= 0) { setError(`Cookie ${invalidCookie + 1} needs a name and a domain matching ${projectHost}`); return; }
    setSaving(true);
    try {
      const responses = await Promise.all(validUrls.map((url, index) => api<unknown>(`/api/projects/${encodeURIComponent(project.project.id)}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name: nameForUrl(url, index), seedUrls: [url], aiInstructions: aiInstructions.trim(),
          files: files.length ? files : undefined,
          browserState: cookies.length || cookieHeader.trim() ? {
            cookies: cookies.map((cookie) => ({ ...cookie, name: cookie.name.trim(), domain: cookie.domain.trim(), path: cookie.path?.trim() || '/' })),
            cookieHeader: cookieHeader.trim() || undefined,
          } : undefined,
        }),
      })));
      const runs = responses.map((response) => runFromResponse(response) || runFromResponse((response as { test?: { run?: Run } })?.test));
      if (runs.some((run) => !run)) throw new Error('One or more tests were created, but their setup runs could not be opened');
      onStarted(runs as Run[]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start discovery'); }
    finally { setSaving(false); }
  }

  return <Modal onClose={onClose} title="Create automated test" wide>
    <form onSubmit={(event) => void submit(event)}>
      <div className="modal-intro discovery-intro"><span><Sparkles size={22} /></span><div><h2>Create automated tests</h2><p>Tell AI what to do. Pathproof creates one reusable test for every starting URL.</p></div></div>
      <div className="discovery-flow" aria-label="Setup process"><span className="active"><b>1</b> AI instructions</span><i /><span><b>2</b> One test per URL</span><i /><span><b>3</b> Ready to rerun</span></div>
      <div className="field-group textarea-group"><div className="field-label-line"><label htmlFor="ai-instructions">AI instructions</label><HelpButton topic="smartDiscovery" /></div><textarea id="ai-instructions" ref={inputRef} value={aiInstructions} onChange={(event) => setAiInstructions(event.target.value)} rows={4} maxLength={2_000} required placeholder="Navigate to the contact page from the footer menu and verify that the support form is available" aria-describedby="ai-instructions-hint" /><span className="textarea-counter">{aiInstructions.length}/2000</span><small className="field-hint" id="ai-instructions-hint">These instructions are the primary goal for every starting URL. Saved-plan replays do not call AI again.</small></div>
      <div className="setup-session-row">
        <div className="field-group"><div className="field-label-line"><label htmlFor="test-name">Test name prefix</label></div><input id="test-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Contact journey" /></div>
        <div className="field-group"><div className="field-label-line"><span className="field-label-text">Session Management and Access</span></div><button id="setup-cookie-toggle" type="button" className="subtle-button setup-cookie-toggle" aria-expanded={cookiesOpen} aria-controls="setup-cookie-editor" onClick={() => setCookiesOpen((open) => !open)}><Cookie size={16} /> Import cookies {cookies.length > 0 && <span>{cookies.length}</span>}</button></div>
        <div className="setup-cookie-section">
          {cookiesOpen && <div className="setup-cookie-editor" id="setup-cookie-editor">
            <div className="cookie-editor-toolbar"><div><strong>Browser cookies</strong><span>Restore consent or session state before AI starts.</span></div><button type="button" className="subtle-button" onClick={() => setShowCookieValues((visible) => !visible)}>{showCookieValues ? <EyeOff size={15} /> : <Eye size={15} />}{showCookieValues ? 'Hide values' : 'Show values'}</button></div>
            <div className="setup-cookie-actions"><label className="subtle-button"><Upload size={15} /> Import cookie set<input type="file" accept=".json,application/json" onChange={(event) => { void importCookieSet(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label><button type="button" className="text-button" aria-expanded={cookieGuideOpen} aria-controls="cookie-export-guide" onClick={() => { setCookieGuideOpen((open) => !open); setCookieCodeCopied(false); }}><ClipboardCopy size={15} /> Guide for Cookie export</button><button type="button" className="text-button" onClick={addCookie}><Plus size={15} /> Add individual cookie</button></div>
            {cookieGuideOpen && <div className="cookie-export-guide" id="cookie-export-guide">
              <div className="cookie-guide-toolbar"><div><strong>Chrome DevTools Console code</strong><span>Run this on the website whose cookies you need.</span></div><button type="button" className="subtle-button" onClick={() => void copyCookieCode()}>{cookieCodeCopied ? <Check size={15} /> : <ClipboardCopy size={15} />}{cookieCodeCopied ? 'Copied' : 'Copy JS Code'}</button></div>
              <p>Open Chrome DevTools → Console, paste the code, and press Enter. It logs the JSON and downloads <code>Import_cookie_set_DOMAIN_YYYYMMDD_HHMMSS.json</code> for <code>Import cookie set.</code> JavaScript cannot export HttpOnly cookies.</p>
              <label className="sr-only" htmlFor="cookie-export-code">Cookie export JavaScript code</label><textarea ref={cookieCodeRef} id="cookie-export-code" value={cookieExportScript} readOnly rows={15} spellCheck={false} />
            </div>}
            {cookies.length > 0 && <div className="cookie-list-editor">{cookies.map((cookie, index) => <div className="cookie-edit-row" key={index}>
              <label><span>Name</span><input aria-label={`Setup cookie ${index + 1} name`} value={cookie.name} onChange={(event) => updateCookie(index, { name: event.target.value })} /></label>
              <label className="cookie-value-field"><span>Value</span><input aria-label={`Setup cookie ${index + 1} value`} type={showCookieValues ? 'text' : 'password'} value={cookie.value} onChange={(event) => updateCookie(index, { value: event.target.value })} /></label>
              <label><span>Domain</span><input aria-label={`Setup cookie ${index + 1} domain`} value={cookie.domain} onChange={(event) => updateCookie(index, { domain: event.target.value })} /></label>
              <label className="cookie-path-field"><span>Path</span><input aria-label={`Setup cookie ${index + 1} path`} value={cookie.path ?? '/'} onChange={(event) => updateCookie(index, { path: event.target.value })} /></label>
              <IconButton label={`Remove setup cookie ${index + 1}`} onClick={() => setCookies((current) => current.filter((_cookie, position) => position !== index))}><Trash2 size={16} /></IconButton>
            </div>)}</div>}
            <div className="field-group"><label htmlFor="setup-cookie-header">Cookie header <span className="optional">Optional</span></label><input id="setup-cookie-header" type={showCookieValues ? 'text' : 'password'} value={cookieHeader} onChange={(event) => setCookieHeader(event.target.value)} placeholder="cookie_consent=accepted; locale=de" autoComplete="off" /><small className="field-hint">Useful when you already have a Cookie header string instead of an exported JSON set.</small></div>
            <div className="cookie-security-note"><ShieldCheck size={17} /><span>Cookie values stay in Pathproof’s local data store and are applied before the first page opens.</span></div>
          </div>}
        </div>
      </div>
      <div className="field-group textarea-group"><div className="field-label-line"><label htmlFor="starting-urls">Starting URLs</label><HelpButton topic="seedUrls" /></div><textarea id="starting-urls" value={urls} onChange={(event) => setUrls(event.target.value)} rows={6} placeholder={`${project.project.origin}\n${project.project.origin}/pricing`} aria-describedby={reviewedUrls.length ? 'url-review-summary' : undefined} /><span className="textarea-counter">{validUrls.length} ready</span></div>
      {reviewedUrls.length > 0 && <div className="url-review" aria-label="Starting URL review"><p id="url-review-summary">{validUrls.length} ready to use{reviewedUrls.length > validUrls.length ? ` · ${reviewedUrls.length - validUrls.length} skipped` : ''}</p><div>{reviewedUrls.slice(0, 5).map((item, index) => <span className={item.state} key={`${item.raw}-${index}`}>{item.state === 'ready' ? <CheckCircle2 size={13} /> : item.state === 'duplicate' ? <AlertCircle size={13} /> : <XCircle size={13} />}<b>{item.raw}</b><small>{item.state === 'ready' ? 'Ready' : item.state === 'duplicate' ? 'Duplicate' : item.state === 'different-origin' ? 'Different domain' : 'Invalid URL'}</small></span>)}</div></div>}
      {reviewedUrls.some((item) => item.state === 'different-origin') && <p className="origin-mismatch-note"><AlertCircle size={15} /><span>This URL uses a different host than <strong>{project.project.origin}</strong>. If the www version is correct, cancel setup and use <strong>Edit project</strong> to update the root domain.</span></p>}
      <div className="setup-file-section">
        <div className="field-label-line"><div><strong>Files to upload during the test</strong> <span className="optional">Optional</span></div><label className="subtle-button setup-file-button"><Upload size={15} /> Attach files<input id="setup-test-files" type="file" multiple aria-describedby="setup-test-files-hint" onChange={(event) => { void attachFiles(event.target.files); event.currentTarget.value = ''; }} /></label></div>
        <p className="setup-file-explanation" id="setup-test-files-hint"><strong>Only add files when your AI instructions include choosing or uploading a file on the website.</strong> Attach the exact sample files the test should use—for example a PDF résumé, profile image, CSV import, or form attachment. These are not cookie files or Chrome recordings. Every file is made available to each automated test created from the Starting URLs.</p>
        <small className="field-hint">AI matches your instructions to the website’s file input and attached filename. Up to 5 files, 5 MB each, with a 15 MB total limit.</small>
        {files.length > 0 && <div className="setup-file-list">{files.map((file, index) => <span key={`${file.name}-${index}`}><FileCheck2 size={15} /><b>{file.name}</b><small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small><IconButton label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_file, position) => position !== index))}><X size={14} /></IconButton></span>)}</div>}
      </div>
      <div className="smart-note"><Bot size={20} /><div><strong>One focused AI setup per URL</strong><p>AI observes after every action and can use exact form values, attached files, drag-and-drop, canvas gestures, custom controls, open shadow DOM, and same-origin tabs. Mutating requests remain blocked.</p></div></div>
      {error && <p className="form-error"><AlertCircle size={15} />{error}</p>}
      <div className="modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || !name.trim() || validUrls.length === 0 || !aiInstructions.trim()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} {validUrls.length === 1 ? 'Create automated test' : `Create ${validUrls.length} automated tests`}</button></div>
    </form>
  </Modal>;
}

function ChromeExtensionModal({ onClose }: { onClose: () => void }) {
  return <Modal onClose={onClose} title="Chrome Extension">
    <div className="modal-intro extension-intro"><span><Puzzle size={22} /></span><div><h2>Pathproof Chrome Extension</h2><p>Record a browser journey, then import its JSON recording into a project.</p></div></div>
    <div className="extension-download-note"><ShieldCheck size={18} /><span>The extension is provided as a ZIP for manual installation while store distribution is being prepared.</span></div>
    <ol className="extension-install-steps">
      <li><span>1</span><div><strong>Download and extract the ZIP</strong><small>Keep the extracted <code>chrome-extension</code> folder.</small></div></li>
      <li><span>2</span><div><strong>Open Chrome extensions</strong><small>Visit <code>chrome://extensions</code> and enable Developer mode.</small></div></li>
      <li><span>3</span><div><strong>Load the extension</strong><small>Select Load unpacked, then choose the extracted folder.</small></div></li>
      <li><span>4</span><div><strong>Record and import</strong><small>Download the recording JSON, then use Import recording inside a Pathproof project.</small></div></li>
    </ol>
    <div className="modal-actions extension-modal-actions"><button type="button" className="ghost-button" onClick={onClose}>Close</button><a className="primary-button" href="/pathproof-chrome-extension.zip" download="pathproof-chrome-extension.zip"><ArrowDownToLine size={16} /> Download extension ZIP</a></div>
  </Modal>;
}

function Modal({ children, onClose, title, wide = false }: { children: ReactNode; onClose: () => void; title: string; wide?: boolean }) {
  const modalRef = useRef<HTMLElement>(null);
  useOverlayFocus(modalRef, onClose, true);
  useEffect(() => {
    document.body.classList.add('modal-open');
    return () => document.body.classList.remove('modal-open');
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={modalRef} className={`modal ${wide ? 'wide' : ''}`} data-overlay role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><IconButton label="Close dialog" onClick={onClose}><X size={19} /></IconButton>{children}</section></div>;
}

function useOverlayFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, preferInput = false) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    if (!node) return;
    const isTopOverlay = () => {
      const overlays = document.querySelectorAll<HTMLElement>('[data-overlay]');
      return overlays[overlays.length - 1] === node;
    };
    const focusable = () => [...node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.getClientRects().length > 0);
    window.setTimeout(() => {
      if (isTopOverlay() && !node.contains(document.activeElement)) {
        const preferred = preferInput
          ? node.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])')
          : node.querySelector<HTMLElement>('button[aria-label^="Close"]');
        (preferred ?? focusable()[0] ?? node).focus();
      }
    }, 0);
    const handler = (event: KeyboardEvent) => {
      if (!isTopOverlay()) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) { event.preventDefault(); node.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => { document.removeEventListener('keydown', handler, true); previous?.focus(); };
  }, [preferInput, ref]);
}

function Metric({ icon, value, label, pulse }: { icon: ReactNode; value: number; label: string; pulse?: boolean }) {
  return <div className="metric"><span className={pulse ? 'metric-icon pulse' : 'metric-icon'}>{icon}</span><div><strong>{value}</strong><span>{label}</span></div></div>;
}

function Checkbox({ checked, indeterminate = false, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: () => void; label: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inputRef.current) inputRef.current.indeterminate = indeterminate; }, [indeterminate]);
  return <label className="checkbox-hit"><input ref={inputRef} type="checkbox" className="checkbox" checked={checked} onChange={onChange} aria-label={label} /><span className="sr-only">{label}</span></label>;
}

function ProjectBadge({ project }: { project: DashboardProject }) {
  const active = project.status === 'running' || ['queued', 'running'].includes(project.lastRun?.status || '');
  const status = active ? 'running' : project.status;
  const label = status === 'empty' ? 'Needs setup' : status === 'ready' ? 'Ready to rerun' : status;
  return <span className={`status-badge ${status}`}>{active ? <LoaderCircle className="spin" size={12} /> : status === 'attention' ? <AlertCircle size={12} /> : status === 'ready' ? <CheckCircle2 size={12} /> : <Circle size={9} />}{label}</span>;
}

function TestBadge({ test }: { test: TestDefinition }) {
  const state = test.status === 'discovering' ? 'discovering' : test.plan ? 'ready' : 'failed';
  const label = state === 'discovering' ? 'First-run setup' : state === 'ready' ? 'Ready to rerun' : 'Setup failed';
  return <span className={`status-badge ${state}`}>{state === 'discovering' ? <LoaderCircle className="spin" size={12} /> : state === 'failed' ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}{label}</span>;
}

function RunStatusIcon({ status }: Pick<Run, 'status'>) {
  return <span className={`run-status-icon ${status}`}>{['queued', 'running'].includes(status) ? <LoaderCircle className="spin" size={17} /> : status === 'passed' ? <Check size={17} /> : <X size={17} />}</span>;
}

function LoadingState({ label }: { label: string }) { return <div className="loading-state"><LoaderCircle className="spin" size={24} /><span>{label}</span></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className="empty-state error-state"><span><AlertCircle size={28} /></span><h2>Something went wrong</h2><p>{message}</p><button type="button" className="subtle-button" onClick={retry}><RefreshCw size={15} /> Try again</button></div>; }
function EmptyState({ icon, title, copy, action }: { icon: ReactNode; title: string; copy: string; action?: ReactNode }) { return <div className="empty-state"><span>{icon}</span><h2>{title}</h2><p>{copy}</p>{action}</div>; }
function formatDuration(ms: number) { const seconds = Math.round(ms / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }

export default App;
