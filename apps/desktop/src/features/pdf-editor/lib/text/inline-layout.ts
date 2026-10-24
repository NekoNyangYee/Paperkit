// Visual PDF line breaks are not necessarily paragraph breaks. Keep their
// original separator when collecting edits; user-inserted breaks remain newlines.
export function readInlineText(element: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement)) return "";
    if (node.tagName === "BR") return node.dataset.pdfSeparator ?? "\n";
    let text = "";
    for (const child of node.childNodes) {
      if (
        child instanceof HTMLElement &&
        /^(DIV|P)$/.test(child.tagName) &&
        text &&
        !text.endsWith("\n")
      )
        text += "\n";
      text += read(child);
    }
    return text;
  };
  return read(element).replace(/\r\n?/g, "\n");
}
