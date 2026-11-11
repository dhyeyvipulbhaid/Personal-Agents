# 12-minute demo

Run this on device A and again on device B. Save a recording of each run. Use a standard account. Ollama is installed and running, with one model that supports tools. The sample revenue files and the sample mailbox ship with the app.

Do not fix the app by hand during the run. If a step fails, stop and note the step.

## 0:00 Install

1. Run `install.sh` or `install.ps1` with the bundle URL and its SHA-256.
2. There is no administrator password prompt.
3. Open Personal Agents. The window shows the name, the version, the agent host version, and the Hello widget.

## 1:00 Theme and chat

1. Switch Theme to Dark, then Light, then Follow system. The Hello frame follows.
2. Press Alt+C. Chat opens.
3. Send "What can you help me with?" The reply streams from the chat model. Note the first-token time.
4. Change the chat model and send one more message. The next reply uses the new model.

## 3:00 Revenue

1. Return Home. The revenue tile shows health, last refresh, next refresh, and waiting approvals.
2. The total matches the sample: North 100, South 80, West 40, total 220.
3. Edit the sample so North is 90. One alert fires.
4. Set North to 91. No new alert fires.

## 5:00 Mail

1. Open the sample mailbox. It lists 30 messages with sender, subject, date, and thread.
2. The digest names Budget notes, Desk request, and Lunch.
3. Follow-ups are North contract, Q4 plan, and West renewal.
4. Draft a reply to North contract. Edit the draft. Approve it. One `.eml` is in the local outbox, threaded to the original, with the edit in the body. Activity shows the decision.
5. Deny a second draft. The outbox does not gain a file.

## 8:00 Builder and memory

1. Ask the builder to "show total revenue as a big number". It installs a widget from a spec, with no generated code, after you approve the install.
2. In chat, say "the revenue total is 220".
3. Start a new session and ask for the revenue total. The fact returns with the earlier session as its source.
4. Delete the fact. Ask again. It does not return.

## 10:00 Approvals and the browser

1. Open Approvals. A waiting request is listed. Approve it. It leaves the list and Activity records it.
2. Open Capabilities. Available items are listed. If remote debugging is blocked, the row names `RemoteDebuggingAllowed`.
3. Start the browser task on the test page. The live view shows each step. The first visit to the site waits on Approvals. Approve it.
4. Press Stop. The session ends within 2 seconds.

## 12:00 Close

Quit the app. The recording is the acceptance for this device.
