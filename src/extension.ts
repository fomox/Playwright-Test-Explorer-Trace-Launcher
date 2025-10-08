import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('openTraceViewer.open', async (testItem: vscode.TestItem) => {
    try {
      console.log('openTraceViewer.open command triggered', testItem ? { label: testItem.label, uri: testItem.uri?.toString() } : 'no testItem');

      const workspace = pickWorkspaceForTest(testItem);
      if (!workspace) {
        vscode.window.showErrorMessage('Could not determine a workspace folder for the selected test.');
        return;
      }

      const cfg = vscode.workspace.getConfiguration('openTraceViewer');
      const debugOrRelease = cfg.get<'Debug' | 'Release'>('search.debugOrRelease', 'Debug');
      const maxResults = cfg.get<number>('search.maxResults', 2000);
      const strategy = cfg.get<'filename' | 'pathContains' | 'both'>('search.traceNameStrategy', 'both');
      const extraTraceGlobs = cfg.get<string[]>('search.additionalTraceGlobs', []);

      const testName = sanitizeTestName(testItem.label ?? '');
      if (!testName) {
        vscode.window.showErrorMessage('Test name is empty or invalid.');
        return;
      }

      // 1) Find playwright.ps1 under bin/<Debug|Release>/net*/playwright.ps1
      const pwScript = await findPlaywrightScript(workspace, debugOrRelease, maxResults);
      if (!pwScript) {
        vscode.window.showErrorMessage(`Could not find playwright.ps1 in ${debugOrRelease} build output (bin/${debugOrRelease}/net*/playwright.ps1). Make sure you have built the project with Playwright installed.`);
        return;
      }

      // 2) Find a matching trace zip by test name
      const traceZip = await findTraceZip(workspace, testName, strategy, extraTraceGlobs, maxResults);
      if (!traceZip) {
        vscode.window.showErrorMessage(`Could not find a trace zip for test "${testName}".`);
        return;
      }

      // 3) Run: pwsh bin/Debug/netX/playwright.ps1 show-trace trace.zip
      const cwd = workspace.uri.fsPath;
      const cmd = await resolvePwsh();
      if (!cmd) {
        vscode.window.showErrorMessage('PowerShell (pwsh) not found in PATH. Install PowerShell 7+ or add pwsh to PATH.');
        return;
      }

      const args = [pwScript, 'show-trace', traceZip];
      const status = vscode.window.setStatusBarMessage('Opening Playwright Trace Viewer…');

      try {
        // Use execFile to avoid shell quoting issues
        await execFileAsync(cmd, args, { cwd });
        // Playwright opens an external browser window; nothing else to do.
      } finally {
        status.dispose();
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Open Trace Viewer failed: ${err?.message ?? String(err)}`);
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

/** Prefer the workspace that contains the test’s file, else the first workspace. */
function pickWorkspaceForTest(testItem: vscode.TestItem): vscode.WorkspaceFolder | undefined {
  if (testItem.uri) {
    const ws = vscode.workspace.getWorkspaceFolder(testItem.uri);
    if (ws) return ws;
  }
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}

function sanitizeTestName(name: string): string {
  // Keep it lenient; used for searching. Collapse whitespace.
  return name.trim().replace(/\s+/g, ' ');
}

/** Find the newest/highest netX folder's playwright.ps1 under bin/<cfg>/net{version}/playwright.ps1 */
async function findPlaywrightScript(
  workspace: vscode.WorkspaceFolder,
  config: 'Debug' | 'Release',
  maxResults: number
): Promise<string | undefined> {
  const pattern = new vscode.RelativePattern(workspace, `**/bin/${config}/net*/playwright.ps1`);
  const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);

  if (!uris.length) return undefined;

  // Sort by TFM numeric (net8.0 > net7.0 > net6.0), then by path length as a tiebreaker.
  const scored = uris
    .map(u => ({ uri: u, score: tfmScore(u.fsPath) }))
    .sort((a, b) => b.score - a.score || a.uri.fsPath.length - b.uri.fsPath.length);

  return scored[0].uri.fsPath;
}

function tfmScore(p: string): number {
  // Extract first "netX.Y" or "netX" occurrence
  const m = /[\\\/](net(\d+)(?:\.(\d+))?)[\\\/]/i.exec(p);
  if (!m) return 0;
  const major = parseInt(m[2] || '0', 10);
  const minor = parseInt(m[3] || '0', 10);
  return major * 100 + minor; // net8.0 -> 800, net7.0 -> 700, etc.
}

/** Find a trace zip that matches the test name by filename/path, plus user-provided globs. */
async function findTraceZip(
  workspace: vscode.WorkspaceFolder,
  testName: string,
  strategy: 'filename' | 'pathContains' | 'both',
  extraGlobs: string[],
  maxResults: number
): Promise<string | undefined> {
  const nameForGlob = escapeForGlob(testName).replace(/\s+/g, '*'); // allow gaps between words

  // Candidate patterns:
  const baseGlobs = new Set<string>([
    `**/${nameForGlob}.zip`,
    `**/${nameForGlob}*.zip`,
    `**/*${nameForGlob}*/trace.zip`,
    `**/*${nameForGlob}*/*trace*.zip`
  ]);
  for (const g of extraGlobs) baseGlobs.add(g);

  // Collect candidates
  const results: vscode.Uri[] = [];
  for (const g of baseGlobs) {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(workspace, g), '**/node_modules/**', Math.ceil(maxResults / baseGlobs.size));
    for (const u of uris) results.push(u);
  }

  if (!results.length) return undefined;

  // Rank by closeness of match and recency
  const lowerName = testName.toLowerCase();

  type Candidate = { uri: vscode.Uri; rank: number; mtime: number };
  const ranked: Candidate[] = [];

  for (const uri of uniqueUris(results)) {
    let rank = 0;
    const file = path.basename(uri.fsPath).toLowerCase();
    const full = uri.fsPath.toLowerCase();

    const filenameMatches = file.includes(lowerName);
    const pathMatches = full.includes(lowerName);

    if (strategy === 'filename' && filenameMatches) rank += 100;
    if (strategy === 'pathContains' && pathMatches) rank += 100;
    if (strategy === 'both') {
      if (filenameMatches) rank += 70;
      if (pathMatches) rank += 50;
    }

    // Prefer files literally named trace.zip but under a folder with the test name
    if (/trace\.zip$/i.test(file) && pathMatches) rank += 30;

    // Prefer anything under bin/<cfg> or TestResults
    if (/[/\\](bin|TestResults|playwright)[/\\]/i.test(full)) rank += 10;

    // Recent files first
    let mtime = 0;
    try {
      const stat = fs.statSync(uri.fsPath);
      mtime = stat.mtimeMs;
    } catch {
      // ignore
    }

    ranked.push({ uri, rank, mtime });
  }

  ranked.sort((a, b) => b.rank - a.rank || b.mtime - a.mtime);
  return ranked[0]?.uri.fsPath;
}

function uniqueUris(list: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];
  for (const u of list) {
    const key = u.fsPath.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

function escapeForGlob(s: string): string {
  // VS Code glob escape for [, ], {, }, ?, *, \
  return s.replace(/([\\\{\}\[\]\?\*])/g, '[$1]');
}

/** Try to resolve `pwsh` executable (PowerShell 7+) */
async function resolvePwsh(): Promise<string | undefined> {
  // If pwsh is on PATH, we can just call "pwsh"
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'pwsh']
    : ['pwsh'];

  for (const c of candidates) {
    try {
      await execFileAsync(c, ['-v']);
      return c;
    } catch {
      // try next
    }
  }

  // Common install locations (best-effort)
  const guessPaths =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'
        ]
      : ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh'];

  for (const gp of guessPaths) {
    if (fs.existsSync(gp)) return gp;
  }

  return undefined;
}