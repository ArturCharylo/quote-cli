// src/agent/providers/openai.provider.ts

import OpenAI from "openai";
import { EventEmitter } from "events";
import type { AIProvider, AgentMessageReceived } from "./types.js";
import { resolveSettings } from "../../lib/settings.js";
// Note: We will need to adapt tools for OpenAI later
import { currencyConversionTool, servicePricingLookupTool } from "../tools.js";
import { PROMPT } from "./constants.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

const DEFAULT_SYSTEM_PROMPT = PROMPT.DEFAULT_SYSTEM_PROMPT;

/**
 * OpenAI implementation of the AIProvider interface
 */
export class OpenAIProvider extends EventEmitter implements AIProvider {
  readonly id = "openai";
  readonly name = "OpenAI";
  
  private client: OpenAI | null = null;
  private messageHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  constructor() {
    super();
  }

  // Implementation of AIProvider.onMessage
  onMessage(callback: (content: string) => void): void {
    this.on("message", (data: AgentMessageReceived) => {
      if (data.type === "assistant.message") {
        callback(data.content);
      }
    });
  }

  async initialize(): Promise<void> {
    const settings = await resolveSettings();
    const apiKey = (settings as any).openaiApiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "OpenAI API key is missing.\n\n" +
        "  Run '/settings' in the CLI to configure it."
      );
    }

    this.client = new OpenAI({ apiKey });
  }

  async startSession(
    brief: string,
    options?: { skipInitialMessage?: boolean }
  ): Promise<void> {
    try {
      if (!this.client) await this.initialize();

      const settings = await resolveSettings();
      const promptToUse = settings.systemPrompt?.trim() ? settings.systemPrompt : DEFAULT_SYSTEM_PROMPT;

      // Initialize the conversation history with the system prompt
      this.messageHistory = [
        { role: "system", content: promptToUse }
      ];

      if (!options?.skipInitialMessage) {
        await this.sendMessage(`Here is the brief for the quote:\n\n${brief}`);
      }
    } catch (error) {
      console.log("\n❌ Failed to start OpenAI session.\n");
      throw error;
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.client) throw new Error("Client not initialized");

    // Add user message to history
    this.messageHistory.push({ role: "user", content: message });

    try {
      // NOTE: We will need to inject tools here in the next steps
      const stream = await this.client.chat.completions.create({
        model: "gpt-5.2-chat-latest",
        messages: this.messageHistory,
        stream: true,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          fullResponse += content;
        }
      }

      // Add assistant response to history
      this.messageHistory.push({ role: "assistant", content: fullResponse });

      // Emit the full response once the stream is complete
      this.emit("message", {
        type: "assistant.message",
        content: fullResponse
      } as AgentMessageReceived);

    } catch (error) {
      if (DEBUG_MODE) console.error("[openai] Error generating response:", error);
      this.emit("error", new Error("Failed to communicate with OpenAI"));
    }
  }

  async endSession(): Promise<void> {
    // OpenAI doesn't have a persistent connection to destroy like Copilot does
    this.messageHistory = [];
    this.emit("ended");
  }
}