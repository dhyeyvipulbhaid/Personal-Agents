# M16 browser control

On your Mac, with Ollama running and `qwen3:4b` pulled, open Chat.

## Read a page

Send: `Open https://example.com and tell me what the page says.`

Approve the one card that says `visit example.com`. The reply should mention Example Domain and that the domain is for illustrative examples in documents. Activity lists that approval. Ask `What does example.com say about using it in documents?` The second question should not show another approval card.

A denial on the first card means the reply says the visit was not allowed, and the page text does not appear.
