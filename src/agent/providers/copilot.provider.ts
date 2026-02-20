import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { EventEmitter } from "events";
import { currencyConversionTool, servicePricingLookupTool } from "../tools.js";
import { resolveSettings } from "../../lib/settings.js";
import type { AIProvider } from "./types.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

const DEFAULT_SYSTEM_PROMPT = `
  <background>
    You are a pricing and quotation chatbot agent that has a direct communication channel with the user. You provide accurate and competitive pricing quotes based on user requests.
    You are an expert in software development services and understand how to price development work based on time, complexity, and scope.
    You are pricing work for Tom Shaw, a freelance software developer who charges for time spent writing code, attending planning or discovery calls, architecture and system design, documentation, and related technical work.
  </background>

  <goal>
    Provide accurate and competitive pricing quotes that ensure the developer is paid fairly for their time and expertise.
    If you do not have enough information, or need any details specified (for example, scope of work, estimated complexity, required technologies, timelines, or number of meetings), ask the user for more information before finalising the quote.
  </goal>

  <important guidelines>
    The first message a user sends you will typically be a direct brief from a client describing the work they want done.
    Use this information to formulate an initial quote or estimate.
    In subsequent messages, the user may ask for clarifications, adjustments to the quote, alternative pricing structures (e.g. hourly vs fixed), or comparisons to previous work and rates.
    
    You do not need to access any local files on the user's computer to complete your task.
    You should only use the tools provided to you to gather information needed to formulate a quote.
  </important guidelines>

  <tools>
    You have access to tools to:
    1. servicePricingLookupTool – Retrieve the developer’s standard rates and service pricing (e.g. hourly rate, day rate, discovery calls, maintenance work) from Notion in the form of plain text.
    2. currencyConversionTool – Convert amounts between different currencies using up-to-date exchange rates.

    CRITICAL: After using ANY tool, you MUST immediately send a response message to the user with the results.
    Never leave a tool call without providing a follow-up message explaining what the tool returned and how it was used in the quote.
  </tools>

  <output>
    Provide a clear and concise quote based on the user's request.
    The quote should be broken down into its component parts so the user can understand how the final amount was calculated (e.g. development time, planning calls, ongoing support).
    
    If the user asks for more information, provide relevant details about the developer’s previous work, typical engagement structures, or standard rates.

    The quote should be in GBP unless otherwise specified.
    If another currency is requested, calculate the pricing in GBP first, then convert it using the currency conversion tool.

    Your message should either:
    - Ask for more information (normal chat response), or
    - Provide a detailed quote breakdown, like so:

    ---
    Quote Breakdown:
    1. Discovery & Planning Calls (X hours): £X
    2. Software Development (Y hours): £Y
    3. Documentation / Handover: £Z
    ------------------------
    Total Quote: £TotalAmount
    ---

    Always ensure the quote is competitive and accurately reflects the developer’s time, expertise, and value.
  </output>`
;

export interface AgentMessageReceived {
  type: "assistant.message" | "tool.execution_start" | "tool.execution_complete" | "session.idle";
  content: string;
}

let client: CopilotClient | null = null;

async function getClient(): Promise<CopilotClient> {
  if (!client) {
    client = new CopilotClient();
    await client.start();
  }
  return client;
}

export async function checkAuth(): Promise<any> {
  const copilotClient = new CopilotClient({
    autoStart: true,
    autoRestart: false,
  });

  try {
    await copilotClient.start();
    const status = await copilotClient.getAuthStatus();
    await copilotClient.stop();
    return {
      isAuthenticated: status.isAuthenticated,
      login: status.login,
      authType: status.authType,
      statusMessage: status.statusMessage,
    };
  } catch {
    try {
      await copilotClient.forceStop();
    } catch {
      // Ignore cleanup errors
    }
    return { isAuthenticated: false };
  }
}

/**
 * GitHub Copilot implementation of the AIProvider interface
 */
export class CopilotProvider extends EventEmitter implements AIProvider {
  readonly id = "github-copilot";
  readonly name = "GitHub Copilot";
  
  private copilotClient: CopilotClient | null = null;
  private session: CopilotSession | null = null;
  private accumulatedContent: string = "";

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
    if (!this.copilotClient) {
      this.copilotClient = await getClient();
    }

    const authStatus = await this.copilotClient.getAuthStatus();
    if (!authStatus.isAuthenticated) {
      throw new Error(
        "Not authenticated with GitHub Copilot.\n\n" +
        "  Run 'copilot auth' in your terminal to log in."
      );
    }
  }

  async startSession(
    brief: string,
    options?: { skipInitialMessage?: boolean }
  ): Promise<void> {
    try {
      if (!this.copilotClient) await this.initialize();
      
      const { systemPrompt } = await resolveSettings();
      const promptToUse = systemPrompt?.trim() ? systemPrompt : DEFAULT_SYSTEM_PROMPT;
  
      this.session = await this.copilotClient!.createSession({
        sessionId: `quote-session-${Date.now()}`,
        model: "gpt-4o-mini",
        streaming: true,
        tools: [currencyConversionTool, servicePricingLookupTool],
        systemMessage: {
          mode: "append",
          content: promptToUse
        }
      });
  
      // Subscribe to session events and re-emit them
      this.session.on((data) => {
        try {
          if (DEBUG_MODE) {
            console.log(`[copilot] session event: ${data.type}`);
          }

          switch (data.type) {
            case "assistant.message":
              // Skip complete messages when streaming is enabled to avoid duplication
              if (DEBUG_MODE) {
                console.log(`[copilot] skipping assistant.message event (using streaming deltas instead)`);
              }
              break;

            case "assistant.message_delta":
              // Accumulate streaming content updates
              if ("deltaContent" in data.data && data.data.deltaContent) {
                this.accumulatedContent += data.data.deltaContent;
                if (DEBUG_MODE) {
                  console.log(`[copilot] accumulated content length: ${this.accumulatedContent.length}`);
                }
              }
              break;

            case "tool.execution_start":
              if (DEBUG_MODE) {
                console.log(`[copilot] tool execution started: ${data.data?.toolName || 'unknown'}`);
              }              
              break;

            case "tool.execution_complete":
              if (DEBUG_MODE) {
                console.log(`[copilot] tool execution completed successfully: ${data.data?.success}`);
              }
              break;

            case "session.idle":
              if (DEBUG_MODE) {
                console.log(`[copilot] session is now idle`);
              }
              
              // Emit the complete accumulated content when session is idle
              if (this.accumulatedContent.trim()) {
                if (DEBUG_MODE) {
                  console.log(`[copilot] emitting accumulated content (${this.accumulatedContent.length} chars)`);
                }
                this.emit("message", { 
                  type: "assistant.message", 
                  content: this.accumulatedContent 
                } as AgentMessageReceived);
                
                // Reset accumulated content for next interaction
                this.accumulatedContent = "";
              }
              break;

            case "session.error":
              if (DEBUG_MODE) {
                console.error(`[copilot] session error:`, data.data?.message || 'unknown error');
              }
              this.emit("error", new Error(data.data?.message || "Session error occurred"));
              break;

            default:
              if (DEBUG_MODE) {
                console.log(`[copilot] unhandled session event type: ${data.type}`);
              }
              break;
          }
        } catch (err) {
          if (DEBUG_MODE) {
            console.error("[copilot] error handling session event:", err);
          }
          this.emit("error", err as Error);
        }
      });
  
      // Optionally send the initial brief into the session
      if (!options?.skipInitialMessage) {
        await this.sendMessage(`Here is the brief for the quote:\n\n${brief}`);
      }
    } catch (error) {
      console.log("\n❌ Failed to start Copilot session. Please check your authentication and try again.\n");
      throw error;
    }
  }

  async sendMessage(message: string): Promise<void> {
    // Reset accumulated content for new interaction
    this.accumulatedContent = "";
    await this.session?.send({ prompt: message });
  }

  async endSession(): Promise<void> {
    if (this.session) {
      await this.session.destroy();
      this.emit("ended");
    }
  }
}

export async function listSessions() {
  const copilotClient = await getClient();
  const sessions = await copilotClient.listSessions();
  return sessions;
}