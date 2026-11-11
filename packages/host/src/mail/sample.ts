export const SAMPLE_NOW = Date.parse("2026-11-11T12:00:00.000Z");
export const MAIL_USER = "employee@example.com";
export const FOLLOW_UP_DAYS = 2;

export const FOLLOW_UPS = ["North contract", "Q4 plan", "West renewal"];
export const DIGEST_THREADS = ["Budget notes", "Desk request", "Lunch"];

export type SampleMessage = {
  id: string;
  inReplyTo?: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string;
};

type ThreadPlan = {
  subject: string;
  slug: string;
  turns: { from: string; date: string }[];
};

const plans: ThreadPlan[] = [
  {
    subject: "North contract",
    slug: "north",
    turns: [
      { from: "a@example.com", date: "2026-10-28T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-10-29T12:00:00.000Z" },
      { from: "a@example.com", date: "2026-10-30T12:00:00.000Z" },
      { from: "a@example.com", date: "2026-11-01T12:00:00.000Z" },
    ],
  },
  {
    subject: "South invoice",
    slug: "south",
    turns: [
      { from: "b@example.com", date: "2026-10-30T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-10-31T12:00:00.000Z" },
      { from: "b@example.com", date: "2026-11-01T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-11-02T12:00:00.000Z" },
    ],
  },
  {
    subject: "West renewal",
    slug: "west",
    turns: [
      { from: "b@example.com", date: "2026-11-02T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-11-03T12:00:00.000Z" },
      { from: "b@example.com", date: "2026-11-04T12:00:00.000Z" },
      { from: "b@example.com", date: "2026-11-05T12:00:00.000Z" },
    ],
  },
  {
    subject: "Budget notes",
    slug: "budget",
    turns: [
      { from: "c@example.com", date: "2026-11-08T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-11-08T18:00:00.000Z" },
      { from: "c@example.com", date: "2026-11-09T12:00:00.000Z" },
      { from: "c@example.com", date: "2026-11-10T13:00:00.000Z" },
    ],
  },
  {
    subject: "Lunch",
    slug: "lunch",
    turns: [
      { from: "c@example.com", date: "2026-11-11T07:00:00.000Z" },
      { from: MAIL_USER, date: "2026-11-11T07:30:00.000Z" },
      { from: MAIL_USER, date: "2026-11-11T08:00:00.000Z" },
    ],
  },
  {
    subject: "Q4 plan",
    slug: "q4",
    turns: [
      { from: "a@example.com", date: "2026-09-28T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-09-29T12:00:00.000Z" },
      { from: "a@example.com", date: "2026-09-30T12:00:00.000Z" },
      { from: "a@example.com", date: "2026-10-01T12:00:00.000Z" },
    ],
  },
  {
    subject: "Desk request",
    slug: "desk",
    turns: [
      { from: "b@example.com", date: "2026-11-11T08:30:00.000Z" },
      { from: MAIL_USER, date: "2026-11-11T08:45:00.000Z" },
      { from: "b@example.com", date: "2026-11-11T09:00:00.000Z" },
    ],
  },
  {
    subject: "Archive",
    slug: "archive",
    turns: [
      { from: "c@example.com", date: "2026-10-12T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-10-13T12:00:00.000Z" },
      { from: "c@example.com", date: "2026-10-14T12:00:00.000Z" },
      { from: MAIL_USER, date: "2026-10-15T12:00:00.000Z" },
    ],
  },
];

export function sampleMessages(): SampleMessage[] {
  const messages: SampleMessage[] = [];
  for (const plan of plans) {
    let previous: string | undefined;
    plan.turns.forEach((turn, index) => {
      const id = `<${plan.slug}-${index + 1}@example.com>`;
      const subject = index === 0 ? plan.subject : `Re: ${plan.subject}`;
      const to = turn.from === MAIL_USER ? "a@example.com" : MAIL_USER;
      messages.push({
        id,
        inReplyTo: previous,
        from: turn.from,
        to,
        date: turn.date,
        subject,
        body: `${plan.subject} note ${index + 1}`,
      });
      previous = id;
    });
  }
  return messages;
}

export function toEml(message: SampleMessage): string {
  const lines = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date(message.date).toUTCString()}`,
    `Message-ID: ${message.id}`,
  ];
  if (message.inReplyTo) {
    lines.push(`In-Reply-To: ${message.inReplyTo}`);
  }
  lines.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.body,
  );
  return `${lines.join("\r\n")}\r\n`;
}
