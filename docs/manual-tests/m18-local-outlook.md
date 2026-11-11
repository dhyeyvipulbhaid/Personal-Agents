# M18 local Outlook check

Personal Agents reads the Outlook app that is already signed in on this computer. It does not use Microsoft Graph, a cloud token, or a second login. If Outlook is missing, quit, not signed in, or cannot be automated, Mail stays on the demo mailbox and says why.

Sign in to Outlook before you start. Leave that Outlook window running. Do not enter the mailbox password into Personal Agents.

## Mac

1. Open classic Outlook for Mac and confirm the inbox is visible. Quit New Outlook if that is the only window: New Outlook has no usable scripting, and Mail should say so instead of crashing.
2. Open Personal Agents. Mail and Home show `Outlook not connected — using demo mailbox` until you connect. Capabilities shows Outlook blocked and the reason.
3. On Mail or Capabilities, choose Connect Outlook. Approve `Personal Agents wants to read mail in Outlook on this computer.` macOS may ask to allow Automation for Outlook. Allow it. If you deny that prompt, Mail stays on the demo mailbox and Capabilities explains System Settings → Privacy & Security → Automation.
4. Mail lists real inbox messages: sender, subject, date, a short preview, and Unread. Home digest and follow-ups use that mail. In Chat, ask to summarize your mail and what needs a reply. The answer uses Outlook, not the sample threads.
5. Draft a reply. Edit the text. Approve the draft card. The message appears in Outlook's Drafts folder and is not sent. A second card asks to send. Approve it only if you want Outlook to send. Snooze brings the card back. Deny either card: nothing is sent, the page says `The reply was not sent.`, and the model is not called again.
6. Quit Outlook. Refresh Mail. The page returns to the demo mailbox and says Outlook is not running.

## Windows

1. Open classic Outlook (`OUTLOOK.EXE`) and confirm the inbox is visible. New Outlook (`olk.exe`) has no local automation. If only New Outlook is installed, Capabilities says so and Mail keeps the demo mailbox. Do not run an administrator install.
2. Repeat the connect, digest, chat summary, draft approval, send denial, and quit steps above. A draft approval saves in Drafts. A send approval is the only step that tells Outlook to send.
