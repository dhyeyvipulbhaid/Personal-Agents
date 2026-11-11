const digest = document.getElementById("digest");
const followUps = document.getElementById("follow-ups");
const messages = document.getElementById("messages");
const status = document.getElementById("mail-status");

function names(node, values, empty) {
  node.replaceChildren();
  const items = Array.isArray(values) && values.length > 0 ? values : [empty];
  for (const value of items) {
    const item = document.createElement("li");
    item.textContent = value;
    node.append(item);
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
    date.dateTime = message.date;
    date.textContent = formatDate(message.date);
    item.append(from, subject, date);
    if (message.id) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = "Draft reply";
      button.addEventListener("click", () => {
        button.disabled = true;
        window.pa
          .invoke("mail_draft", { id: message.id })
          .then(() => {
            status.textContent = `A reply to ${message.thread} is waiting on Approvals. Approve it to save the message in the local outbox.`;
          })
          .catch((error) => {
            status.textContent = window.pa.explain(error, "Mail");
            button.disabled = false;
          });
      });
      item.append(button);
    }
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
