# spark-bot

A Discord bot that hangs out in your channels, backed by a chat model and a
classifier through [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai).
It runs against whatever the environment points it at; today that's Qwen and
Laya on the DGX Spark.

## What it does

| | Model | Does |
| --- | --- | --- |
| **@mention it**, or reply to it | chat | answers in the thread of conversation, having read the channel's recent messages |
| **DM it** | chat | same, in private |
| `/chat prompt [think]` | chat | asks directly; sees channel context when it can |
| `/vibecheck [messages]` | classifier, narrated by chat | reads the room: mood, chaos, beef, and the main character |
| `/classify yesno\|choose\|score` | classifier | yes/no probability, pick-a-label, or rate on a scale |
| Apps → **Classify** on a message | classifier | yes/no, or a choice if you give options |
| `/models` | both | which models answer, and whether they are up |

Add 🧠 to a mention to let the chat model reason before it answers.

### Channel context

Reading channel history needs two things:

1. The bot is a **member** of the server (installed to the server, not only as a
   user app). As a user app it can answer slash commands anywhere, but Discord
   won't let it read history there.
2. The **Message Content** intent is enabled (Developer Portal → Bot →
   Privileged Gateway Intents). Without it the bot still starts, answers
   mentions and DMs, and logs `channel context off`.

The chat model sees the server, channel name and topic, and the last
`CONTEXT_MESSAGES` messages with who said them and who they replied to.
The bot never pings anyone: `@everyone`, roles and users are all suppressed in
what it writes.

## Configuration

See [`.env.example`](.env.example) for every variable.

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | required |
| `ALLOWED_USERS`, `ALLOWED_GUILDS` | who may use it; with neither set, only the app owner |
| `CHAT_URL`, `CHAT_MODEL`, `CHAT_API_KEY`, `CHAT_THINKING_FORMAT`, `CHAT_MAX_TOKENS` | chat model (OpenAI-compatible) |
| `CLASSIFIER_URL`, `CLASSIFIER_MODEL`, `CLASSIFIER_API_KEY` | classifier (System One / Jev-compatible) |
| `CONTEXT_MESSAGES`, `BOT_PERSONA` | how much history the chat model sees, and its personality |

Swapping a model means changing these, not code. A model whose URL is unset is
turned off and its commands aren't registered. Local models may have no auth of
their own, so the allowlists are the only gate.

## Development

```bash
direnv allow
pnpm install --frozen-lockfile
pnpm check
cp .env.example .env   # then fill in DISCORD_TOKEN
pnpm start
```

## Discord setup

In the Developer Portal: create an application, add a bot and copy its token,
enable **Message Content Intent** under Bot, and under **Installation** enable
both Guild Install and User Install. For the guild install, give it the
`bot` and `applications.commands` scopes with View Channels, Send Messages,
Read Message History and Add Reactions.
