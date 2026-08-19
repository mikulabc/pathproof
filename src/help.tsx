import { ArrowRight, CircleHelp, Lightbulb, ShieldCheck, X } from 'lucide-react';
import { createContext, MouseEvent, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type HelpEntry = { title: string; description: string; use: string; caution?: string };
const START_HERE_STORAGE_KEY = 'pathproof-start-here-hidden';

export const HELP_ENTRIES = {
  overview: { title: 'How Pathproof works', description: 'Pathproof learns a safe browser journey once, saves it as a Playwright plan, and replays the same checks after future releases.', use: 'Add a website, choose important starting pages, watch discovery, then rerun the saved test whenever you deploy.', caution: 'Discovery skips actions that could change data. Replays never use AI.' },
  projectsNav: { title: 'Projects', description: 'Your home for every website you monitor.', use: 'Create websites, check readiness, start bulk runs, or open one project for detailed tests and reports.' },
  runnerStatus: { title: 'Browser runner', description: 'The runner opens websites in Chromium and executes discovery or saved tests.', use: 'A green indicator means the local runner API is reachable.', caution: 'Two browser runs can execute at once. Additional work waits in the queue.' },
  newProject: { title: 'Add website', description: 'Creates a workspace for one website origin.', use: 'Start here when you want to protect a new website.', caution: 'Each exact domain origin can have one project.' },
  projectMetric: { title: 'Projects monitored', description: 'The number of website workspaces saved here.', use: 'Use this as a quick workspace-size check.', caution: 'A project is not protected until it has at least one replay-ready test.' },
  readyMetric: { title: 'Tests ready to rerun', description: 'Tests that already have a saved Playwright plan.', use: 'These tests can run again without AI or rediscovery.' },
  runningMetric: { title: 'Running now', description: 'Projects with queued or active browser work.', use: 'Open a running project to watch it live.', caution: 'Queued work may be waiting for one of two runner slots.' },
  search: { title: 'Search projects', description: 'Filters projects by name or domain.', use: 'Find one website quickly in a larger workspace.', caution: 'Select all applies to the projects currently visible.' },
  bulkSelection: { title: 'Select projects', description: 'Adds projects to one bulk replay request.', use: 'Choose several websites after a release, then select Run selected.', caution: 'Only tests with saved plans are runnable.' },
  runSelected: { title: 'Run selected projects', description: 'Queues every replay-ready test inside the selected projects.', use: 'Use it for release checks across several websites.', caution: 'Replays are deterministic and do not use AI. Unready projects have nothing to run.' },
  refresh: { title: 'Refresh status', description: 'Fetches the latest projects, progress, and results.', use: 'Use this if a completed run has not appeared yet. Active work refreshes automatically.' },
  projectsTable: { title: 'Project overview', description: 'One place to compare website readiness, recent results, and active progress.', use: 'Scan for Needs setup, Running, Ready, or Attention and take the matching next step.' },
  projectColumn: { title: 'Project', description: 'The website name and exact root domain.', use: 'Select the project name to open its tests and run history.' },
  statusColumn: { title: 'Project status', description: 'Needs setup means no saved plan; Ready means at least one plan; Running means active work; Attention means a failure needs review.', use: 'Use this as the quickest next-action signal.' },
  testsColumn: { title: 'Ready tests', description: 'Shows replay-ready tests compared with all test definitions.', use: 'A project needs at least one ready test before bulk replay is useful.' },
  lastRunColumn: { title: 'Latest result', description: 'When the newest discovery or replay started and how it ended.', use: 'Check recency and spot regressions that need investigation.' },
  progressColumn: { title: 'Run progress', description: 'The active browser action and estimated completion percentage.', use: 'Follow background work without opening the live viewer.', caution: 'This is run progress, not website coverage.' },
  projectRow: { title: 'Project overview', description: 'A compact health summary for one website.', use: 'Open it to add tests, watch a run, replay saved checks, or inspect reports.' },
  projectName: { title: 'Project name', description: 'A familiar label for the website workspace.', use: 'Choose a name you will recognize quickly; it does not need to match the domain.' },
  projectDomain: { title: 'Root domain', description: 'The exact website origin Pathproof is allowed to test.', use: 'Enter example.com or a complete HTTP(S) origin.', caution: 'Private networks, credentials in URLs, and duplicate origins are blocked.' },
  createProject: { title: 'Create project', description: 'Saves the website workspace and opens it.', use: 'After this, create the first automated test from important starting pages.', caution: 'Creating a project does not start browser discovery.' },
  editProject: { title: 'Edit project', description: 'Changes the project’s display name or corrects its exact website origin.', use: 'Use this when the live site redirects between variants such as example.com and www.example.com.', caution: 'The root domain is locked after tests exist because saved URLs and browser plans depend on it. The display name stays editable.' },
  importRecording: { title: 'Import recording from Chrome', description: 'Imports a JSON journey created by the Pathproof Chrome extension.', use: 'Record the journey in Chrome, download its JSON file, then select it here to create a replay-ready test.', caution: 'Use the Chrome Extension button in the top navigation to download the current ZIP.' },
  saveProject: { title: 'Save project changes', description: 'Applies the updated project name and root domain.', use: 'Check that the root domain matches the starting URLs you plan to test, including any www subdomain.', caution: 'Changing the root domain does not run browser setup.' },
  projectOrigin: { title: 'Project website', description: 'The configured website target for this project.', use: 'Open it in a new tab when you want to compare Pathproof evidence with the live site.' },
  newTest: { title: 'Create automated test', description: 'Creates one instruction-driven test for every starting URL.', use: 'Describe the goal once, then add one starting page per row.', caution: 'Safety-filtered setup can skip mutating, authenticated, or custom controls.' },
  projectStats: { title: 'Project summary', description: 'Shows total tests, replay-ready tests, and the most recent run.', use: 'Use it to understand setup progress before opening individual tests.' },
  testsSection: { title: 'Automated tests', description: 'Reusable website journeys learned once and replayed later.', use: 'Each test should represent one focused critical path.' },
  testRow: { title: 'Test overview', description: 'Starting pages, saved steps, discovery breadth, current state, and available actions for one journey.', use: 'Run it, watch active work, or open its latest report.' },
  testStatus: { title: 'Readiness and latest result', description: 'Ready to rerun means a plan exists. A separate result tells you whether the latest run passed or failed.', use: 'Read both signals: readiness answers “can it run?” and result answers “did it work?”' },
  startingUrls: { title: 'Starting URLs', description: 'The page where each instruction-driven test begins.', use: 'Every URL is stored as a separate automated test.' },
  savedSteps: { title: 'Saved steps', description: 'Recorded navigation, render checks, scrolling, and safe interactions.', use: 'These exact steps run again after future releases.' },
  breadth: { title: 'Discovery breadth', description: 'A rough indication of pages and safe interactions found during setup.', use: 'Compare the size of discovered journeys at a glance.', caution: 'It is not a whole-site coverage score.' },
  testProgress: { title: 'Test progress', description: 'The current browser action and completion percentage.', use: 'Closing the viewer does not stop this background work.' },
  watchLive: { title: 'Watch live', description: 'Opens a view-only browser preview and ordered activity log.', use: 'Observe navigation, scrolling, and interactions while a run is active.', caution: 'The preview is not a remote-control browser.' },
  runTest: { title: 'Run saved test', description: 'Replays the stored Playwright plan without AI.', use: 'Run it after a deployment to check the same behaviors and expected results.' },
  retryDiscovery: { title: 'Create replacement test', description: 'Opens setup again after discovery could not create a saved plan.', use: 'Try a smaller set of public, same-origin starting pages.' },
  viewReport: { title: 'View report', description: 'Opens the latest run evidence for this test.', use: 'Inspect failed steps, expected versus actual results, screenshots, and timing.' },
  recentRuns: { title: 'Recent runs', description: 'The six newest discoveries and replays for this project.', use: 'Open a run to compare evidence, rename saved replays, or select one or more completed runs to delete their history.', caution: 'Run deletion keeps the automated test and reusable Pathfinder steps. Active runs must finish or be stopped first.' },
  runRow: { title: 'Run history item', description: 'Shows the run type, time, AI usage, and final result.', use: 'Open an active item to watch it or a completed item to inspect the report.' },
  discoveryFlow: { title: 'First-run setup', description: 'AI follows your instructions separately from every starting URL and saves replay-ready plans.', use: 'Provide one clear goal that applies to every row.' },
  testName: { title: 'Test name', description: 'The shared name prefix used in the project and future reports.', use: 'Describe the behavior; Pathproof adds the page label when several URLs are supplied.' },
  seedUrls: { title: 'Starting URLs', description: 'One or more complete HTTP(S) pages, with each row becoming a separate automated test.', use: 'Add one starting page per row.', caution: 'Every URL must match the project’s exact origin. A www host and the same domain without www count as different origins.' },
  smartDiscovery: { title: 'AI instructions', description: 'The primary goal AI follows one safe action at a time, observing the page again after menus, navigation, and scrolling.', use: 'State actions and exact form values in order. You can import consent cookies and attach test files before setup.', caution: 'AI can use forms, drag-and-drop, canvas gestures, custom controls, open shadow DOM, and same-origin tabs. Mutating requests, CAPTCHAs, browser permission dialogs, extensions, cross-origin pages, and closed shadow DOM remain protected or unavailable.' },
  startDiscovery: { title: 'Create automated tests', description: 'Creates and queues one setup run per starting URL.', use: 'Begin after checking the name, URL rows, and AI instructions.' },
  runPanel: { title: 'Live browser and report', description: 'One panel shows active execution or completed evidence.', use: 'Watch progress, pause or resume at a safe checkpoint, stop an active run, or replay a completed test again.', caution: 'Closing the panel never cancels a run. Use Stop when you want execution to end.' },
  runProgress: { title: 'Run progress', description: 'The current action and percentage through discovery or the saved plan.', use: 'Use it to confirm the runner is advancing.' },
  runMode: { title: 'Run mode', description: 'Distinguishes AI-assisted discovery, local smart discovery, and saved no-AI replay.', use: 'Check how this run was produced.' },
  runDuration: { title: 'Run duration', description: 'How long browser execution took or whether it is still in progress.', use: 'Unusual duration can help identify slow pages or timeouts.' },
  browserPreview: { title: 'Browser preview', description: 'The latest screenshot and URL from the real Chromium worker.', use: 'See where Pathproof is and what it is inspecting.', caution: 'Frames update after actions and may lag slightly.' },
  activity: { title: 'Activity and evidence', description: 'An ordered log of navigation, inspection, scrolling, actions, warnings, and assertions.', use: 'Follow a live run or find the exact failed step in a report.' },
  followLogs: { title: 'Follow logs', description: 'Controls whether the activity panel stays attached to the newest event.', use: 'Select Follow logs to keep jumping to new entries. Select Unfollow logs to hold your current reading position.', caution: 'Following is off by default, so opening a run never moves you away from earlier evidence.' },
  runSummary: { title: 'Run result', description: 'The overall pass/fail outcome and check totals.', use: 'Start here, then read individual evidence before sharing a regression.' },
  downloadLogs: { title: 'Download logs', description: 'Downloads the complete run timeline as JSON together with the saved interaction baseline and expected-versus-actual comparisons.', use: 'Attach it to an issue or inspect every saved-test interaction in detail.', caution: 'Screenshots stay in Pathproof and are not embedded in the JSON log.' },
} satisfies Record<string, HelpEntry>;

export type HelpTopic = keyof typeof HELP_ENTRIES;
type OpenHelp = (topic: HelpTopic, context?: string) => void;
type HelpContextValue = {
  openHelp: OpenHelp;
  startHereHidden: boolean;
  hideStartHere: () => void;
  showStartHere: () => void;
};
const HelpContext = createContext<HelpContextValue | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ topic: HelpTopic; context?: string } | null>(null);
  const [startHereHidden, setStartHereHidden] = useState(() => window.localStorage.getItem(START_HERE_STORAGE_KEY) === 'true');
  const hideStartHere = () => { window.localStorage.setItem(START_HERE_STORAGE_KEY, 'true'); setStartHereHidden(true); };
  const showStartHere = () => { window.localStorage.removeItem(START_HERE_STORAGE_KEY); setStartHereHidden(false); };
  return <HelpContext.Provider value={{ openHelp: (topic, context) => setOpen({ topic, context }), startHereHidden, hideStartHere, showStartHere }}>
    {children}
    {open && <HelpDialog topic={open.topic} context={open.context} startHereHidden={startHereHidden} onShowStartHere={() => { showStartHere(); setOpen(null); }} onClose={() => setOpen(null)} />}
  </HelpContext.Provider>;
}

export function useHelp() {
  const help = useContext(HelpContext);
  if (!help) throw new Error('useHelp must be used inside HelpProvider');
  return help.openHelp;
}

export function useStartHere() {
  const help = useContext(HelpContext);
  if (!help) throw new Error('useStartHere must be used inside HelpProvider');
  return { hidden: help.startHereHidden, hide: help.hideStartHere };
}

export function HelpButton({ topic, context, label, className = '' }: { topic: HelpTopic; context?: string; label?: string; className?: string }) {
  const openHelp = useHelp();
  const entry = HELP_ENTRIES[topic];
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault(); event.stopPropagation(); openHelp(topic, context);
  }
  return <button type="button" className={`help-trigger ${label ? 'with-label' : ''} ${className}`.trim()} aria-label={`Help: ${entry.title}`} aria-haspopup="dialog" title={`Help: ${entry.title}`} onClick={handleClick}>
    <CircleHelp size={label ? 16 : 15} />{label && <span>{label}</span>}
  </button>;
}

function HelpDialog({ topic, context, startHereHidden, onShowStartHere, onClose }: { topic: HelpTopic; context?: string; startHereHidden: boolean; onShowStartHere: () => void; onClose: () => void }) {
  const entry: HelpEntry = HELP_ENTRIES[topic];
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add('help-open'); closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.body.classList.remove('help-open'); document.removeEventListener('keydown', keydown, true); previous?.focus(); };
  }, [onClose]);

  const concise = (value: string, max = 150) => {
    const firstSentence = value.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? value;
    return firstSentence.length <= max ? firstSentence : `${firstSentence.slice(0, max - 1).trimEnd()}…`;
  };

  return createPortal(<div className="help-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={dialogRef} className="help-dialog" data-overlay role="dialog" aria-modal="true" aria-labelledby="help-dialog-title" aria-describedby="help-dialog-description" tabIndex={-1}>
      <div className="help-dialog-top">
        <span className="help-dialog-icon"><CircleHelp size={22} /></span>
        <button ref={closeRef} type="button" className="icon-button" aria-label="Close help" onClick={onClose}><X size={19} /></button>
      </div>
      <p className="eyebrow"><ShieldCheck size={13} /> PATHPROOF GUIDE</p>
      <h2 id="help-dialog-title">{entry.title}</h2>
      <p id="help-dialog-description" className="help-description">{concise(entry.description)}</p>
      {context && <div className="help-context"><span>{concise(context)}</span></div>}
      <div className="help-quick-row"><ArrowRight size={16} /><span>{concise(entry.use)}</span></div>
      {entry.caution && <div className="help-quick-row caution"><Lightbulb size={16} /><span>{concise(entry.caution)}</span></div>}
      {topic === 'overview' && startHereHidden && <button type="button" className="subtle-button help-show-start" onClick={onShowStartHere}>Show START HERE</button>}
      <button type="button" className="primary-button help-done" onClick={onClose}>Close</button>
    </aside>
  </div>, document.body);
}
