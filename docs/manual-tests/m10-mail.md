# M10 mail check

The app ships a sample mailbox of 30 messages. The list shows each sender, subject, date, and thread. Adding an `.eml` file shows it on the next refresh. The sample files are not modified.

Follow-ups are the threads where a reply is overdue. The digest names every thread from the last 24 hours of the sample clock. Marking a thread handled removes it from follow-ups. Those lists are checked in CI.

Draft a reply. It waits on Approvals even when send is allowed. Edit it, then approve: one `.eml` lands in the local outbox, threaded to the original, with the edit in the body, and the decision is on Activity. Deny writes nothing. Snooze brings the draft back at its time. A network monitor shows no outbound traffic during the send. CI checks that the send path does not call the network.
