import { expect, test } from "bun:test";
import {
  type BrowserActivity,
  BrowserPreview,
  shouldStream,
  THUMB_QUALITY,
  THUMB_WIDTH,
  thumbParams,
} from "./preview.ts";

test("streaming runs only while a visible subscriber has a live session", () => {
  expect(
    shouldStream({
      visible: true,
      subscribers: 1,
      sessionOpen: true,
      idleMs: 0,
    }),
  ).toBe(true);
  expect(
    shouldStream({
      visible: false,
      subscribers: 1,
      sessionOpen: true,
      idleMs: 0,
    }),
  ).toBe(false);
  expect(
    shouldStream({
      visible: true,
      subscribers: 0,
      sessionOpen: true,
      idleMs: 0,
    }),
  ).toBe(false);
  expect(
    shouldStream({
      visible: true,
      subscribers: 1,
      sessionOpen: false,
      idleMs: 0,
    }),
  ).toBe(false);
  expect(
    shouldStream({
      visible: true,
      subscribers: 1,
      sessionOpen: true,
      idleMs: 30_000,
    }),
  ).toBe(false);
});

test("thumbnail capture asks for a small jpeg", () => {
  const params = thumbParams();
  expect(params.format).toBe("jpeg");
  expect(params.quality).toBe(THUMB_QUALITY);
  const clip = params.clip as { width: number };
  expect(clip.width).toBe(THUMB_WIDTH);
  expect(THUMB_QUALITY).toBe(40);
  expect(THUMB_WIDTH).toBe(480);
});

test("a visible subscriber starts frames and hiding or idle stops them", async () => {
  let clock = 1_000_000;
  let session = true;
  const lastAction = clock;
  let frames = 0;
  const timer: { tick: (() => void) | null } = { tick: null };
  let stopped = 0;
  const events: BrowserActivity[] = [];
  const preview = new BrowserPreview(
    {
      sessionOpen: () => session,
      lastActionAt: () => lastAction,
      currentStep: () => 'click "More information..." on example.com',
      pageUrl: () => "https://example.com/",
      site: () => "example.com",
      pendingApproval: () => undefined,
      recentActions: () => [],
      capture: async () => {
        frames += 1;
        return "frame";
      },
    },
    (event) => events.push(event),
    () => clock,
    (fn) => {
      timer.tick = fn;
      return () => {
        stopped += 1;
        timer.tick = null;
      };
    },
  );

  const started = preview.watch(true);
  expect(started.streaming).toBe(true);
  expect(started.currentStep).toBe('Clicking "More information..."');
  if (!timer.tick) {
    throw new Error("the preview did not start");
  }
  await timer.tick();
  expect(frames).toBe(1);
  expect(events.at(-1)?.thumbnail).toBe("frame");

  preview.watch(false);
  expect(stopped).toBe(1);
  expect(preview.snapshot().streaming).toBe(false);
  const framesAfterHide = frames;
  await preview.pump();
  expect(frames).toBe(framesAfterHide);

  preview.watch(true);
  expect(preview.snapshot().streaming).toBe(true);
  clock += 31_000;
  preview.watch(true);
  expect(preview.snapshot().streaming).toBe(false);
  expect(stopped).toBe(2);

  clock = lastAction;
  session = false;
  preview.watch(true);
  expect(preview.snapshot().streaming).toBe(false);
  expect(preview.snapshot().active).toBe(false);
});
