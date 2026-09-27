/** The block bring-back puts in the main editor for one question and its answer. */
export function formatBtwBringToMain(question: string, answer: string): string {
  return [
    "The following context was brought back from a /btw side discussion.",
    "Treat it as discussion context, not as work already completed.",
    "",
    "<btw_context>",
    `User:\n${escapeBringToMainText(question)}\n\nAssistant:\n${escapeBringToMainText(answer)}`,
    "</btw_context>",
  ].join("\n");
}

/** Append to an existing draft; never replace it. */
export function appendToDraft(draft: string, block: string): string {
  return draft.trim() ? `${draft}\n\n${block}` : block;
}

function escapeBringToMainText(text: string): string {
  return [...text]
    .map((character) => {
      if (character === "\n") return character;
      if (character === "\t") return "    ";
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) {
        return `\\x${code.toString(16).padStart(2, "0")}`;
      }
      return character;
    })
    .join("")
    .replace(/<btw_context(?=[ \t\r\n>])/g, "&lt;btw_context")
    .replace(/<\/btw_context[ \t\r\n]*>/g, (terminator) => terminator.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
}
