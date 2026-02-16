export function createSpinner(message: string) {
  const frames = ["|", "/", "-", "\\"];
  let i = 0;
  let timer: NodeJS.Timeout;

  const line = "\x1b[1m\x1b[34m " + message + "\x1b[0m";

  return {
    start(): void {
      timer = setInterval(() => {
        process.stdout.write(
          "\r" + frames[i++ % frames.length] + " " + line
        );
      }, 80);
    },

    stop(finalMessage: string): void {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K"); // clear line

      if (finalMessage) process.stdout.write(finalMessage + "\n");
    }
  }
}
