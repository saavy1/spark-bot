// What the bot knows about where it's talking: the server and channel, and the
// recent messages in it. Reading history needs the bot to be a member of the
// server (or the DM); when it was only user-installed there, Discord doesn't
// let it read anything, and the context is just the channel's name.

import { ChannelType, type Channel, type Message } from "discord.js";

const HISTORY = Number(process.env.CONTEXT_MESSAGES ?? 30);
const MAX_MESSAGE = 600;
const MAX_TRANSCRIPT = 12_000;

export interface Line {
  author: string;
  text: string;
  at: Date;
  replyTo?: string;
  mine: boolean;
}

export interface Scene {
  where: string;
  lines: Line[];
}

export function describe(channel: Channel | null, guildName?: string): string {
  if (!channel) return guildName ? `a channel in the "${guildName}" server` : "a Discord conversation";
  if (channel.type === ChannelType.DM) return `a direct message with ${channel.recipient?.displayName ?? "someone"}`;
  if (channel.type === ChannelType.GroupDM) return `a group DM${channel.name ? ` called "${channel.name}"` : ""}`;
  const name = "name" in channel && channel.name ? `#${channel.name}` : "a channel";
  const server = "guild" in channel && channel.guild ? channel.guild.name : guildName;
  const topic = "topic" in channel && channel.topic ? ` (topic: ${channel.topic})` : "";
  const thread = channel.isThread() && channel.parent ? `, a thread in #${channel.parent.name}` : "";
  return `${name}${thread}${server ? ` in the "${server}" server` : ""}${topic}`;
}

export function line(message: Message, me: string): Line {
  const attachments = [...message.attachments.values()].map((file) => `[${file.contentType?.split("/")[0] ?? "file"}: ${file.name}]`);
  const text = [message.cleanContent, ...attachments].filter(Boolean).join(" ");
  return {
    author: message.member?.displayName ?? message.author.displayName,
    text: text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text,
    at: message.createdAt,
    replyTo: message.mentions.repliedUser?.displayName,
    mine: message.author.id === me,
  };
}

// The recent history before `before` (exclusive), oldest first; empty when
// the bot can't read the channel.
export async function read(channel: Channel | null, me: string, before?: string, limit = HISTORY): Promise<Line[]> {
  if (!channel?.isTextBased() || limit <= 0) return [];
  try {
    const messages = await channel.messages.fetch({ limit, before });
    return [...messages.values()]
      .filter((message) => message.cleanContent || message.attachments.size)
      .reverse()
      .map((message) => line(message, me));
  } catch {
    return [];
  }
}

const clock = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function transcript(lines: Line[]): string {
  const rendered = lines.map(
    (l) => `[${clock.format(l.at)}] ${l.mine ? "you" : l.author}${l.replyTo ? ` (replying to ${l.replyTo})` : ""}: ${l.text}`,
  );
  // Keep the newest messages when the history is long.
  let total = 0;
  const kept: string[] = [];
  for (const text of rendered.reverse()) {
    if ((total += text.length + 1) > MAX_TRANSCRIPT) break;
    kept.unshift(text);
  }
  return kept.join("\n");
}

const PERSONA =
  process.env.BOT_PERSONA ??
  "You're a sharp, playful regular here: witty, warm, a little irreverent, never mean. " +
    "You actually help when someone needs help, and you're happy to banter when they don't.";

export function systemPrompt(name: string, scene: Scene, addressing: string): string {
  const history = scene.lines.length
    ? `Recent messages, oldest first ("you" is you):\n<transcript>\n${transcript(scene.lines)}\n</transcript>`
    : "You can't see this channel's earlier messages.";
  return [
    `You are ${name}, a Discord bot. You're talking in ${scene.where}.`,
    PERSONA,
    history,
    `Now answer ${addressing}. Write like a person in a chat: usually a sentence or a few, longer only when the ` +
      "question needs it. Use Discord markdown sparingly. Don't prefix your reply with your name or a timestamp, " +
      "and don't recap the transcript unless asked.",
  ].join("\n\n");
}
