# M17 home browser widget

On your Mac, with the app open and Ollama running, start on Home.

Home shows a Browser activity card. Before any visit it says `No browser activity yet.`

In Chat, send: `Navigate to https://example.com`

Return to Home while the card is still waiting. Browser activity shows `navigate to example.com` with Approve and Deny. Click Deny. The buttons switch to `Denied` immediately, and the page does not open.

Send the navigate again and approve it in Chat. Home shows a small live picture of the Chrome window, the site `example.com`, the step, and Stop. Leave Home or minimize the window and the picture pauses. Come back and it resumes.

Click Stop. Chrome closes, and the card lists the recent actions. Each one links to Activity.
