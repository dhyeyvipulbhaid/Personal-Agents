# M16 browser control

On your Mac, with Ollama running and `qwen3:4b` pulled, open Chat.

Chat should not offer a browser visit for a plain question like "Who is Pepper?"; it should only offer one when the user asks to look it up.

## Read a page

Send: `Open https://example.com and tell me what the page says.`

Approve the one card that says `visit example.com`. The reply should mention Example Domain and that the domain is for illustrative examples in documents. Activity lists that approval. Ask `What does example.com say about using it in documents?` The second question should not show another approval card.

A denial on the first card means the reply says the visit was not allowed, and the page text does not appear. The card has both Approve and Deny. Stop, while that card is waiting, ends the turn, clears the card, and does not fetch the page.

## Drive Chrome

Send: `Navigate to https://example.com`

Approve the card that says `navigate to example.com`. A Chrome window opens on screen, using a separate profile under the app data folder. It is the Chrome already installed on the Mac, not a browser bundled with the app.

Send: `Click "More information..."`

The card says `click "More information..." on example.com`. Deny it. Chrome stays on example.com.

Send the click again and approve it. Chrome follows the link.

Send: `Read this page`

That read does not ask a second time. The reply matches the page that is open. Activity lists the navigate, the denial, the click, and the read.

While a card is waiting, press Stop. The turn ends, the card closes, and Chrome does not perform that action. The next message still sends.

If Chrome is not installed, navigate, click, and type say Chrome is not installed and do not run. `Open https://example.com and tell me what the page says.` still reads the page in the background after one approval.
