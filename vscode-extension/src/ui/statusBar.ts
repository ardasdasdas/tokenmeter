import * as vscode from 'vscode';
import { getConfig } from '../config.ts';
import { TokenmeterError } from '../core/errors.ts';
import { LatestOnly } from '../core/latestOnly.ts';
import type { CountResult, TokenEngine } from '../engine/engine.ts';
import { countTarget } from './countTarget.ts';
import {
  clickToCountView,
  errorView,
  loadingView,
  resultView,
  type StatusView,
} from './statusModel.ts';

const DEBOUNCE_MS = 200;

interface Job {
  model: string;
  special: boolean;
  texts: string[];
  what: 'selection' | 'document';
  threshold: number;
}

interface Outcome {
  job: Job;
  result: CountResult;
}

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly engine: TokenEngine;
  private readonly latest: LatestOnly<Job, Outcome>;
  private readonly subs: vscode.Disposable[] = [];
  private readonly shownErrors = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;

  constructor(engine: TokenEngine) {
    this.engine = engine;
    this.latest = new LatestOnly((job) => this.count(job));
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'tokenmeter.selectModel';
    this.item.name = 'Tokenmeter';
    const w = vscode.window;
    this.subs.push(
      this.item,
      w.onDidChangeActiveTextEditor(() => this.schedule()),
      w.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === w.activeTextEditor) this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === w.activeTextEditor?.document) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('tokenmeter')) this.schedule();
      }),
    );
    this.schedule();
  }

  /** Text of the status bar item (test hook). */
  get text(): string {
    return this.item.text;
  }

  /** Counts now, even above maxDocumentSize. */
  countNow(): void {
    this.clearTimer();
    void this.refresh(true);
  }

  /** Refreshes soon and allows error messages to show again (e.g. after the token changed). */
  retry(): void {
    this.shownErrors.clear();
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.generation++;
    for (const d of this.subs) d.dispose();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(false);
    }, DEBOUNCE_MS);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async refresh(force: boolean): Promise<void> {
    const gen = ++this.generation;
    const editor = vscode.window.activeTextEditor;
    const target = editor && countTarget(editor.document, editor.selections);
    if (!editor || !target) {
      this.item.hide();
      return;
    }
    const cfg = getConfig();
    const size = target.texts.reduce((n, t) => n + t.length, 0);
    if (!force && size > cfg.maxDocumentSize) {
      this.show(clickToCountView(cfg.model));
      return;
    }
    this.show(loadingView());
    const job: Job = {
      model: cfg.model,
      special: cfg.includeSpecialTokens,
      texts: target.texts,
      what: target.what,
      threshold: cfg.warningThreshold,
    };
    try {
      const outcome = await this.latest.push(job);
      if (!outcome || gen !== this.generation || this.disposed) return;
      const view = resultView({
        currentModel: getConfig().model,
        result: outcome.result,
        what: outcome.job.what,
        threshold: outcome.job.threshold,
      });
      if (view) this.show(view);
    } catch (e) {
      if (gen !== this.generation || this.disposed) return;
      const code = e instanceof TokenmeterError ? e.code : 'internal';
      const message = e instanceof Error ? e.message : String(e);
      this.show(errorView(job.model, message));
      const key = `${job.model}|${code}`;
      if (!this.shownErrors.has(key)) {
        this.shownErrors.add(key);
        void vscode.window.showErrorMessage(message);
      }
    }
  }

  private async count(job: Job): Promise<Outcome> {
    let tokenCount = 0;
    let charCount = 0;
    let model = job.model;
    let source: CountResult['source'] = 'bundled';
    for (const text of job.texts) {
      const r = await this.engine.count(job.model, text, job.special);
      tokenCount += r.tokenCount;
      charCount += r.charCount;
      model = r.model;
      source = r.source;
    }
    return { job, result: { model, tokenCount, charCount, source } };
  }

  private show(view: StatusView): void {
    this.item.text = view.text;
    this.item.tooltip = new vscode.MarkdownString(view.tooltip.join('\n\n'));
    this.item.backgroundColor = view.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }
}
