export type ProjectStatus = 'ready' | 'running' | 'attention' | 'empty';
export type TestStatus = 'discovering' | 'ready' | 'passed' | 'failed';
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'interrupted';

export interface Project {
  id: string;
  name: string;
  origin: string;
  createdAt: string;
  status: ProjectStatus;
  lastRunAt?: string;
}

export interface TestDefinition {
  id: string;
  projectId: string;
  name: string;
  seedUrls: string[];
  status: TestStatus;
  coverage: number;
  createdAt: string;
  lastRunId?: string;
  plan?: TestPlan;
  source?: 'discovery' | 'recording';
  recording?: RecordingSummary;
  browserState?: BrowserReplayState;
  aiInstructions?: string;
  files?: TestFileAttachment[];
}

export interface TestFileAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  size: number;
}

export type StepKind = 'navigate' | 'scroll' | 'hover' | 'click' | 'sort' | 'filter' | 'fill' | 'select' | 'select-text' | 'check' | 'keypress' | 'drag-drop' | 'canvas-draw' | 'file' | 'assert';

export interface PlanStep {
  id: string;
  kind: StepKind;
  label: string;
  url: string;
  locator?: { role?: string; name?: string; selector?: string };
  expected?: string;
  metadata?: Record<string, unknown>;
}

export interface TestPlan {
  version: 1;
  pages: string[];
  steps: PlanStep[];
  generatedBy: 'local-smart-discovery' | 'ai-assisted' | 'browser-recording';
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | 'no_restriction' | 'lax' | 'strict' | 'unspecified';
}

export interface BrowserReplayState {
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
  cookies?: BrowserCookie[];
  cookieHeader?: string;
  localStorage?: Record<string, string>;
}

export type RecordedEventKind =
  | 'navigation' | 'click' | 'dblclick' | 'pointerdown' | 'pointerup' | 'input' | 'change' | 'keydown' | 'focus'
  | 'scroll' | 'mousemove' | 'resize' | 'dom-mutation' | 'network-request'
  | 'network-response' | 'console' | 'exception' | 'lifecycle' | 'screenshot' | 'video-frame' | 'snapshot';

export interface RecordedEvent {
  id: string;
  sequence: number;
  at: string;
  offsetMs: number;
  kind: RecordedEventKind;
  url: string;
  frameUrl?: string;
  selector?: string;
  role?: string;
  accessibleName?: string;
  tagName?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  scrollX?: number;
  scrollY?: number;
  width?: number;
  height?: number;
  text?: string;
  data?: Record<string, unknown>;
}

export interface PathproofRecording {
  format: 'pathproof-recording';
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
  target: { tabId?: number; initialUrl: string; finalUrl: string; title?: string };
  options?: { captureMouseMoves?: boolean; captureNetwork?: boolean; captureDom?: boolean; captureScreenshots?: boolean; captureStream?: boolean; includeCookies?: boolean };
  browser: BrowserReplayState & { platform?: string; language?: string; window?: { width: number; height: number; state?: string } };
  events: RecordedEvent[];
  diagnostics?: Record<string, unknown>;
}

export interface RecordingSummary {
  recordingId: string;
  importedAt: string;
  startedAt: string;
  durationMs: number;
  eventCount: number;
  actionCount: number;
  finalUrl: string;
  hasCookies: boolean;
  streamFrameCount?: number;
}

export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  type: 'status' | 'navigate' | 'inspect' | 'scroll' | 'action' | 'assert' | 'warning' | 'complete';
  label: string;
  url?: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'skipped';
  expected?: string;
  actual?: string;
}

export interface Run {
  id: string;
  name?: string;
  projectId: string;
  testId: string;
  kind: 'discovery' | 'replay';
  aiUsed: boolean;
  status: RunStatus;
  progress: number;
  currentUrl?: string;
  currentAction?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  events: RunEvent[];
  error?: string;
  expected?: string;
  actual?: string;
  frameVersion: number;
  playbackSpeed?: number;
  controlState?: 'running' | 'paused';
}

export interface DashboardProject extends Project {
  tests: number;
  readyTests: number;
  lastRun?: Run;
}

export interface ProjectDetail {
  project: Project;
  tests: TestDefinition[];
  runs: Run[];
}
