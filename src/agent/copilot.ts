import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { EventEmitter } from "events";
import { currencyConversionTool, servicePricingLookupTool } from "./tools.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

const SYSTEM_PROMPT = `
  <background>
  You are a pricing and quotation chatbot agent that has a direct communication channel with the user. You provide accurate and competitive pricing quotes based on user requests. You are an expert in the influencer marketing industry so you know how to price campaigns effectively.
  You are pricing campaigns for Tom Shaw, a programming and tech content creator with a focus on software development, AI, and technology trends.
  </background>
  <goal>
  Provide accurate and competitive pricing quotes that are beneficial for the influencer to ensure that they are paid a fair rate for their services. If you do not have enough information, or need any details specified (for example, the type of content, duration, on or off site production, etc), ask the user for more information.
  </goal>
  <important guidelines>
  The first message a user sends you will be a direct brief from a client containing details of the campaign and the deliverables they want. Use this information to formulate your quote. In subsequent messages, the user may ask for clarifications, adjustments to the quote, or additional information about previous deals and pricing.
  You will not need to access any of the local files on the user's computer to complete your task. You should only use the tools provided to you to gather information needed to formulate a quote. 
  </important guidelines>
  <tools>
  You have access to tools to:
  1. servicePricingLookupTool - Retreive the service pricing list for the influencer from Notion in the form of plain text.
  2. currencyConversionTool - Convert amounts between different currencies using up-to-date exchange rates.
  
  CRITICAL: After using ANY tool, you MUST immediately send a response message to the user with the results. Never leave a tool call without providing a follow-up message to the user explaining what the tool returned and how it helps answer their question.
  </tools>
  <output>
  Provide a clear and concise quote based on the user's request. The quote should be broken down into its component parts so that the user can understand how you have reached the final amount. If the user asks for more information, provide relevant details about the influencer's previous deals and pricing. The quote should be in the GBP currency format unless otherwise specified. If so, you should convert the quote to the specified currency. If you do swap currencies, make sure you do the pricing in GBP first, then convert to the specified currency using the exchange rate API. Your message should either be structured in the form of a normal chat response (if you are asking for more information), or in the form of a detailed quote breakdown, like so:
  ---
  Quote Breakdown:
  1. Service A: £X
  2. Service B: £Y
  3. Additional Costs: £Z
  ------------------------
  Total Quote: £TotalAmount
  
  Always ensure that the quote is competitive and reflects the influencer's value.
  </output>`
;

let client: CopilotClient | null = null;

async function getClient(): Promise<CopilotClient> {
  if (!client) {
    client = new CopilotClient();
    await client.start();
  }
  return client;
}

export interface SessionEvents {
  message: (data: AgentMessageReceived) => void;
  thinking: () => void;
  error: (error: Error) => void;
  ended: () => void;
}

export interface AgentMessageReceived {
  type: "assistant.message" | "tool.execution_start" | "tool.execution_complete" | "session.idle";
  content: string;
}

export interface AuthStatus {
  isAuthenticated: boolean;
  login?: string | undefined;
  authType?: "user" | "env" | "gh-cli" | "hmac" | "api-key" | "token" | undefined;
  statusMessage?: string | undefined;
}

export async function checkAuth(): Promise<AuthStatus> {
  const client = new CopilotClient({
    autoStart: true,
    autoRestart: false,
  });

  try {
    await client.start();
    const status = await client.getAuthStatus();
    await client.stop();
    return {
      isAuthenticated: status.isAuthenticated,
      login: status.login,
      authType: status.authType,
      statusMessage: status.statusMessage,
    };
  } catch {
    try {
      await client.forceStop();
    } catch {
      // Ignore cleanup errors
    }
    return { isAuthenticated: false };
  }
}

export class QuotationChatbot extends EventEmitter {
  private client: CopilotClient | null = null;
  private session: CopilotSession | null = null;
  private accumulatedContent: string = "";

  constructor(brief: string) {
    super();
  }

  on<K extends keyof SessionEvents>(event: K, listener: SessionEvents[K]): this {
    return super.on(event, listener);
  }

  emit<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  async init() {
    this.client = await getClient();
    // Check authentication status before creating session
    const authStatus = await this.client.getAuthStatus();
    if (!authStatus.isAuthenticated) {
      throw new Error(
        "Not authenticated with GitHub Copilot.\n\n" +
        "  Run 'copilot auth' in your terminal to log in."
      );
    }
  }

  async startSession(brief: string): Promise<CopilotSession> {
    try {
      await this.init();
  
      const copilot = this.client;
  
      if (!copilot) {
        throw new Error("Copilot client not initialized. Call init() first.");
      }

      // Create session with quote brief context
  
      this.session = await copilot.createSession({
        sessionId: `quote-session-${Date.now()}`,
        model: "gpt-4o-mini",
        streaming: true,
        tools: [currencyConversionTool, servicePricingLookupTool],
        systemMessage: {
          "mode": "append",
          "content": SYSTEM_PROMPT
        }
      });
      if (DEBUG_MODE) {
        console.log("[copilot] session created");
      }

      // Add the brief as the first user message

      await this.sendMessage(`Here is the brief for the quote:\n\n${brief}`);
  
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
  
      return this.session;
    }
    catch (error) {
      console.log("\n❌ Failed to start Copilot session. Please check your authentication and try again.\n");
      throw error;
    }

  }

  async sendMessage(message: string) {
    // Reset accumulated content for new interaction
    this.accumulatedContent = "";
    await this.session?.send({ prompt: message });
  }

  async endSession() {
    if (this.session) {
      await this.session.destroy();
      this.emit("ended");
    }
  }
}

export async function listSessions() {
  const copilot = await getClient();
  const sessions = await copilot.listSessions();
  return sessions;
}