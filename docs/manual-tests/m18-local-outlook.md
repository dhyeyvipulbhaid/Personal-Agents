# M18 local Outlook check

Personal Agents reads the Outlook app that is already signed in on this computer. It does not use Microsoft Graph, a cloud token, or a second login. If Outlook is missing, quit, not signed in, or cannot be automated, Mail stays on the demo mailbox and says why.

Open Outlook and sign in before you connect. Leave that Outlook window running. Do not enter the mailbox password into Personal Agents.

Connect Outlook stays on Mail and Capabilities when Outlook is not signed in, not running, or Automation was denied. It is hidden only when Outlook is already connected, not installed, or New Outlook has no scripting.

## Mac

1. Open classic Outlook for Mac and confirm the inbox is visible. Quit New Outlook if that is the only window: New Outlook has no usable scripting, and Mail should say so instead of crashing. There is no Connect button in that case.
2. Open Personal Agents before signing in, or with Outlook still starting. Mail may say `Outlook is not signed in` and still show Connect Outlook, plus `Outlook not connected — using demo mailbox`. Capabilities shows the same button and the reason.
3. Sign in to Outlook, leave it running, and choose Connect Outlook. Approve `Personal Agents wants to read mail in Outlook on this computer.` macOS may ask to allow Automation for Outlook. Allow it. If you deny that prompt, Mail stays on the demo mailbox, Connect remains, and Capabilities explains System Settings → Privacy & Security → Automation. If Outlook is quit, Connect says to open it, sign in, and try again. The button stays enabled.
4. Mail lists real inbox messages: sender, subject, date, a short preview, and Unread. Home digest and follow-ups use that mail. In Chat, ask to summarize your mail and what needs a reply. The answer uses Outlook, not the sample threads.
5. Draft a reply. Edit the text. Approve the draft card. The message appears in Outlook's Drafts folder and is not sent. A second card asks to send. Approve it only if you want Outlook to send. Snooze brings the card back. Deny either card: nothing is sent, the page says `The reply was not sent.`, and the model is not called again.
6. Quit Outlook. Refresh Mail. The page returns to the demo mailbox and says Outlook is not running.

## Windows

1. Open classic Outlook (`OUTLOOK.EXE`) and confirm the inbox is visible. New Outlook (`olk.exe`) has no local automation. If only New Outlook is installed, Capabilities says so and Mail keeps the demo mailbox. Do not run an administrator install.
2. Repeat the connect, digest, chat summary, draft approval, send denial, and quit steps above. A draft approval saves in Drafts. A send approval is the only step that tells Outlook to send.
