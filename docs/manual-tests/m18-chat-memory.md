# M18 chat memory

Run this with Ollama up and `qwen3:8b` pulled. No administrator password.

1. In Chat, send `Maya prefers morning meetings.` Wait until the reply finishes before you send anything else.
2. Start a new chat and ask `When does Maya like to meet?` The reply uses that fact. The Memory page lists a fact from the exchange.
3. On the Memory page, save `Maya's dog is named Pepper.` Ask chat who Pepper is. The reply uses that fact.
4. Delete the Pepper fact. Ask again. The reply does not use it.
5. Quit Ollama and send another message. Chat shows the usual Ollama message, and the window stays open.
6. `memory-bank.sqlite` is in the app data folder: `~/Library/Application Support/com.personalagents.desktop` on macOS, `%LOCALAPPDATA%\com.personalagents.desktop` on Windows.

Facts from one chat are available in the next. Recall puts at most 400 tokens of facts into the prompt. A token is `ceil(characters / 4)` of the fact text. Automatic retain no longer stores an assistant or model line that only says it lacks knowledge, so `The assistant does not have specific information about a person named Pepper` is not saved. A leftover row like that already in a local database is not deleted on open; delete it yourself. Opening the app merges leftover copies of identical fact text in the same bank, so two rows of `Maya prefers morning meetings` become one.
