
import * as readline from "readline";
import { displayHeader } from "./ui/header.js";
import { checkAuth, QuotationChatbot } from "./agent/copilot.js";
import { displayMenu } from "./ui/menu.js";
import {
  appendQuoteSession,
  generateSessionId,
  listQuoteSessions,
  updateQuoteSession,
  type StoredMessage,
  type StoredQuote,
} from "./lib/storage.js";
import { loadSettings, updateSettings } from "./lib/settings.js";

const DEBUG_MODE = process.env.DEBUG_MODE === "true";
const MAX_HISTORY_MESSAGES = 20;

// Helper: collect multiple agent 'message' events until session goes idle
const collectAgentMessages = (
  agent: any,
  onMessage: (m: any, first: boolean) => void,
  maxWaitMs = 30000 // Maximum wait time
): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    if (DEBUG_MODE) {
      console.log(`[collector] starting collectAgentMessages (maxWaitMs=${maxWaitMs})`);
    }

    let first = true;
    let hasContent = false;
    let maxWaitTimer: NodeJS.Timeout | null = null;
    let accumulatedContent = "";

    let cleanup = () => {
      try {
        agent.removeListener("message", messageHandler);
        // Note: We don't remove the session event listener as it's managed by the agent
      } catch (e) {
        /* ignore */
      }
      if (maxWaitTimer) clearTimeout(maxWaitTimer);
    };

    const messageHandler = (m: any) => {
      if (DEBUG_MODE) {
        console.log("[collector] received agent message event");
      }

      // Handle streaming content (accumulate deltas)
      if (m.content) {
        // If this looks like a delta (short content), accumulate it
        if (m.content.length < 50 && !m.content.includes("\n")) {
          accumulatedContent += m.content;
          return; // Don't emit individual deltas
        } else {
          // This is a complete message or we have accumulated content
          if (accumulatedContent) {
            m.content = accumulatedContent + m.content;
            accumulatedContent = "";
          }

          onMessage(m, first);
          first = false;
          hasContent = true;
        }
      }
    };

    // Listen for session idle event through the agent's session
    const originalSession = agent.session;
    if (originalSession) {
      const sessionIdleHandler = (event: any) => {
        if (event.type === "session.idle") {
          if (DEBUG_MODE) {
            console.log("[collector] session idle detected, finishing collection");
          }

          // If we have accumulated content, emit it
          if (accumulatedContent) {
            onMessage({ content: accumulatedContent }, first);
          }

          cleanup();
          resolve();
        }
      };

      // Listen to the raw session events
      originalSession.on(sessionIdleHandler);

      // Clean up session listener too
      const originalCleanup = cleanup;
      cleanup = () => {
        originalCleanup();
        try {
          originalSession.off?.(sessionIdleHandler);
        } catch (e) {
          /* ignore */
        }
      };
    }

    // Safety timeout
    maxWaitTimer = setTimeout(() => {
      if (DEBUG_MODE) {
        console.warn(`[collector] max wait timeout (${maxWaitMs}ms) reached`);
      }

      // If we have accumulated content, emit it
      if (accumulatedContent) {
        onMessage({ content: accumulatedContent }, first);
      }

      cleanup();
      if (hasContent) {
        resolve(); // We got some content, so it's a success
      } else {
        reject(new Error("No response received within timeout"));
      }
    }, maxWaitMs);

    agent.on("message", messageHandler);
  });
};

// handler functions

function maskValue(value?: string): string {
  if (!value) return "not set";
  if (value.length <= 8) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseSettingsInput(input: string): string | null | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "clear") return null;
  return trimmed;
}

async function promptQuestion(mainRl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    mainRl.question(question, (answer) => resolve(answer));
  });
}

async function collectMultilineInput(
  mainRl: readline.Interface,
  sentinel = "."
): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const handler = (line: string) => {
      if (line.trim() === sentinel) {
        mainRl.removeListener("line", handler);
        resolve(lines.join("\n"));
        return;
      }
      lines.push(line);
    };
    mainRl.on("line", handler);
    mainRl.setPrompt("> ");
    mainRl.prompt();
  });
}

async function settingsFlow(mainRl: readline.Interface): Promise<void> {
  const mainLineListeners = mainRl.listeners("line").slice();
  mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));

  try {
    const settings = await loadSettings();
    console.log("\n🔧 Settings\n");
    console.log(`Current NOTION_API_KEY: ${maskValue(settings.notionApiKey)}`);
    console.log(`Current NOTION_PAGE_ID: ${maskValue(settings.notionPageId)}`);
    console.log(`Current EXCHANGE_RATE_API_KEY: ${maskValue(settings.exchangeRateApiKey)}`);
    console.log("\nEnter a value to update, press Enter to keep, or type 'clear' to remove.\n");

    mainRl.resume();
    const notionApiKeyInput = await promptQuestion(mainRl, "NOTION_API_KEY: ");
    const notionPageIdInput = await promptQuestion(mainRl, "NOTION_PAGE_ID: ");
    const exchangeRateApiKeyInput = await promptQuestion(mainRl, "EXCHANGE_RATE_API_KEY: ");

    const notionApiKey = parseSettingsInput(notionApiKeyInput);
    const notionPageId = parseSettingsInput(notionPageIdInput);
    const exchangeRateApiKey = parseSettingsInput(exchangeRateApiKeyInput);

    let newSettings = {};

    if (notionApiKey !== undefined) {
      newSettings = { ...newSettings, notionApiKey: notionApiKey };
    }
    if (notionPageId !== undefined) {
      newSettings = { ...newSettings, notionPageId: notionPageId };
    }
    if (exchangeRateApiKey !== undefined) {
      newSettings = { ...newSettings, exchangeRateApiKey: exchangeRateApiKey };
    }

    await updateSettings(newSettings);

    const status = (input: string | null | undefined) =>
      input === undefined ? "unchanged" : input === null ? "cleared" : "updated";

    console.log("\n✅ Settings saved.");
    console.log(`NOTION_API_KEY: ${status(notionApiKey)}`);
    console.log(`NOTION_PAGE_ID: ${status(notionPageId)}`);
    console.log(`EXCHANGE_RATE_API_KEY: ${status(exchangeRateApiKey)}\n`);
  } catch (error) {
    console.log("\n❌ Failed to update settings.\n");
    if (DEBUG_MODE) console.error(error);
  } finally {
    mainLineListeners.forEach((l) => mainRl.on("line", l as any));
    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
  }
}

async function promptFlow(mainRl: readline.Interface): Promise<void> {
  const mainLineListeners = mainRl.listeners("line").slice();
  mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));

  try {
    const settings = await loadSettings();
    const currentPrompt = settings.systemPrompt;

    console.log("\n📝 System Prompt\n");
    if (currentPrompt && currentPrompt.trim()) {
      console.log("Current system prompt (preview):");
      const preview = currentPrompt.length > 300 ? `${currentPrompt.slice(0, 300)}...` : currentPrompt;
      console.log(`${preview}\n`);
    } else {
      console.log("No custom system prompt is set.\n");
    }

    console.log("Paste the new system prompt below.");
    console.log("Finish by entering a single line with a dot (.)");
    console.log("Type 'clear' to remove the custom prompt.\n");

    mainRl.resume();
    const firstLine = await promptQuestion(mainRl, "> ");
    const trimmed = firstLine.trim();

    if (trimmed.toLowerCase() === "clear") {
      await updateSettings({ systemPrompt: "" });
      console.log("\n✅ System prompt cleared.\n");
    } else {
      let promptText = firstLine;
      if (trimmed !== ".") {
        const rest = await collectMultilineInput(mainRl);
        promptText = [firstLine, rest].filter(Boolean).join("\n");
      } else {
        promptText = "";
      }

      if (!promptText.trim()) {
        console.log("\n⚠️ Empty prompt detected. No changes made.\n");
      } else {
        await updateSettings({ systemPrompt: promptText });
        console.log("\n✅ System prompt updated.\n");
      }
    }
  } catch (error) {
    console.log("\n❌ Failed to update system prompt.\n");
    if (DEBUG_MODE) console.error(error);
  } finally {
    mainLineListeners.forEach((l) => mainRl.on("line", l as any));
    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
  }
}

async function handleCommand(input: string, mainRl: readline.Interface) {
  if (input.startsWith("/create ")) {
    const brief = input.substring(8).trim();
    createQuoteFlow(brief, mainRl).then(() => false).then(() => {
      mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
      mainRl.prompt();
    });
    return false;
  } else {
    console.log("\n❌ Unknown command. Type /help to see available commands.\n");
    mainRl.prompt();
    return false;
  }
}

async function createQuoteFlow(brief: string, mainRl: readline.Interface): Promise<void> {
  try {
      if (!brief || brief.trim() === "") {
        console.log("❌ Please provide a brief for your quote. Usage: /create <brief>\n");
        return;
      }

      console.log("\n🤖 Starting Quote Assistant...\n");
      console.log("━".repeat(50));
      console.log("💼 Quote Brief:", brief.trim());
      console.log("━".repeat(50));
      console.log("\nType your messages to discuss the quote.");
      console.log("Commands: /close - exit the chat session\n");

      // Remove main `line` listeners to avoid duplicate handling
      const mainLineListeners = mainRl.listeners("line").slice();
      mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));
      mainRl.pause();

      // init the chatbot session here

      const agent = new QuotationChatbot(brief.trim());
      const sessionId = generateSessionId();
      const sessionCreatedAt = new Date().toISOString();
      const storedMessages: StoredMessage[] = [];
      let finalSummary: string | undefined;

      const recordUserMessage = (content: string) => {
        storedMessages.push({
          role: "user",
          content,
          timestamp: new Date().toISOString(),
        });
      };

      const recordAssistantMessage = (content: string) => {
        storedMessages.push({
          role: "assistant",
          content,
          timestamp: new Date().toISOString(),
        });
      };

      await agent.startSession(brief.trim());

      // Show inline loading indicator and collect any messages the agent emits
      process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
      await collectAgentMessages(agent, (msg: any, first: boolean) => {
        // Clear loading only when the first partial/complete message arrives
        if (first) process.stdout.write("\r\x1b[2K");
        console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m ${msg.content}\n`);
        if (msg.content) {
          recordAssistantMessage(msg.content);
        }
      });

      // Switch the main prompt to the quote sub-prompt and resume input
      // Bold bright-blue `You` label; reset color so typed text stays default
      mainRl.setPrompt("\x1b[1m\x1b[94m💻 You:\x1b[0m ");
      mainRl.resume();
      mainRl.prompt();
      
      // Remain in the chat session until user types /close

      try {
        await new Promise<void>((resolve) => {
          const quoteHandler = async (line: string) => {
            const input = line.trim();

            if (input === "/close") {
              console.log("\n✅ Quote session complete! Saving...\n");
              // Ask for final summary and wait for reply
              // Show loading, then clear it when summary arrives
              // Show inline loading and request a final summary, then collect messages
              process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
              await agent.sendMessage(
                "Please provide a final summary of the quote we discussed, formatted nicely."
              );
              await collectAgentMessages(agent, (msg: any, first: boolean) => {
                if (first) process.stdout.write("\r\x1b[2K");
                if (msg.content !== "") {
                  console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m\n\n📋 Final Quote Summary:\n${msg.content}\n`);
                  recordAssistantMessage(msg.content);
                  finalSummary = msg.content;
                }
              });
              await agent.endSession();
              try {
                const sessionRecord: StoredQuote = {
                  id: sessionId,
                  brief: brief.trim(),
                  createdAt: sessionCreatedAt,
                  messages: storedMessages,
                  ...(finalSummary ? { finalSummary } : {}),
                };
                await appendQuoteSession(sessionRecord);
                console.log("💾 Session saved to history.\n");
              } catch (error) {
                console.log("\n⚠️ Failed to save session history.\n");
                if (DEBUG_MODE) console.error(error);
              }
              mainRl.removeListener("line", quoteHandler);
              resolve();
              return;
            }

            if (input === "") {
              mainRl.prompt();
              return;
            }

            // Pause input while waiting for the agent to respond
            mainRl.pause();
            try {
              // Show inline loading, send the user's message, then collect replies
              process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
              recordUserMessage(input);
              await agent.sendMessage(input);
              await collectAgentMessages(agent, (msg: any, first: boolean) => {
                if (first) process.stdout.write("\r\x1b[2K");
                if (msg.content !== "") {
                  console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m ${msg.content}\n`);
                  recordAssistantMessage(msg.content);
                }
              });
            } catch (error) {
              console.log("\n❌ Error communicating with agent. Please try again.\n");
            } finally {
              mainRl.resume();
            }

            mainRl.prompt();
          };

          mainRl.on("line", quoteHandler);
        });
          } catch (error) {
        console.log("\n❌ Error during quote chat session. Exiting session.\n");
        console.error(error);
      }

      // Restore main listeners and prompt after session ends
      mainLineListeners.forEach((l) => mainRl.on("line", l as any));
      mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
      mainRl.prompt();


  } catch (error) {
    console.log("\n❌ Failed to start quote session. Please check your connection.\n");
    console.error(error);
  }
}

function formatHistoryForAgent(messages: StoredMessage[], maxMessages: number): string {
  const slice = messages.slice(-maxMessages);
  return slice
    .map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      return `${label}: ${message.content}`;
    })
    .join("\n");
}

function printTranscriptPreview(messages: StoredMessage[], maxMessages: number): void {
  if (!messages.length) {
    console.log("\n(No previous messages)\n");
    return;
  }
  const total = messages.length;
  const slice = messages.slice(-maxMessages);
  if (total > maxMessages) {
    console.log(`\nShowing last ${maxMessages} of ${total} messages:\n`);
  } else {
    console.log("\nPrevious messages:\n");
  }
  slice.forEach((message) => {
    const label = message.role === "user" ? "You" : "Agent";
    console.log(`${label}: ${message.content}`);
  });
  console.log("");
}

async function openQuoteFlow(session: StoredQuote, mainRl: readline.Interface): Promise<void> {
  try {
    console.log("\n🔓 Opening saved quote session...\n");
    console.log("━".repeat(50));
    console.log("💼 Quote Brief:", session.brief);
    console.log("━".repeat(50));
    printTranscriptPreview(session.messages, MAX_HISTORY_MESSAGES);
    console.log("Type your messages to continue this quote conversation.");
    console.log("Commands: /close - exit the chat session\n");

    const mainLineListeners = mainRl.listeners("line").slice();
    mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));
    mainRl.pause();

    const agent = new QuotationChatbot(session.brief);
    const storedMessages: StoredMessage[] = [...session.messages];
    let finalSummary: string | undefined = session.finalSummary;

    const recordUserMessage = (content: string) => {
      storedMessages.push({
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      });
    };

    const recordAssistantMessage = (content: string) => {
      storedMessages.push({
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
      });
    };

    const historyContext = formatHistoryForAgent(storedMessages, MAX_HISTORY_MESSAGES);
    let firstUserMessage = true;

    await agent.startSession(session.brief, { skipInitialMessage: true });

    mainRl.setPrompt("\x1b[1m\x1b[94m💻 You:\x1b[0m ");
    mainRl.resume();
    mainRl.prompt();

    await new Promise<void>((resolve) => {
      const quoteHandler = async (line: string) => {
        const input = line.trim();

        if (input === "/close") {
          console.log("\n✅ Quote session complete! Saving...\n");
          process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
          await agent.sendMessage(
            "Please provide a final summary of the quote we discussed, formatted nicely."
          );
          await collectAgentMessages(agent, (msg: any, first: boolean) => {
            if (first) process.stdout.write("\r\x1b[2K");
            if (msg.content !== "") {
              console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m\n\n📋 Final Quote Summary:\n${msg.content}\n`);
              recordAssistantMessage(msg.content);
              finalSummary = msg.content;
            }
          });
          await agent.endSession();
          try {
            const sessionRecord: StoredQuote = {
              id: session.id,
              brief: session.brief,
              createdAt: session.createdAt,
              messages: storedMessages,
              ...(finalSummary ? { finalSummary } : {}),
            };
            await updateQuoteSession(sessionRecord);
            console.log("💾 Session updated in history.\n");
          } catch (error) {
            console.log("\n⚠️ Failed to update session history.\n");
            if (DEBUG_MODE) console.error(error);
          }
          mainRl.removeListener("line", quoteHandler);
          resolve();
          return;
        }

        if (input === "") {
          mainRl.prompt();
          return;
        }

        mainRl.pause();
        try {
          process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
          recordUserMessage(input);
          if (firstUserMessage) {
            const contextualPrompt = historyContext
              ? `Here is the brief for the quote:\n\n${session.brief}\n\nPrevious conversation (most recent messages):\n${historyContext}\n\nUser: ${input}`
              : `Here is the brief for the quote:\n\n${session.brief}\n\nUser: ${input}`;
            await agent.sendMessage(contextualPrompt);
            firstUserMessage = false;
          } else {
            await agent.sendMessage(input);
          }
          await collectAgentMessages(agent, (msg: any, first: boolean) => {
            if (first) process.stdout.write("\r\x1b[2K");
            if (msg.content !== "") {
              console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m ${msg.content}\n`);
              recordAssistantMessage(msg.content);
            }
          });
        } catch (error) {
          console.log("\n❌ Error communicating with agent. Please try again.\n");
        } finally {
          mainRl.resume();
        }

        mainRl.prompt();
      };

      mainRl.on("line", quoteHandler);
    });

    mainLineListeners.forEach((l) => mainRl.on("line", l as any));
    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
  } catch (error) {
    console.log("\n❌ Failed to open quote session.\n");
    if (DEBUG_MODE) console.error(error);
  }
}

async function listQuotesFlow(mainRl: readline.Interface): Promise<void> {
  try {
    const sessions = await listQuoteSessions();
    if (!sessions.length) {
      console.log("\nℹ️ No saved quote sessions yet.\n");
      return;
    }

    const renderPlainList = () => {
      console.log("\n📚 Saved Quote Sessions:\n");
      sessions.forEach((session, index) => {
        const createdAt = new Date(session.createdAt).toLocaleString();
        const brief = session.brief.length > 60
          ? `${session.brief.slice(0, 57)}...`
          : session.brief;
        const messageCount = session.messages.length;
        console.log(`${index + 1}. ${createdAt} - ${brief} (${messageCount} messages)`);
      });
      console.log("");
    };

    const mainLineListeners = mainRl.listeners("line").slice();
    mainLineListeners.forEach((l) => mainRl.removeListener("line", l as any));

    const wasRaw = process.stdin.isRaw;
    mainRl.pause();
    readline.emitKeypressEvents(process.stdin);

    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      renderPlainList();
      mainLineListeners.forEach((l) => mainRl.on("line", l as any));
      mainRl.resume();
      return;
    }

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      renderPlainList();
      mainLineListeners.forEach((l) => mainRl.on("line", l as any));
      mainRl.resume();
      return;
    }

    let selected = 0;

    const render = () => {
      process.stdout.write("\x1b[2J\x1b[0f");
      console.log("📚 Use Up/Down to navigate — Enter: open, q: cancel\n");
      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        if (!session) continue;
        const createdAt = new Date(session.createdAt).toLocaleString();
        const brief = session.brief.length > 60
          ? `${session.brief.slice(0, 57)}...`
          : session.brief;
        const messageCount = session.messages.length;
        const isSelected = i === selected;
        const prefix = isSelected ? "\x1b[1m\x1b[92m→\x1b[0m " : "  ";
        const line = `${createdAt} - ${brief} (${messageCount} messages)`;
        if (isSelected) {
          console.log(`${prefix}\x1b[1m\x1b[36m${line}\x1b[0m`);
        } else {
          console.log(`${prefix}${line}`);
        }
      }
    };

    await new Promise<void>((resolve) => {
      const onKey = async (str: string, key: readline.Key) => {
        if (key.name === "up") {
          selected = (selected - 1 + sessions.length) % sessions.length;
          render();
        } else if (key.name === "down") {
          selected = (selected + 1) % sessions.length;
          render();
        } else if (key.name === "return" || key.name === "enter") {
          const session = sessions[selected];
          if (!session) return;
          cleanup();
          await openQuoteFlow(session, mainRl);
          resolve();
        } else if (str === "q" || (key.ctrl && key.name === "c") || key.name === "escape") {
          cleanup();
          console.log("\nCancelled.\n");
          resolve();
        }
      };

      const cleanup = () => {
        process.stdin.removeListener("keypress", onKey);
        try {
          process.stdin.setRawMode(!!wasRaw);
        } catch {
          // ignore
        }
        mainLineListeners.forEach((l) => mainRl.on("line", l as any));
        mainRl.resume();
      };

      process.stdin.on("keypress", onKey);
      render();
    });
  } catch (error) {
    console.log("\n❌ Failed to load saved quotes.\n");
    if (DEBUG_MODE) console.error(error);
  }
}

// Run the main CLI application

async function runCli() {
  try {

    displayHeader();

    // Check that the user has access to Copilot and is logged in

    // Show "checking auth message with spinner"
    process.stdout.write("\x1b[1m\x1b[34m🔒 Checking Copilot authentication...\x1b[0m");
    
    const authStatus = await checkAuth();

    // Clear the checking auth line
    process.stdout.write("\x1b[1A\x1b[2K");
    
    if (!authStatus.isAuthenticated) {
      console.log("\n❌ You are not authenticated with GitHub Copilot. Please log in and try again.\n");
      return;
    }

    console.log(`\n\x1b[1;94m✅ Logged in as ${authStatus.login}! You can now use the Quote CLI.\x1b[0m\n`);


    // Show Menu

    displayMenu();

    // Set up readline interface for user input
    
    const mainRl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Store original main listeners to restore later
    const mainLineListeners = mainRl.listeners("line").slice();

    mainRl.setPrompt("\x1b[1m\x1b[94m👀 Select function:\x1b[0m ");
    mainRl.prompt();
    
    // Main command loop
    mainRl.on("line", async (input: string) => {
      const trimmedInput = input.trim();
      switch (trimmedInput) {
        case "/help":
          displayMenu();
          mainRl.prompt()
          break;
        case "/exit":
        case "/quit":
          console.log("\n👋 Exiting Quote CLI. Goodbye!\n")
          process.exit(0)
        case "/list":
          await listQuotesFlow(mainRl);
          mainRl.prompt()
          break;
        case "/settings":
          await settingsFlow(mainRl);
          break;
        case "/prompt":
          await promptFlow(mainRl);
          break;
        case "/create":
          console.log("\n❌ Usage: /create <brief>\n");
          console.log("Example: /create Website redesign for small business\n");
          mainRl.prompt()
          break;
        default:
          await handleCommand(trimmedInput, mainRl)
      }
    });

  }
  catch (error) {
    console.log("\n❌ An unexpected error occurred. Please try again.\n");
    console.error(error);
  }
}

runCli();
