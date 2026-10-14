import { emitKeypressEvents } from 'node:readline';
import type { SubmitFleet } from './service.js';
import type { Actor } from './workspaces.js';

const ESC = '\x1b[';
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const color = (n: number, s: string) => `${ESC}${n}m${s}${ESC}0m`;

const TABS = ['coverage', 'campaigns', 'queue'] as const;

/** Live terminal view: coverage, campaigns and the human-action queue. Keys: 1-3, r, p, q. */
export async function runTui(fleet: SubmitFleet, actor: Actor): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write('submitfleet tui needs an interactive terminal\n');
    return;
  }
  let tab: (typeof TABS)[number] = 'coverage';
  let note = '';
  const draw = async () => {
    const lines: string[] = [];
    const paused = await fleet.pausedState(actor);
    lines.push(`${bold('SubmitFleet')}  ${TABS.map((t, i) => (t === tab ? bold(`[${i + 1}] ${t}`) : dim(`[${i + 1}] ${t}`))).join('  ')}  ${paused ? color(31, 'PAUSED') : color(32, 'running')}`);
    lines.push('');
    if (tab === 'coverage') {
      const c = await fleet.coverageReport();
      for (const k of ['discovered', 'source_labeled_free', 'verified_free', 'permission_reviewed', 'live_tested', 'release_qualifying'] as const) {
        lines.push(`${k.replace(/_/g, ' ').padEnd(22)} ${String(c[k]).padStart(5)}`);
      }
      lines.push('');
      lines.push(c.status === 'release_ready' ? color(32, `release gate met (${c.release_qualifying}/${c.release_minimum})`) : color(33, `below_minimum: ${c.release_qualifying}/${c.release_minimum}`));
      const top = Object.entries(c.blocker_counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (top.length) lines.push('', bold('top blockers'), ...top.map(([b, n]) => `  ${String(n).padStart(5)}  ${b}`));
    } else if (tab === 'campaigns') {
      const cs = await fleet.campaignList(actor);
      if (!cs.length) lines.push(dim('no campaigns'));
      for (const c of cs.slice(0, 20)) {
        const st = await fleet.campaignStatus(actor, c.id);
        lines.push(`${c.id}  ${c.status.padEnd(22)} ${c.executable_count}/${c.min_executable}  ${Object.entries(st.intents).map(([k, v]) => `${k}:${v}`).join(' ')}`);
      }
    } else {
      const q = await fleet.humanQueue(actor);
      if (!q.length) lines.push(dim('nothing waiting for a person'));
      for (const i of q.slice(0, 30)) lines.push(`${String(i.destination).padEnd(24)} ${String(i.state).padEnd(12)} ${i.reason_code ?? ''}`);
    }
    lines.push('', dim('1-3 switch  r refresh  p pause all  q quit') + (note ? `  ${note}` : ''));
    process.stdout.write(`${ESC}2J${ESC}H${lines.join('\n')}\n`);
  };

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write(`${ESC}?25l`);
  const timer = setInterval(() => void draw(), 3000);
  await draw();
  await new Promise<void>((resolve) => {
    process.stdin.on('keypress', async (_s, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) return resolve();
      const n = Number(key.name);
      if (n >= 1 && n <= TABS.length) tab = TABS[n - 1]!;
      if (key.name === 'p') {
        await fleet.pauseAll(actor);
        note = color(31, 'all outbound writes paused');
      }
      await draw();
    });
  });
  clearInterval(timer);
  process.stdin.setRawMode(false);
  process.stdout.write(`${ESC}?25h${ESC}2J${ESC}H`);
  process.stdin.pause();
}
