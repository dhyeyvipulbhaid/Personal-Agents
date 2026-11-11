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
      item.append(draftControl(message));
    }
    messages.append(item);
  }
}

function draftControl(message) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = "Draft reply";
  const note = document.createElement("p");
  note.className = "notice";
  note.hidden = true;
  button.addEventListener("click", () => {
    if (button.disabled) {
      return;
    }
    button.disabled = true;
    button.textContent = "Drafting…";
    note.hidden = true;
    window.pa
      .invoke("mail_draft", { id: message.id })
      .then(() => {
        button.textContent = "Draft waiting in Approvals";
        const link = document.createElement("a");
        link.href = "approvals.html";
        link.textContent = "Approvals";
        button.after(link);
      })
      .catch((error) => {
        button.disabled = false;
        button.textContent = "Draft reply";
        note.hidden = false;
        note.textContent = window.pa.explain(error, "Draft");
      });
  });
  const wrap = document.createElement("span");
  wrap.className = "draft-action";
  wrap.append(button, note);
  return wrap;
}

async function showMail() {
  const parsed = JSON.parse(await window.pa.invoke("mail_state"));
  render(parsed);
}

showMail().catch((error) => {
  messages.textContent = window.pa.explain(error, "Mail");
});
