


const commands = [
  {
    command: "/list",
    description: "List all saved quotes",
  },
  {
    command: "/create <brief>",
    description: "Start AI-powered quote creation session by pasting in your brief from the client",
  },
  {
    command: "/settings",
    description: "Configure Notion and exchange rate API keys",
  },
  {
    command: "/prompt",
    description: "Update the system prompt used for quotes",
  },
  {
    command: "/help",
    description: "Show this help message",
  },
  {
    command: "/exit or /quit",
    description: "Exit the application",
  },
]

export function displayMenu(): void {
  console.log('\n📚 Quote CLI - Available Commands:\n')
  commands.forEach(cmd => {
    console.log(`  ${cmd.command.padEnd(16)} - ${cmd.description}`)
  });
  console.log('');
}

export function showHelp(): void {
  console.log("\n📚 Quote CLI - Available Commands:\n")
  commands.forEach(cmd => {
    console.log(`  ${cmd.command.padEnd(16)} - ${cmd.description}`)
  });
}
