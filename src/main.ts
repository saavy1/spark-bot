// Discord front end for a chat model and a classifier.
//
//   @mention or reply to the bot      chat, with the channel's recent messages as context
//   reply to a message + @mention     with a yes/no question ("is this a dumb question?"):
//                                     the classifier's verdict on that message, narrated
//   DM the bot                        same as a mention, in private
//   /chat prompt [think]              chat, with channel context when the bot can read it
//   /vibecheck [messages]             the classifier reads the room
//   /classify yesno|choose|score      judge the channel's recent conversation, or some text
//   Apps > Classify                   classify an existing message
//   /models                           which models answer, and whether they are up
//
// Which models answer is configured in the environment (see models.ts). The
// models may be unauthenticated, so only the users in ALLOWED_USERS, or
// anyone in a server listed in ALLOWED_GUILDS (both comma-separated Discord
// IDs), may use the bot; with neither set, only the application's owner may.

import {
  ActionRowBuilder,
  ApplicationCommandType,
  ApplicationIntegrationType,
  Client,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  Partials,
  SlashCommandBuilder,
  type SlashCommandStringOption,
  TextInputBuilder,
  TextInputStyle,
  Team,
  type Channel,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type RepliableInteraction,
} from "discord.js";
import type { ClassifierAnswer, ClassifierQuestion, JsonValue } from "@earendil-works/pi-ai";
import { describe, line, read, systemPrompt, type Line, type Scene } from "./context.ts";
import { connect, type Chat, type ChatRequest, type Classifier } from "./models.ts";

const MAX_TEXT = 4000;
const installs = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];
const ids = (raw?: string) => new Set((raw ?? "").split(",").map((id) => id.trim()).filter(Boolean));
const textOption = (o: SlashCommandStringOption) =>
  o.setName("text").setDescription("Text to judge instead of this channel's recent conversation");

const chatCommands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Ask the chat model; it sees the channel's recent messages when it can")
    .setIntegrationTypes(installs)
    .setContexts(contexts)
    .addStringOption((o) => o.setName("prompt").setDescription("What to ask").setRequired(true))
    .addBooleanOption((o) => o.setName("think").setDescription("Let the model reason first (slower)")),
];

const classifyCommands = [
  new SlashCommandBuilder()
    .setName("vibecheck")
    .setDescription("Read the room: mood, chaos, beef and the main character")
    .setIntegrationTypes(installs)
    .setContexts(contexts)
    .addIntegerOption((o) =>
      o.setName("messages").setDescription("How many recent messages to read (default 50)").setMinValue(5).setMaxValue(100),
    ),
  new SlashCommandBuilder()
    .setName("classify")
    .setDescription("Judge the conversation here, or some text, against a question")
    .setIntegrationTypes(installs)
    .setContexts(contexts)
    .addSubcommand((sub) =>
      sub
        .setName("yesno")
        .setDescription("How likely is the answer yes?")
        .addStringOption((o) =>
          o.setName("question").setDescription("e.g. is anyone actually mad right now?").setRequired(true),
        )
        .addStringOption(textOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("choose")
        .setDescription("Pick the best of several labels")
        .addStringOption((o) => o.setName("question").setDescription("e.g. what are we talking about?").setRequired(true))
        .addStringOption((o) =>
          o.setName("options").setDescription("Comma-separated labels, e.g. homelab, melee, food").setRequired(true),
        )
        .addStringOption(textOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("score")
        .setDescription("Rate on a scale")
        .addStringOption((o) => o.setName("question").setDescription("e.g. how productive is this chat?").setRequired(true))
        .addStringOption((o) =>
          o.setName("levels").setDescription("Comma-separated levels, lowest first (default: low, medium, high)"),
        )
        .addStringOption(textOption),
    ),
  new ContextMenuCommandBuilder()
    .setName("Classify")
    .setType(ApplicationCommandType.Message)
    .setIntegrationTypes(installs)
    .setContexts(contexts),
];

const models = await connect();
const { chat, classifier } = models;
const commands = [
  ...(chat ? chatCommands : []),
  ...(classifier ? classifyCommands : []),
  new SlashCommandBuilder()
    .setName("models")
    .setDescription("Show which models answer, and whether they are up")
    .setIntegrationTypes(installs)
    .setContexts(contexts),
];

const allowedUsers = ids(process.env.ALLOWED_USERS);
const allowedGuilds = ids(process.env.ALLOWED_GUILDS);
const permitted = (user: string, guild: string | null) =>
  allowedUsers.has(user) || (guild !== null && allowedGuilds.has(guild));

// Message Content is a privileged intent (Developer Portal → Bot). Without it
// the bot still hears mentions and DMs, but channel history reads as empty.
let readsChannels = true;

function makeClient(withContent: boolean) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      ...(withContent ? [GatewayIntentBits.MessageContent] : []),
    ],
    partials: [Partials.Channel],
    // The model writes these messages; never let it ping @everyone, roles or users.
    allowedMentions: { parse: [], repliedUser: true },
  });

  client.once(Events.ClientReady, async (ready) => {
    if (allowedUsers.size === 0 && allowedGuilds.size === 0) {
      const { owner } = await ready.application.fetch();
      const owners = owner instanceof Team ? [...owner.members.keys()] : owner ? [owner.id] : [];
      owners.forEach((id) => allowedUsers.add(id));
    }
    await ready.application.commands.set(commands.map((command) => command.toJSON()));
    console.log(
      `signed in as ${ready.user.tag}; chat: ${chat?.name ?? "off"}, classifier: ${classifier?.name ?? "off"}; ` +
        `${allowedUsers.size} allowed users, ${allowedGuilds.size} allowed servers; ` +
        `channel context ${readsChannels ? "on" : "off"}`,
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handle(interaction);
    } catch (error) {
      console.error(error);
      if (interaction.isRepliable()) await fail(interaction, "Something went wrong; see the bot's log.").catch(() => {});
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await mentioned(message);
    } catch (error) {
      console.error(error);
    }
  });

  return client;
}

let client = makeClient(true);

// ---- Conversation ---------------------------------------------------------

// Channels with a reply in progress, so a burst of mentions gets one answer at a time.
const busy = new Set<string>();

async function mentioned(message: Message) {
  const me = client.user!.id;
  if ((!chat && !classifier) || message.author.bot) return;
  const direct = !message.inGuild();
  const addressed =
    direct || message.mentions.users.has(me) || message.mentions.repliedUser?.id === me;
  if (!addressed || !permitted(message.author.id, message.guildId)) return;
  if (busy.has(message.channelId)) {
    await message.react("⏳").catch(() => {});
    return;
  }

  const channel = message.channel;
  if (!channel.isSendable()) return;
  busy.add(message.channelId);
  const typing = setInterval(() => channel.sendTyping().catch(() => {}), 8_000);
  await channel.sendTyping().catch(() => {});
  try {
    const scene: Scene = { where: describe(channel), lines: await read(channel, me, message.id) };
    const asker = line(message, me);
    // cleanContent spells our mention as "@<name>"; drop it when it leads.
    const handle = `@${message.guild?.members.me?.displayName ?? client.user!.displayName}`;
    const stripped = asker.text.startsWith(handle) ? asker.text.slice(handle.length).replace(/^[,:]?\s*/u, "") : asker.text;
    const prompt = stripped || "(just pinged you)";

    // Replying to someone's message with a yes/no question about it gets a verdict.
    const target = await repliedTo(message, me);
    if (target && classifier && (await isYesNo(classifier, prompt))) {
      clearInterval(typing);
      return await judge(message, classifier, target, asker.author, prompt, scene);
    }
    if (!chat) return;

    const about = target ? ` (replying to ${target.author}'s message: "${target.text}")` : "";
    let reply: Message | undefined;
    await converse(
      chat,
      {
        system: systemPrompt(
          client.user!.displayName,
          scene,
          `${asker.author}, who just said this to you${target ? `, about ${target.author}'s message` : ""}`,
        ),
        prompt: `${asker.author}${about}: ${prompt}`,
        think: prompt.includes("🧠"),
      },
      {
        show: async (content) => {
          clearInterval(typing);
          if (reply) await reply.edit(content);
          else reply = await message.reply(content);
        },
        more: (content) => channel.send(content),
      },
    );
  } finally {
    clearInterval(typing);
    busy.delete(message.channelId);
  }
}

// The message this one replies to, unless it's one of ours (then the reply
// just continues the conversation).
async function repliedTo(message: Message, me: string): Promise<Line | undefined> {
  if (!message.reference?.messageId) return undefined;
  const referenced = await message.fetchReference().catch(() => undefined);
  if (!referenced || referenced.author.id === me) return undefined;
  const target = line(referenced, me);
  return target.text.trim() ? target : undefined;
}

// Yes/no questions start like one; the classifier then tells "can this run on
// a Pi?" (a verdict) from "can you summarize this?" (a request for chat).
const YES_NO_START =
  /^(is|are|am|was|were|do|does|did|can|could|will|would|should|shall|has|have|had|may|might|must|isn't|aren't|wasn't|doesn't|didn't|can't|won't|wouldn't|shouldn't)\b/iu;

async function isYesNo(classifier: Classifier, prompt: string) {
  if (!YES_NO_START.test(prompt.trim())) return false;
  const result = await classifier.classify({
    state: { text: prompt },
    questions: {
      kind: {
        type: "choice",
        instructions: "What kind of message is this?",
        criteria: {
          yesno: "a question answerable with yes or no",
          request: "asks to explain, summarize, roast, fix, or give an opinion",
          chatter: "a reaction or small talk, not a question",
        },
      },
    },
  });
  const kind = result.answers.kind;
  return result.stopReason === "stop" && kind?.type === "choice" && kind.choice === "yesno";
}

// The classifier's yes/no verdict on `target`, then a one-liner from the chat
// model backing it up.
async function judge(message: Message, classifier: Classifier, target: Line, asker: string, question: string, scene: Scene) {
  const result = await classifier.classify({ state: messageSubject(target).state, questions: { q: bool(question) } });
  const answer = result.answers.q;
  if (result.stopReason !== "stop" || answer?.type !== "bool") {
    await message.reply(`⚠️ ${classifier.name} failed: ${result.errorMessage ?? result.stopReason}`.slice(0, 2000));
    return;
  }

  const yes = answer.probability >= 0.5;
  const head = `**${yes ? "Yes" : "No"}** ${bar(answer.probability)}`;
  const credit = `-# ${classifier.name} judged ${target.author}'s message${chat ? ` · ${chat.name} narrates` : ""}`;
  const reply = await message.reply(`${head}\n${credit}`);
  if (!chat) return;

  let quip = "";
  const narrated = await chat.ask(
    {
      system: systemPrompt(client.user!.displayName, scene, `${asker}, who asked you to judge ${target.author}'s message`),
      prompt:
        `${asker} asked about ${target.author}'s message "${target.text}": "${question}" ` +
        `A classifier answered ${yes ? "yes" : "no"} (${Math.round(answer.probability * 100)}% yes). ` +
        "Write ONE short, funny line (max 25 words) backing up that verdict. Playful, never mean-spirited. " +
        "Don't restate the percentage.",
      think: false,
    },
    (text) => (quip = text),
  );
  if (narrated.stopReason !== "stop" || !quip.trim()) return;
  await reply.edit(`${head}\n${quip.trim().replace(/^"|"$/g, "")}\n${credit}`.slice(0, 2000));
}

interface Surface {
  show(content: string): Promise<unknown>;
  more(content: string): Promise<unknown>;
}

// Streams an answer into `surface`. Discord rate-limits edits, so the stream
// is shown at most every 1.5 s, then the final text replaces it.
async function converse(chat: Chat, request: ChatRequest, surface: Surface) {
  let shown = 0;
  let latest = "";
  let editing: Promise<unknown> = Promise.resolve();
  const show = (content: string) => {
    editing = editing.then(() => surface.show(content)).catch(() => {});
  };
  const message = await chat.ask(request, (text, thinking) => {
    latest = text;
    if (Date.now() - shown < 1500) return;
    shown = Date.now();
    show(thinking && !text ? "-# thinking…" : `${clip(text)} ▍`);
  });
  await editing;

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    await surface.show(`⚠️ ${chat.name} failed: ${message.errorMessage ?? message.stopReason}`.slice(0, 2000));
    return;
  }
  const chunks = split(latest || "…");
  await surface.show(chunks[0]);
  for (const chunk of chunks.slice(1)) await surface.more(chunk);
}

async function chatCommand(interaction: ChatInputCommandInteraction, chat: Chat) {
  const prompt = interaction.options.getString("prompt", true);
  const think = interaction.options.getBoolean("think") ?? false;
  await interaction.deferReply();
  const scene: Scene = {
    where: describe(interaction.channel, interaction.guild?.name),
    lines: await read(interaction.channel, client.user!.id),
  };
  const asker = interaction.member && "displayName" in interaction.member
    ? interaction.member.displayName
    : interaction.user.displayName;
  await converse(
    chat,
    { system: systemPrompt(client.user!.displayName, scene, `${asker}'s question`), prompt: `${asker}: ${prompt}`, think },
    { show: (content) => interaction.editReply(content), more: (content) => interaction.followUp(content) },
  );
}

function clip(text: string) {
  return text.length > 1990 ? `…${text.slice(-1985)}` : text;
}

function split(text: string, size = 2000) {
  const chunks: string[] = [];
  while (text.length > size) {
    const cut = text.lastIndexOf("\n", size) > size / 2 ? text.lastIndexOf("\n", size) : size;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).replace(/^\n/, "");
  }
  return [...chunks, text];
}

// ---- Vibe check -----------------------------------------------------------

const MOODS: Record<string, [string, string]> = {
  wholesome: ["🥰", "friendly and warm"],
  chaotic: ["🌀", "messy, all over the place"],
  heated: ["🔥", "people are arguing or annoyed"],
  nerdy: ["🤓", "deep in a technical topic"],
  hype: ["🚀", "excited about something"],
  sleepy: ["😴", "quiet, low energy"],
  silly: ["🤡", "joking around, memes and bits"],
};
const CHAOS = ["serene 🧘", "chill 😎", "lively 🎉", "rowdy 🍻", "unhinged 🤪"];
const BEEF = ["none detected", "simmering", "brewing", "certified 🥩"];

async function vibecheck(interaction: ChatInputCommandInteraction, classifier: Classifier) {
  await interaction.deferReply();
  const me = client.user!.id;
  const lines = (await read(interaction.channel, me, undefined, interaction.options.getInteger("messages") ?? 50)).filter(
    (l) => !l.mine,
  );
  if (lines.length < 3) {
    return fail(interaction, lines.length ? "Not enough chatter here to read the room yet." : unreadable());
  }

  const where = describe(interaction.channel, interaction.guild?.name);
  const people = [...new Set(lines.map((l) => l.author))];
  const questions: Record<string, ClassifierQuestion> = {
    mood: {
      type: "choice",
      instructions: "What is the overall mood of this conversation?",
      criteria: Object.fromEntries(Object.entries(MOODS).map(([mood, [, meaning]]) => [mood, meaning])),
    },
    chaos: { type: "score", instructions: "How chaotic is this conversation?", criteria: CHAOS.map((c) => c.split(" ")[0]) },
    beef: {
      type: "bool",
      instructions: "Is anyone in this conversation arguing with or annoyed at someone else?",
      criteria: { true: "There is friction between people", false: "Everyone is getting along" },
    },
  };
  if (people.length >= 2) {
    questions.main = {
      type: "choice",
      instructions: "Who is driving this conversation, the main character?",
      criteria: Object.fromEntries(people.map((person) => [person, person])),
    };
  }

  let text = "";
  const messages = lines.map((l) => ({ author: l.author, text: l.text }));
  while (JSON.stringify(messages).length > MAX_TEXT && messages.length > 3) messages.shift();
  const result = await classifier.classify({ state: { channel: where, messages }, questions });
  if (result.stopReason !== "stop") {
    return fail(interaction, `${classifier.name} failed: ${result.errorMessage ?? result.stopReason}`);
  }

  const { mood, chaos, beef, main } = result.answers;
  const embed = new EmbedBuilder().setColor(0xf47fff).setTitle(`Vibe check · ${where}`.slice(0, 256));
  if (mood?.type === "choice") {
    embed.addFields({
      name: "Mood",
      value: `${MOODS[mood.choice]?.[0] ?? "✨"} **${mood.choice}** ${bar(mood.probabilities[mood.choice] ?? 0)}`,
    });
  }
  if (chaos?.type === "score") {
    const level = Math.min(CHAOS.length - 1, Math.max(0, Math.round(chaos.score)));
    embed.addFields({ name: "Chaos", value: `**${CHAOS[level]}** ${bar(chaos.score / (CHAOS.length - 1))}`, inline: true });
  }
  if (beef?.type === "bool") {
    const level = Math.min(BEEF.length - 1, Math.floor(beef.probability * BEEF.length));
    embed.addFields({ name: "Beef", value: `**${BEEF[level]}** ${bar(beef.probability)}`, inline: true });
  }
  if (main?.type === "choice") {
    embed.addFields({ name: "Main character", value: `👑 **${main.choice}** ${bar(main.probabilities[main.choice] ?? 0)}` });
  }
  embed.setFooter({ text: `${classifier.name} read ${messages.length} messages${chat ? ` · ${chat.name} narrates` : ""}` });
  await interaction.editReply({ embeds: [embed] });

  // Let the chat model narrate the verdict, if there is one.
  if (!chat) return;
  const verdict = embed.data.fields?.map((f) => `${f.name}: ${f.value.replace(/`[^`]*`/g, "").replace(/\*/g, "")}`).join("; ");
  const scene: Scene = { where, lines };
  await chat
    .ask(
      {
        system: systemPrompt(client.user!.displayName, scene, "with a vibe report"),
        prompt:
          `A classifier just rated this channel: ${verdict}. Write ONE punchy, funny sentence (max 30 words) ` +
          "summing up the vibe for the channel. Playful roast energy, nothing mean-spirited.",
        think: false,
      },
      (t) => (text = t),
    )
    .then(async (answer) => {
      if (answer.stopReason !== "stop" || !text.trim()) return;
      embed.setDescription(`*${text.trim().replace(/^"|"$/g, "")}*`.slice(0, 4096));
      await interaction.editReply({ embeds: [embed] });
    });
}

// ---- Interactions and classification ------------------------------------

async function handle(interaction: Interaction) {
  if (!interaction.isRepliable()) return;
  if (!permitted(interaction.user.id, interaction.guildId)) {
    await interaction.reply({ content: "You're not on this bot's guest list.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "models") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await models.status());
    return;
  }

  // Commands registered before a model was switched off can still arrive.
  if (interaction.isChatInputCommand() && interaction.commandName === "chat") {
    return chat ? chatCommand(interaction, chat) : fail(interaction, "No chat model is configured.");
  }
  if (!classifier) return fail(interaction, "No classifier is configured.");

  if (interaction.isChatInputCommand() && interaction.commandName === "vibecheck") {
    return vibecheck(interaction, classifier);
  }

  if (interaction.isMessageContextMenuCommand()) {
    const target = line(interaction.targetMessage, client.user!.id);
    if (!target.text.trim()) return fail(interaction, "That message has no text to classify.");
    const modal = new ModalBuilder()
      .setCustomId(`classify:${interaction.targetId}`)
      .setTitle("Classify this message")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("question")
            .setLabel("Question")
            .setPlaceholder("Is this message a complaint?")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(300),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("options")
            .setLabel("Options (optional)")
            .setPlaceholder("Comma-separated labels to pick from; empty for yes/no")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(300),
        ),
      );
    pending.set(interaction.targetId, target);
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("classify:")) {
    const id = interaction.customId.slice("classify:".length);
    const target = pending.get(id);
    pending.delete(id);
    if (!target) return fail(interaction, "That form expired; try again.");
    const question = interaction.fields.getTextInputValue("question");
    const choices = labels(interaction.fields.getTextInputValue("options"));
    const asked = choices.length >= 2 ? choice(question, choices) : bool(question);
    return classify(interaction, classifier, messageSubject(target), question, asked);
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "classify") {
    return classifyCommand(interaction, classifier);
  }
}

// Messages waiting for their modal to come back, keyed by message ID.
const pending = new Map<string, Line>();

function labels(raw: string | null) {
  return (raw ?? "").split(",").map((label) => label.trim()).filter(Boolean);
}

const bool = (instructions: string): ClassifierQuestion => ({
  type: "bool",
  instructions,
  criteria: { true: "Yes", false: "No" },
});

const choice = (instructions: string, options: string[]): ClassifierQuestion => ({
  type: "choice",
  instructions,
  criteria: Object.fromEntries(options.map((option) => [option, option])),
});

// What the classifier judges, and how the reply shows it.
interface Subject {
  state: Record<string, JsonValue>;
  preview: string;
}

function textSubject(text: string): Subject {
  return { state: { text: text.slice(0, MAX_TEXT) }, preview: `>>> ${text.length > 400 ? `${text.slice(0, 400)}…` : text}` };
}

function messageSubject(message: Line): Subject {
  return {
    state: { message: { author: message.author, text: message.text.slice(0, MAX_TEXT) } },
    preview: `>>> **${message.author}:** ${message.text.length > 400 ? `${message.text.slice(0, 400)}…` : message.text}`,
  };
}

// The channel's recent conversation (without the bot's own messages), oldest
// first and trimmed to fit; undefined when the bot can't read the channel.
async function channelSubject(channel: Channel | null, guildName?: string, limit = 30): Promise<Subject | undefined> {
  const where = describe(channel, guildName);
  const lines = (await read(channel, client.user!.id, undefined, limit)).filter((l) => !l.mine);
  if (!lines.length) return undefined;
  const messages = lines.map((l) => ({ author: l.author, text: l.text }));
  while (JSON.stringify(messages).length > MAX_TEXT && messages.length > 1) messages.shift();
  return { state: { channel: where, messages }, preview: `-# the last ${messages.length} messages in ${where}` };
}

const unreadable = () =>
  !readsChannels
    ? "I can't read channels: the Message Content intent is off in the Developer Portal."
    : "I can't read this channel. Add me to the server (not just as a user app), or pass `text`.";

async function classifyCommand(interaction: ChatInputCommandInteraction, classifier: Classifier) {
  const question = interaction.options.getString("question", true);
  const sub = interaction.options.getSubcommand();
  let asked: ClassifierQuestion;
  if (sub === "yesno") {
    asked = bool(question);
  } else if (sub === "choose") {
    const options = labels(interaction.options.getString("options"));
    if (options.length < 2) return fail(interaction, "Give at least two comma-separated options.");
    asked = choice(question, options);
  } else {
    const levels = labels(interaction.options.getString("levels") ?? "low, medium, high");
    if (levels.length < 2) return fail(interaction, "Give at least two comma-separated levels.");
    asked = { type: "score", instructions: question, criteria: levels };
  }

  await interaction.deferReply();
  const text = interaction.options.getString("text");
  const subject = text ? textSubject(text) : await channelSubject(interaction.channel, interaction.guild?.name);
  if (!subject) return fail(interaction, unreadable());
  return classify(interaction, classifier, subject, question, asked);
}

async function classify(
  interaction: RepliableInteraction,
  classifier: Classifier,
  subject: Subject,
  title: string,
  question: ClassifierQuestion,
) {
  if (!interaction.deferred) await interaction.deferReply();
  const result = await classifier.classify({ state: subject.state, questions: { q: question } });
  if (result.stopReason !== "stop") {
    return fail(interaction, `${classifier.name} failed: ${result.errorMessage ?? result.stopReason}`);
  }
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title.slice(0, 256))
    .setDescription(subject.preview)
    .addFields(render(result.answers.q, question))
    .setFooter({ text: classifier.name });
  await interaction.editReply({ embeds: [embed] });
}

function bar(probability: number, width = 12) {
  const filled = Math.round(Math.min(1, Math.max(0, probability)) * width);
  return `\`${"█".repeat(filled)}${"░".repeat(width - filled)} ${Math.round(probability * 100)}%\``;
}

function render(answer: ClassifierAnswer, question: ClassifierQuestion) {
  if (answer.type === "bool") {
    return { name: answer.probability >= 0.5 ? "Yes" : "No", value: bar(answer.probability) };
  }
  if (answer.type === "choice") {
    const lines = Object.entries(answer.probabilities)
      .sort(([, a], [, b]) => b - a)
      .map(([label, p]) => `${label === answer.choice ? `**${label}**` : label}  ${bar(p)}`);
    return { name: answer.choice, value: `${lines.join("\n")}\nconfidence ${Math.round(answer.confidence * 100)}%` };
  }
  const levels = question.criteria as string[];
  const nearest = levels[Math.min(levels.length - 1, Math.max(0, Math.round(answer.score)))];
  const value = levels.map((level, index) => (level === nearest ? `**${index}. ${level}**` : `${index}. ${level}`));
  return {
    name: `${nearest} (${answer.score.toFixed(2)} of 0–${levels.length - 1})`,
    value: `${value.join("\n")}\nconfidence ${Math.round(answer.confidence * 100)}%`,
  };
}

async function fail(interaction: RepliableInteraction, content: string) {
  const message = `⚠️ ${content}`.slice(0, 2000);
  if (interaction.deferred || interaction.replied) await interaction.editReply(message);
  else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
}

try {
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  if (!(error instanceof Error) || error.message !== "Used disallowed intents") throw error;
  console.warn(
    "Message Content intent is off in the Developer Portal (Bot → Privileged Gateway Intents); " +
      "running without channel context. Mentions and DMs still work.",
  );
  await client.destroy();
  readsChannels = false;
  client = makeClient(false);
  await client.login(process.env.DISCORD_TOKEN);
}
