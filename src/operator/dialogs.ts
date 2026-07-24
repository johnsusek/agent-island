import terminalKit from "terminal-kit";

import type { Document, Element, Terminal } from "terminal-kit";

interface Choice {
  content: string;
  value: string;
}

interface DialogOptions {
  monochrome?: boolean;
}

interface FormResult {
  fields: Record<string, unknown>;
  submit: string;
}

export async function searchDialog(
  document: Document,
  terminal: Terminal,
  currentQuery: string,
  options: DialogOptions = {},
): Promise<string | null> {
  let result = await showSearchForm(document, terminal, currentQuery, options);
  if (!result || result.submit !== "ok") return null;
  return String(result.fields.query ?? "");
}

export async function helpDialog(
  document: Document,
  terminal: Terminal,
  options: DialogOptions = {},
): Promise<void> {
  await pick(
    document,
    terminal,
    "Keys",
    [
      { content: "↑/↓  Select agent", value: "select" },
      { content: "Tab  Move focus", value: "focus" },
      { content: "/  Find", value: "find" },
      { content: "f  Filter agents", value: "filter" },
      { content: "m  Activity / memory", value: "memory" },
      { content: "G  Follow latest activity", value: "tail" },
      { content: "r  Refresh", value: "refresh" },
      { content: "q  Quit", value: "quit" },
    ],
    options,
  );
}

async function pick(
  document: Document,
  terminal: Terminal,
  title: string,
  items: Choice[],
  options: DialogOptions,
): Promise<string | null> {
  let width = Math.min(56, Math.max(32, terminal.width - 8));
  let height = Math.min(items.length + 2, terminal.height - 4);
  let window = createWindow(document, terminal, title, width, height);
  let menu = new terminalKit.ColumnMenu({
    autoHeight: true,
    autoWidth: true,
    buttonBlurAttr: { bgColor: "black", color: "white" },
    buttonFocusAttr: dialogAttr(
      options,
      { bgColor: "blue", bold: true, color: "brightWhite" },
      { bgColor: "white", bold: true, color: "black" },
    ),
    focusLeftPadding: "› ",
    items,
    leftPadding: "  ",
    maxHeight: height - 2,
    parent: window,
    x: 0,
    y: 0,
  });
  document.giveFocusTo(menu);
  return new Promise((resolve) => {
    let finished = false;
    let finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      terminal.off("key", onKey);
      window.destroy(false, true);
      resolve(value);
    };
    let onKey = (key: string) => {
      if (key === "ESCAPE") finish(null);
    };
    terminal.on("key", onKey);
    menu.on("submit", (value: string) => finish(value));
  });
}

async function showSearchForm(
  document: Document,
  terminal: Terminal,
  currentQuery: string,
  options: DialogOptions,
): Promise<FormResult | null> {
  let width = Math.min(58, Math.max(36, terminal.width - 6));
  let window = createWindow(document, terminal, "Find", width, 6);
  let form = new terminalKit.Form({
    buttonBlurAttr: { bgColor: "brightBlack", color: "white" },
    buttonFocusAttr: dialogAttr(
      options,
      { bgColor: "blue", bold: true, color: "brightWhite" },
      { bgColor: "white", bold: true, color: "black" },
    ),
    buttons: [
      { content: "OK", value: "ok" },
      { content: "Cancel", value: "cancel" },
    ],
    inputs: [{ content: currentQuery, key: "query", label: "Find" }],
    labelBlurAttr: { color: "brightWhite" },
    labelFocusAttr: dialogAttr(
      options,
      { bold: true, color: "brightCyan" },
      { bold: true, color: "white" },
    ),
    parent: window,
    textAttr: { bgColor: "black", color: "white" },
    width: width - 4,
    x: 1,
    y: 1,
  });
  document.giveFocusTo(form);
  return new Promise((resolve) => {
    let finished = false;
    let finish = (value: FormResult | null) => {
      if (finished) return;
      finished = true;
      terminal.off("key", onKey);
      window.destroy(false, true);
      resolve(value);
    };
    let onKey = (key: string) => {
      if (key === "ESCAPE") finish(null);
    };
    terminal.on("key", onKey);
    form.on("submit", (value: FormResult) => finish(value));
  });
}

function createWindow(
  document: Document,
  terminal: Terminal,
  title: string,
  width: number,
  height: number,
): Element {
  return new terminalKit.Window({
    backgroundAttr: { bgColor: "black" },
    height,
    movable: true,
    parent: document,
    title,
    width,
    x: Math.max(0, Math.floor((terminal.width - width) / 2)),
    y: Math.max(1, Math.floor((terminal.height - height) / 2)),
    zIndex: 100,
  });
}

function dialogAttr(
  options: DialogOptions,
  colored: Record<string, unknown>,
  plain: Record<string, unknown>,
): Record<string, unknown> {
  return options.monochrome ? plain : colored;
}
