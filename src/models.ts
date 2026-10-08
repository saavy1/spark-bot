// The bot's two models, registered with pi-ai as one provider. Both are
// configured entirely from the environment, so swapping either one is a config
// change:
//
//   CHAT_URL        OpenAI-compatible base URL (".../v1")
//   CHAT_MODEL      model ID; defaults to the first one the server lists
//   CHAT_API_KEY    optional; local servers need none
//   CHAT_THINKING_FORMAT  how to toggle reasoning (pi-ai's thinkingFormat,
//                   e.g. "qwen-chat-template"); unset leaves it to pi-ai
//   CHAT_MAX_TOKENS answer length cap (default 8192)
//
//   CLASSIFIER_URL      System One base URL (".../v1")
//   CLASSIFIER_MODEL    model ID sent with each request; also its display name
//   CLASSIFIER_API_KEY  optional; local servers need none
//
// A model whose URL is unset is disabled, and its commands are not registered.

import {
  createModels,
  createProvider,
  type AssistantMessage,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierResult,
  type Model,
  type OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";

const env = process.env;
const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface ChatRequest {
  system: string;
  prompt: string;
  think: boolean;
}

export interface Chat {
  name: string;
  ask(request: ChatRequest, onText: (text: string, thinking: boolean) => void): Promise<AssistantMessage>;
}

export interface Classifier {
  name: string;
  classify(context: ClassifierContext): Promise<ClassifierResult>;
}

export interface Models {
  chat?: Chat;
  classifier?: Classifier;
  status(): Promise<string>;
}

async function listedModel(baseUrl: string, apiKey?: string) {
  const response = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${baseUrl}/models answered ${response.status}`);
  const body = (await response.json()) as { data: { id: string; max_model_len?: number }[] };
  return body.data[0];
}

async function chatModel(baseUrl: string): Promise<Model<"openai-completions">> {
  const listed = env.CHAT_MODEL ? undefined : await listedModel(baseUrl, env.CHAT_API_KEY);
  const compat: OpenAICompletionsCompat = { supportsDeveloperRole: false };
  if (env.CHAT_THINKING_FORMAT) {
    compat.thinkingFormat = env.CHAT_THINKING_FORMAT as OpenAICompletionsCompat["thinkingFormat"];
    compat.supportsReasoningEffort = false;
  }
  return {
    id: env.CHAT_MODEL ?? listed!.id,
    name: env.CHAT_MODEL ?? listed!.id,
    api: "openai-completions",
    provider: "bot",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: free,
    contextWindow: listed?.max_model_len ?? 128_000,
    maxTokens: Number(env.CHAT_MAX_TOKENS ?? 8192),
    compat,
  };
}

function classifierModel(baseUrl: string): ClassifierModel<"typesafe-system-one"> {
  const id = env.CLASSIFIER_MODEL ?? "classifier";
  return {
    type: "classifier",
    id,
    name: id,
    api: "typesafe-system-one",
    provider: "bot",
    baseUrl,
    input: ["text"],
    cost: free,
    contextWindow: 8192,
  };
}

export async function connect(): Promise<Models> {
  const chat = env.CHAT_URL ? await chatModel(env.CHAT_URL.replace(/\/+$/u, "")) : undefined;
  const classifier = env.CLASSIFIER_URL ? classifierModel(env.CLASSIFIER_URL) : undefined;
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "bot",
      auth: { apiKey: { name: "bot", resolve: async () => ({ auth: {} }) } },
      models: [chat, classifier].filter((model) => model !== undefined),
      api: openAICompletionsApi(),
      classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
    }),
  );

  // System One requires a bearer token even when the server ignores it.
  const classify = (context: ClassifierContext) =>
    models.classify(classifier!, context, { apiKey: env.CLASSIFIER_API_KEY ?? "local" });

  return {
    chat: chat && {
      name: chat.name,
      async ask({ system, prompt, think }, onText) {
        const stream = models.streamSimple(
          chat,
          {
            systemPrompt: system,
            messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          },
          { apiKey: env.CHAT_API_KEY ?? "local", reasoning: think ? "medium" : undefined },
        );
        let text = "";
        for await (const event of stream) {
          if (event.type === "thinking_delta") onText(text, true);
          if (event.type === "text_delta") onText((text += event.delta), false);
        }
        return stream.result();
      },
    },

    classifier: classifier && { name: classifier.name, classify },

    async status() {
      const lines: string[] = [];
      if (chat) {
        try {
          await listedModel(chat.baseUrl, env.CHAT_API_KEY);
          lines.push(`🟢 chat · ${chat.name}`);
        } catch (error) {
          lines.push(`🔴 chat · ${chat.name}: ${(error as Error).message}`);
        }
      }
      if (classifier) {
        // System One has no health endpoint, so ask it something trivial.
        const result = await classify({
          state: { text: "ping" },
          questions: { up: { type: "bool", instructions: "Is this text?", criteria: { true: "Yes", false: "No" } } },
        });
        lines.push(
          result.stopReason === "stop"
            ? `🟢 classifier · ${classifier.name}`
            : `🔴 classifier · ${classifier.name}: ${result.errorMessage ?? result.stopReason}`,
        );
      }
      return lines.join("\n") || "No models are configured.";
    },
  };
}
