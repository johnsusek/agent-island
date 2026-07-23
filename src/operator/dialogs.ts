import terminalKit from "terminal-kit";

import {
  defaultDirectorCadenceTicks,
  parseDirectorCadenceTicks,
  parseMaxTicks,
} from "./policy.js";
import type { AgentRole, Engine, LaunchForm, Seat } from "./types.js";
import type { Document, Element, Terminal } from "terminal-kit";

interface Choice {
  content: string;
  value: string;
}

interface DialogOptions {
  monochrome?: boolean;
}

interface FormInput {
  content?: string;
  items?: Choice[];
  key: string;
  label: string;
  type?: "select";
  value?: string;
}

interface FormResult {
  fields: Record<string, unknown>;
  submit: string;
}

interface Personas {
  characters: string[];
  directors: string[];
}

export async function launchWizard(
  document: Document,
  terminal: Terminal,
  personas: Personas,
  selectedSeat: Seat | null,
  options: DialogOptions = {},
): Promise<LaunchForm | null> {
  let role = (await pick(
    document,
    terminal,
    "Launch",
    [
      { content: "Director", value: "director" },
      { content: "Characters", value: "character" },
    ],
    selectedSeat?.role ?? "character",
    options,
  )) as AgentRole | null;
  if (!role) return null;

  let engine = (await pick(
    document,
    terminal,
    "Engine",
    [
      { content: "Claude", value: "claude" },
      { content: "Codex", value: "codex" },
    ],
    selectedSeat?.engine ?? "claude",
    options,
  )) as Engine | null;
  if (!engine) return null;

  let personaChoices = (
    role === "director" ? personas.directors : personas.characters
  ).map((persona) => ({ content: persona, value: persona }));
  let selectedPersona =
    selectedSeat?.role === role
      ? selectedSeat.persona
      : role === "director"
        ? "oracle"
        : "character-minimal";
  let defaultPersona =
    personaChoices.find((choice) => choice.value === selectedPersona)?.value ??
    personaChoices[0]?.value ??
    "";
  let persona = await pick(
    document,
    terminal,
    role === "director" ? "Director" : "Persona",
    personaChoices,
    defaultPersona,
    options,
  );
  if (!persona) return null;
  let fields = launchFields(role, engine, persona);
  let result = await showForm(
    document,
    terminal,
    "Launch",
    fields,
    58,
    undefined,
    options,
  );
  if (!result || result.submit !== "launch") return null;

  let values = result.fields;
  let chosenPersona = persona;
  let maxTicks = String(values.maxTicks ?? "2000");
  parseMaxTicks(maxTicks);
  let form: LaunchForm = {
    effort: String(values.effort ?? (role === "director" ? "medium" : "low")),
    engine,
    instructions: String(values.instructions ?? ""),
    maxTicks,
    model: String(
      values.model ??
        (engine === "claude"
          ? role === "director"
            ? "sonnet"
            : "haiku"
          : role === "director"
            ? "gpt-5.4"
            : "gpt-5.3-codex"),
    ),
    persona: chosenPersona,
    role,
  };
  if (role === "director") {
    let cadenceTicks = String(
      values.cadenceTicks ?? defaultDirectorCadenceTicks(chosenPersona),
    );
    parseDirectorCadenceTicks(cadenceTicks, chosenPersona);
    form.cadenceTicks = cadenceTicks;
    return form;
  }
  form.names = String(values.names ?? "");
  form.count = String(values.count ?? "1");
  form.ocean = values.ocean !== "off";
  return form;
}

export async function searchDialog(
  document: Document,
  terminal: Terminal,
  currentQuery: string,
  options: DialogOptions = {},
): Promise<string | null> {
  let result = await showForm(
    document,
    terminal,
    "Find agents and details",
    [{ content: currentQuery, key: "query", label: "Find" }],
    58,
    undefined,
    options,
  );
  if (!result || result.submit !== "ok") return null;
  return String(result.fields.query ?? "");
}

export async function confirmDialog(
  document: Document,
  terminal: Terminal,
  title: string,
  message: string,
  options: DialogOptions = {},
): Promise<boolean> {
  let result = await showForm(
    document,
    terminal,
    title,
    [{ content: message, key: "message", label: "" }],
    58,
    [
      { content: "Confirm", value: "confirm" },
      { content: "Cancel", value: "cancel" },
    ],
    options,
  );
  return result?.submit === "confirm";
}

export async function worldChoice(
  document: Document,
  terminal: Terminal,
  options: DialogOptions = {},
): Promise<string | null> {
  return pick(
    document,
    terminal,
    "World",
    [
      { content: "Pause / resume", value: "pause" },
      { content: "Set clock", value: "clock" },
      { content: "Activate scenario", value: "scenario" },
      { content: "Restore run", value: "restore" },
      { content: "Reset world", value: "reset" },
    ],
    null,
    options,
  );
}

export async function choiceDialog(
  document: Document,
  terminal: Terminal,
  title: string,
  choices: Choice[],
  selectedValue?: string | null,
  options: DialogOptions = {},
): Promise<string | null> {
  return pick(document, terminal, title, choices, selectedValue, options);
}

export async function valueDialog(
  document: Document,
  terminal: Terminal,
  title: string,
  label: string,
  value = "",
  options: DialogOptions = {},
): Promise<string | null> {
  let result = await showForm(
    document,
    terminal,
    title,
    [{ content: value, key: "value", label }],
    54,
    undefined,
    options,
  );
  if (!result || result.submit !== "ok") return null;
  return String(result.fields.value ?? "");
}

export async function dimensionsDialog(
  document: Document,
  terminal: Terminal,
  options: DialogOptions = {},
): Promise<{ height: string; width: string } | null> {
  let result = await showForm(
    document,
    terminal,
    "Reset world",
    [
      { content: "", key: "width", label: "Width" },
      { content: "", key: "height", label: "Height" },
    ],
    54,
    [
      { content: "Reset", value: "reset" },
      { content: "Cancel", value: "cancel" },
    ],
    options,
  );
  if (!result || result.submit !== "reset") return null;
  return {
    height: String(result.fields.height ?? ""),
    width: String(result.fields.width ?? ""),
  };
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
      { content: "l  Launch", value: "launch" },
      { content: "x / X  Stop selected / all", value: "stop" },
      { content: "/  Find", value: "find" },
      { content: "m  Activity / memory", value: "memory" },
      { content: "v  Raw / rendered activity", value: "raw" },
      { content: "G  Follow latest activity", value: "tail" },
      { content: "w  World operations", value: "world" },
      { content: "q  Quit", value: "quit" },
    ],
    null,
    options,
  );
}

async function pick(
  document: Document,
  terminal: Terminal,
  title: string,
  items: Choice[],
  selectedValue?: string | null,
  options: DialogOptions = {},
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
      { bgColor: "blue", color: "brightWhite", bold: true },
      { bgColor: "white", color: "black", bold: true },
    ),
    focusLeftPadding: "› ",
    items,
    leftPadding: "  ",
    maxHeight: height - 2,
    parent: window,
    x: 0,
    y: 0,
  });
  if (selectedValue) menu.focusValue(selectedValue, "select", true);
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

async function showForm(
  document: Document,
  terminal: Terminal,
  title: string,
  inputs: FormInput[],
  requestedWidth: number,
  buttons: Choice[] = [
    { content: "OK", value: "ok" },
    { content: "Cancel", value: "cancel" },
  ],
  options: DialogOptions = {},
): Promise<FormResult | null> {
  let width = Math.min(requestedWidth, Math.max(36, terminal.width - 6));
  let height = formWindowHeight(inputs.length, terminal.height);
  let window = createWindow(document, terminal, title, width, height);
  let form = new terminalKit.Form({
    buttonBlurAttr: { bgColor: "brightBlack", color: "white" },
    buttonFocusAttr: dialogAttr(
      options,
      { bgColor: "blue", color: "brightWhite", bold: true },
      { bgColor: "white", color: "black", bold: true },
    ),
    buttons,
    inputs,
    labelBlurAttr: { color: "brightWhite" },
    labelFocusAttr: dialogAttr(
      options,
      { color: "brightCyan", bold: true },
      { color: "white", bold: true },
    ),
    parent: window,
    textAttr: { bgColor: "black", color: "white" },
    turnedOnBlurAttr: dialogAttr(
      options,
      { bgColor: "cyan", color: "black" },
      { bgColor: "white", color: "black" },
    ),
    turnedOnFocusAttr: dialogAttr(
      options,
      { bgColor: "brightCyan", color: "black", bold: true },
      { bgColor: "white", color: "black", bold: true },
    ),
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

export function formWindowHeight(
  inputCount: number,
  terminalHeight: number,
): number {
  return Math.min(inputCount + 5, terminalHeight - 4);
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

function launchFields(
  role: AgentRole,
  engine: Engine,
  persona: string,
): FormInput[] {
  let fields: FormInput[] = [
    {
      items: effortChoices(),
      key: "effort",
      label: "Effort",
      type: "select",
      value: role === "director" ? "medium" : "low",
    },
    modelField(role, engine),
    { content: "2000", key: "maxTicks", label: "Max ticks" },
  ];
  if (role === "director") {
    fields.push({
      content: String(defaultDirectorCadenceTicks(persona)),
      key: "cadenceTicks",
      label: "Cadence",
    });
  } else {
    fields.push(
      { content: "", key: "names", label: "Names" },
      { content: "1", key: "count", label: "Seats" },
      {
        items: [
          { content: "On", value: "on" },
          { content: "Off", value: "off" },
        ],
        key: "ocean",
        label: "OCEAN",
        type: "select",
        value: "on",
      },
    );
  }
  fields.push({ content: "", key: "instructions", label: "Instructions" });
  return fields;
}

function modelField(role: AgentRole, engine: Engine): FormInput {
  if (engine === "codex")
    return {
      content: role === "director" ? "gpt-5.4" : "gpt-5.3-codex",
      key: "model",
      label: "Model",
    };
  return {
    items: ["fable", "opus", "sonnet", "haiku"].map((model) => ({
      content: model,
      value: model,
    })),
    key: "model",
    label: "Model",
    type: "select",
    value: role === "director" ? "sonnet" : "haiku",
  };
}

function effortChoices(): Choice[] {
  return ["low", "medium", "high", "xhigh"].map((effort) => ({
    content: effort,
    value: effort,
  }));
}

function dialogAttr(
  options: DialogOptions,
  colored: Record<string, unknown>,
  plain: Record<string, unknown>,
): Record<string, unknown> {
  return options.monochrome ? plain : colored;
}
