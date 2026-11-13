export const THUMB_QUALITY = 40;
export const THUMB_WIDTH = 480;
/** Kept under the 1MB host frame limit, including JSON around the image. */
export const MAX_THUMB_CHARS = 200_000;
export const IDLE_MS = 30_000;
export const SUBSCRIBER_STALE_MS = 2_500;

export type BrowserAction = { at: string; summary: string };

export type BrowserActivity = {
  active: boolean;
  streaming: boolean;
  thumbnail: string;
  url: string;
  site: string;
  currentStep: string;
  pendingApproval?: { id: string; summary: string };
  recentActions: BrowserAction[];
  busy: boolean;
};

export function thumbParams(): Record<string, unknown> {
  return {
    format: "jpeg",
    quality: THUMB_QUALITY,
    clip: { x: 0, y: 0, width: THUMB_WIDTH, height: 270, scale: 1 },
  };
}

export function shouldStream(input: {
  visible: boolean;
  subscribers: number;
  sessionOpen: boolean;
  idleMs: number;
}): boolean {
  return (
    input.visible &&
    input.subscribers > 0 &&
    input.sessionOpen &&
    input.idleMs < IDLE_MS
  );
}

export function stepText(summary: string): string {
  const click = /click "([^"]+)"/i.exec(summary);
  if (click?.[1]) {
    return `Clicking "${click[1]}"`;
  }
  const typed = /type "[^"]*" into "([^"]+)"/i.exec(summary);
  if (typed?.[1]) {
    return `Typing into "${typed[1]}"`;
  }
  const doneRead = /^done read\s+(\S+)/i.exec(summary);
  if (doneRead?.[1]) {
    return `Read ${doneRead[1].replace(/[.,]+$/, "")}`;
  }
  const doneNavigate = /^done navigate\s+(\S+)/i.exec(summary);
  if (doneNavigate?.[1]) {
    return `Opened ${doneNavigate[1].replace(/[.,]+$/, "")}`;
  }
  const reading = /\bread(?:ing)?\s+(\S+)/i.exec(summary);
  if (reading?.[1]) {
    return `Reading ${reading[1].replace(/[.,]+$/, "")}`;
  }
  const open = /(?:visit|navigate to|open)\s+(\S+)/i.exec(summary);
  if (open?.[1]) {
    return `Opening ${open[1].replace(/[.,]+$/, "")}`;
  }
  return summary;
}

type PreviewSource = {
  sessionOpen(): boolean;
  lastActionAt(): number;
  currentStep(): string;
  pageUrl(): string;
  site(): string;
  pendingApproval(): { id: string; summary: string } | undefined;
  recentActions(): BrowserAction[];
  capture(): Promise<string>;
  busy?(): boolean;
  wantsThumb?(): boolean;
};

/** Decides when Home should receive browser thumbnails. */
export class BrowserPreview {
  private visible = false;
  private subscribers = 0;
  private lastBeat = 0;
  private thumbnail = "";
  private streaming = false;
  private stopTimer: (() => void) | null = null;

  constructor(
    private readonly source: PreviewSource,
    private readonly emit: (event: BrowserActivity) => void,
    private readonly now: () => number = Date.now,
    private readonly schedule: (tick: () => void) => () => void = (tick) => {
      const id = setInterval(tick, 1_000);
      return () => clearInterval(id);
    },
  ) {}

  watch(visible: boolean): BrowserActivity {
    const now = this.now();
    this.visible = visible;
    if (visible) {
      this.subscribers = 1;
      this.lastBeat = now;
    } else {
      this.subscribers = 0;
    }
    this.sync();
    return this.snapshot();
  }

  stop(): void {
    this.visible = false;
    this.subscribers = 0;
    this.sync();
  }

  async pump(): Promise<BrowserActivity> {
    this.sync();
    if (this.streaming) {
      try {
        const frame = await this.source.capture();
        if (frame.length > 0 && frame.length <= MAX_THUMB_CHARS) {
          this.thumbnail = frame;
        }
      } catch {
        // A missed frame leaves the last thumbnail in place.
      }
      const payload = this.snapshot();
      this.emit(payload);
      return payload;
    }
    if (!this.source.sessionOpen()) {
      this.thumbnail = "";
    }
    return this.snapshot();
  }

  snapshot(): BrowserActivity {
    const open = this.source.sessionOpen();
    const site = this.source.site();
    const summary = this.source.currentStep();
    return {
      active: open,
      streaming: this.streaming && open,
      thumbnail:
        open && this.source.wantsThumb?.() !== false ? this.thumbnail : "",
      url: this.source.pageUrl(),
      site,
      currentStep:
        summary.length > 0 ? stepText(summary) : open ? `On ${site}` : "",
      pendingApproval: this.source.pendingApproval(),
      recentActions: this.source.recentActions().slice(0, 5),
      busy: this.source.busy?.() === true,
    };
  }

  private streamingNow(): boolean {
    const now = this.now();
    if (this.lastBeat > 0 && now - this.lastBeat > SUBSCRIBER_STALE_MS) {
      this.subscribers = 0;
    }
    const last = this.source.lastActionAt();
    const idleMs = last > 0 ? Math.max(0, now - last) : 0;
    return shouldStream({
      visible: this.visible,
      subscribers: this.subscribers,
      sessionOpen: this.source.sessionOpen(),
      idleMs,
    });
  }

  private sync(): void {
    const on = this.streamingNow();
    this.streaming = on;
    if (on && !this.stopTimer) {
      this.stopTimer = this.schedule(() => {
        void this.pump();
      });
    }
    if (!on && this.stopTimer) {
      this.stopTimer();
      this.stopTimer = null;
    }
  }
}
