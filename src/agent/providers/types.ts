/**
 * Standard interface for all AI service providers (Copilot, OpenAI, etc.)
 */
export interface AIProvider {
  /** unique identifier for the provider */
  readonly id: string;
  
  /** name displayed in the CLI menu */
  readonly name: string;

  /**
   * Initializes the provider with necessary credentials/settings
   */
  initialize(): Promise<void>;

  /**
   * Sends a message to the AI and handles the response
   * @param message User input string
   */
  sendMessage(message: string): Promise<void>;

  /**
   * Cleans up resources or ends the current session
   */
  endSession(): Promise<void>;

  /**
   * Event emitter for streaming or final messages
   * @param callback Function to call with each new message content
   */
  onMessage(callback: (content: string) => void): void;
}