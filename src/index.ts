
import * as readline from "readline";
import { displayHeader } from "./ui/header.js";
import { checkAuth, QuotationChatbot } from "./agent/copilot.js";
import { displayMenu } from "./ui/menu.js";

import dotenv from "dotenv";

dotenv.config();

const DEBUG_MODE = process.env.DEBUG_MODE === "true";

// handler functions

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

      await agent.startSession(brief.trim());

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
              if (m.content.length < 50 && !m.content.includes('\n')) {
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

      // Show inline loading indicator and collect any messages the agent emits
      process.stdout.write("\x1b[1m\x1b[35m🤖 Agent is responding...\x1b[0m");
      await collectAgentMessages(agent, (msg: any, first: boolean) => {
        // Clear loading only when the first partial/complete message arrives
        if (first) process.stdout.write("\r\x1b[2K");
        console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m ${msg.content}\n`);
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
                }
              });
              await agent.endSession();
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
              await agent.sendMessage(input);
              await collectAgentMessages(agent, (msg: any, first: boolean) => {
                if (first) process.stdout.write("\r\x1b[2K");
                if (msg.content !== "") {
                  console.log(`\n\x1b[1m\x1b[35m🤖 Agent:\x1b[0m ${msg.content}\n`);
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

async function listQuotesFlow(): Promise<void> {
  // This flow is going to allow the user to scroll through saved quotes using the up and down arrow keys.
  // When they select a quote, they will have the option to open or delete it.
  
  
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
          console.log("\n📚 Listing all saved quotes...\n")
          // TODO: implement listQuotes()
          mainRl.prompt()
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