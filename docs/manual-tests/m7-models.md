# M7 model connector check

Run this on device A and again on device B, with Ollama running and at least two local models.

1. One model reports tool support and one does not. The app refuses to save the model without tools as the agent model.
2. A chat, a streamed reply, a tool call, and a structured reply succeed against the local Ollama. The same checks run in CI against a stand-in behind the connector.
