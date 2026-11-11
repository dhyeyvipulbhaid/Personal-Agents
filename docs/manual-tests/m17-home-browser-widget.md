# M17 home browser widget

On your Mac, with the app open and Ollama running, start on Home.

Home shows a Browser activity card. Before any visit it says `No browser activity yet.`

In Chat, send: `Navigate to https://example.com`

Nothing should open yet, including Safari. Home, while that card is waiting, shows `navigate to example.com` with Approve and Deny. Click Deny. The buttons switch to `Denied` immediately, and no browser opens.

If Chrome is not installed, Chat and Capabilities say to install Google Chrome, and Safari does not open.

Send the navigate again and approve it in Chat. Home shows a small live picture of the Chrome window, the site `example.com`, the step, and Stop. Leave Home or minimize the window and the picture pauses. Come back and it resumes.

Click Stop. Chrome closes, and the card lists the recent actions. Each one links to Activity.
