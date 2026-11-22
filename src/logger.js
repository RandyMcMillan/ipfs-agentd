/* ipfs-agentd — tiny leveled logger.
 *
 * One log function, filtered by level, sunk to stderr by default. Both the
 * daemon and the chat CLI use this; the level comes from --logging (or --quiet).
 */
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

export function createLogger (minLevel = 'info', sink) {
  const min = LEVELS[minLevel] ?? LEVELS.info
  const write = sink ?? ((msg, level) => {
    process.stderr.write(new Date().toISOString() + '  ' + level.toUpperCase() + '  ' + msg + '\n')
  })
  /* returns the single-fn signature createAgentNode expects: log(msg, level?) */
  return (msg, level = 'info') => {
    if ((LEVELS[level] ?? LEVELS.info) >= min) write(String(msg), level)
  }
}
