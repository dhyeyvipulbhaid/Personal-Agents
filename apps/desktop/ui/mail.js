const digest = document.getElementById("digest");
const followUps = document.getElementById("follow-ups");
const messages = document.getElementById("messages");

function names(node, values, empty) {
  node.replaceChildren();
  const items = Array.isArray(values) && values.length > 0 ? values : [empty];
  for (const value of items) {
    const item = document.createElement("li");
    item.textContent = value;
    node.append(item);
  }
}

function render(state) {
  names(digest, state.digest, "No threads in the sample digest.");
  names(followUps, state.followUps, "No follow-ups in the sample mailbox.");
  messages.replaceChildren();
  for (const message of state.messages ?? []) {
    const item = document.createElement("li");
    const from = document.createElement("span");
    from.textContent = message.from;
    const subject = document.createElement("span");
    subject.textContent = message.subject;
    const date = document.createElement("time");
    date.textContent = message.date;
    const thread = document.createElement("span");
    thread.textContent = message.thread;
    item.append(from, subject, date, thread);
    messages.append(item);
  }
}

async function showMail() {
  const parsed = JSON.parse(await window.pa.invoke("mail_state"));
  render(parsed);
}

showMail().catch((error) => {
  messages.textContent = window.pa.explain(error, "Mail");
});
